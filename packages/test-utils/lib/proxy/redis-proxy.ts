import * as net from 'net';
import { EventEmitter } from 'events';
import type { RedisArgument } from '@redis/client/lib/RESP/types';
import { Decoder } from '@redis/client/lib/RESP/decoder';
import {
  RequestHeaderDecoder,
  RequestHeaderEncoder,
} from '@redis/client/lib/binary-headers/generated/request-header-codec';
import { ResponseHeaderEncoder } from '@redis/client/lib/binary-headers/generated/response-header-codec';
import {
  STATIC_COMMAND_RECORDS,
  createEligibilityResolver,
  type CommandRecord,
  type EligibilityResolver,
} from '@redis/client/lib/binary-headers/eligibility';
import RespFramer from './resp-framer';
import RespQueue from './resp-queue';

export interface DmcBinaryHeadersProxyConfig {
  readonly bindhrEnabled?: boolean;
  readonly supportedCommands?: ReadonlyArray<CommandRecord>;
  readonly enableLogging?: boolean;
  readonly validateEligibility?: boolean;
}

interface ProxyConfig {
  readonly listenPort: number;
  readonly listenHost?: string;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly timeout?: number;
  readonly enableLogging?: boolean;
  readonly dmcBinaryHeadersProxy?: DmcBinaryHeadersProxyConfig;
}

interface ConnectionInfoCommon {
  readonly id: string;
  readonly clientAddress: string;
  readonly clientPort: number;
  readonly connectedAt: Date;
}

export interface DmcBinaryHeadersProxyRequestRecord {
  readonly connectionId: string;
  readonly type: 'raw' | 'binary';
  readonly bindhrEnabled: boolean;
  readonly commands: readonly string[][];
  readonly commandNames: readonly string[];
  readonly commandCount: number;
  readonly slot?: number;
  readonly clientIdx?: number;
  readonly handledLocally?: boolean;
  readonly rejected?: boolean;
  readonly error?: string;
}

export interface DmcBinaryHeadersProxyConnectionInfo {
  readonly bindhrEnabled: boolean;
  readonly requests: readonly DmcBinaryHeadersProxyRequestRecord[];
}

export interface DmcBinaryHeadersProxyConnectionStats extends ConnectionInfoCommon, DmcBinaryHeadersProxyConnectionInfo {}

export interface DmcBinaryHeadersProxyStats {
  readonly connections: readonly DmcBinaryHeadersProxyConnectionStats[];
  readonly requests: readonly DmcBinaryHeadersProxyRequestRecord[];
}

interface ConnectionInfo extends ConnectionInfoCommon {
  readonly interceptors: InterceptorState[];
}

interface ActiveConnection extends ConnectionInfoCommon {
  readonly clientSocket: net.Socket;
  readonly serverSocket: net.Socket;
  interceptors: Interceptor[];
}

type SendResult =
  | { readonly success: true; readonly connectionId: string }
  | { readonly success: false; readonly error: string; readonly connectionId: string };

type DataDirection = 'client->server' | 'server->client';

interface ProxyStats {
  readonly activeConnections: number;
  readonly totalConnections: number;
  readonly connections: readonly ConnectionInfo[];
  readonly globalInterceptors: InterceptorState[];
}

type DmcBinaryHeadersRequestFrame =
  | { readonly type: 'raw'; readonly data: Buffer }
  | {
      readonly type: 'binary';
      readonly data: Buffer;
      readonly payload: Buffer;
      readonly header: {
        readonly commandCount: number;
        readonly length: number;
        readonly slot: number;
        readonly clientIdx: number;
      };
    };

interface ProxyEvents {
  /** Emitted when a new client connects */
  'connection': (connectionInfo: ConnectionInfo) => void;
  /** Emitted when a connection is closed */
  'disconnect': (connectionInfo: ConnectionInfo) => void;
  /** Emitted when data is transferred */
  'data': (connectionId: string, direction: DataDirection, data: Buffer) => void;
  /** Emitted when an error occurs */
  'error': (error: Error, connectionId?: string) => void;
  /** Emitted when the proxy server starts */
  'listening': (host: string, port: number) => void;
  /** Emitted when the proxy server stops */
  'close': () => void;
}

export type Next = (data: Buffer, expectedReplies?: number) => Promise<Buffer>;

export type InterceptorFunction = (data: Buffer, next: Next, state: InterceptorState) => Promise<Buffer>;

export interface InterceptorDescription {
  name: string;
  matchLimit?: number;
  fn: InterceptorFunction;
}

export interface InterceptorState {
  name: string;
  matchLimit?: number;
  invokeCount: number;
  matchCount: number;
}

interface Interceptor {
  name: string;
  state: InterceptorState;
  fn: InterceptorFunction;
}

type ResolvedProxyConfig = Omit<Required<ProxyConfig>, 'dmcBinaryHeadersProxy'> & {
  readonly dmcBinaryHeadersProxy?: DmcBinaryHeadersProxyConfig;
};

class DmcBinaryHeadersRequestFramer extends EventEmitter {
  readonly #respFramer = new RespFramer();
  readonly #headerDecoder = new RequestHeaderDecoder();
  #buffer = Buffer.alloc(0);
  #offset = 0;

  public write(data: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, data]);

    while (this.#offset < this.#buffer.length) {
      const frame = this.#readFrame(this.#offset);
      if (frame === null) {
        break;
      }

      this.emit('message', frame.frame);
      this.#offset = frame.end;
    }

    if (this.#offset > 0) {
      this.#buffer = this.#buffer.subarray(this.#offset);
      this.#offset = 0;
    }
  }

  #readFrame(start: number): { frame: DmcBinaryHeadersRequestFrame; end: number } | null {
    if (this.#buffer[start] !== RequestHeaderEncoder.designatorConstantValue()) {
      const messageEnd = this.#respFramer.findMessageEnd(this.#buffer, start);
      if (messageEnd === -1) {
        return null;
      }

      return {
        frame: {
          type: 'raw',
          data: this.#buffer.subarray(start, messageEnd),
        },
        end: messageEnd,
      };
    }

    if (this.#buffer.length - start < RequestHeaderDecoder.ENCODED_LENGTH) {
      return null;
    }

    this.#headerDecoder.wrap(this.#buffer, start);
    const length = this.#headerDecoder.length();
    const end = start + RequestHeaderDecoder.ENCODED_LENGTH + length;
    if (this.#buffer.length < end) {
      return null;
    }

    const payloadStart = start + RequestHeaderDecoder.ENCODED_LENGTH;
    return {
      frame: {
        type: 'binary',
        data: this.#buffer.subarray(start, end),
        payload: this.#buffer.subarray(payloadStart, end),
        header: {
          commandCount: this.#headerDecoder.commandCount(),
          length,
          slot: this.#headerDecoder.slot(),
          clientIdx: this.#headerDecoder.clientIdx(),
        },
      },
      end,
    };
  }
}

function toRedisArgument(value: unknown): RedisArgument {
  if (value instanceof Buffer) return value;
  return String(value);
}

function redisArgumentToString(value: RedisArgument | undefined): string {
  if (value === undefined) return '';
  return value instanceof Buffer ? value.toString('utf8') : value;
}

function parseRespCommandArrays(data: Buffer): ReadonlyArray<ReadonlyArray<RedisArgument>> {
  const replies: unknown[] = [];
  const decoder = new Decoder({
    onReply: (reply: unknown) => replies.push(reply),
    onErrorReply: (err: unknown) => {
      throw err;
    },
    onPush: (push: Array<unknown>) => replies.push(push),
    getTypeMapping: () => ({}),
  });

  decoder.write(data);

  return replies.map((reply) => {
    if (!Array.isArray(reply)) {
      throw new Error('Expected RESP array command');
    }

    return reply.map(toRedisArgument);
  });
}

function stringifyCommands(
  commands: ReadonlyArray<ReadonlyArray<RedisArgument>>,
): string[][] {
  return commands.map((command) => command.map(redisArgumentToString));
}

function commandNames(commands: ReadonlyArray<ReadonlyArray<RedisArgument>>): string[] {
  return commands.map((command) => redisArgumentToString(command[0]).toUpperCase());
}

export class RedisProxy extends EventEmitter {
  private readonly server: net.Server;
  public readonly config: ResolvedProxyConfig;
  private readonly connections: Map<string, ActiveConnection>;
  private isRunning: boolean;
  private globalInterceptors: Interceptor[] = [];
  private dmcBinaryHeadersEligibilityResolver?: EligibilityResolver;

  constructor(config: ProxyConfig) {
    super();

    const enableLogging = config.enableLogging ?? config.dmcBinaryHeadersProxy?.enableLogging ?? false;

    this.config = {
      listenHost: '127.0.0.1',
      timeout: 30000,
      ...config,
      enableLogging
    };

    this.connections = new Map();
    this.isRunning = false;
    this.server = this.createServer();
  }

  public async start(): Promise<void> {
    await this.initializeDmcBinaryHeadersProxy();

    return new Promise((resolve, reject) => {
      if (this.isRunning) {
        reject(new Error('Proxy is already running'));
        return;
      }

      this.server.listen(this.config.listenPort, this.config.listenHost, () => {
        this.isRunning = true;
        this.log(`Proxy listening on ${this.config.listenHost}:${this.config.listenPort}`);
        this.log(`Forwarding to Redis server at ${this.config.targetHost}:${this.config.targetPort}`);
        this.emit('listening', this.config.listenHost, this.config.listenPort);
        resolve();
      });

      this.server.on('error', (error) => {
        this.emit('error', error);
        reject(error);
      });
    });
  }

  private async initializeDmcBinaryHeadersProxy(): Promise<void> {
    if (this.config.dmcBinaryHeadersProxy === undefined || this.dmcBinaryHeadersEligibilityResolver !== undefined) {
      return;
    }

    const supportedCommands = this.config.dmcBinaryHeadersProxy.supportedCommands ?? STATIC_COMMAND_RECORDS;
    this.dmcBinaryHeadersEligibilityResolver = await createEligibilityResolver(async () => supportedCommands);
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.isRunning) {
        resolve();
        return;
      }

      Array.from(this.connections.keys()).forEach((connectionId) => {
        this.closeConnection(connectionId);
      });

      this.server.close(() => {
        this.isRunning = false;
        this.log('Proxy server stopped');
        this.emit('close');
        resolve();
      });
    });
  }

  private makeInterceptor(description: InterceptorDescription): Interceptor {
    const { name, fn, matchLimit } = description;
    return {
      name,
      fn,
      state: {
        name,
        matchCount: 0,
        invokeCount: 0,
        matchLimit,
      },
    };
  }

  public setGlobalInterceptors(
    interceptorDescriptions: Array<InterceptorDescription>,
  ) {
    const interceptors: Interceptor[] = interceptorDescriptions.map(this.makeInterceptor);
    this.globalInterceptors = interceptors;
  }

  public addGlobalInterceptor(
    interceptorDescription: InterceptorDescription,
  ) {
    const interceptor = this.makeInterceptor(interceptorDescription);
    this.globalInterceptors = [interceptor, ...this.globalInterceptors.filter(i => i.name !== interceptor.name)];
  }

  public getStats(): ProxyStats {
    const connections = Array.from(this.connections.values());

    return {
      activeConnections: connections.length,
      totalConnections: connections.length,
      globalInterceptors: this.globalInterceptors.map(i => i.state),
      connections: connections.map((conn) => ({
        id: conn.id,
        clientAddress: conn.clientAddress,
        clientPort: conn.clientPort,
        connectedAt: conn.connectedAt,
        interceptors: conn.interceptors.map(i => i.state),
        dmcBinaryHeadersProxy: conn.dmcBinaryHeadersProxy === undefined ? undefined : {
          bindhrEnabled: conn.dmcBinaryHeadersProxy.bindhrEnabled,
          requests: [...conn.dmcBinaryHeadersProxy.requests]
        }
      })),
    };
  }

  public getDmcBinaryHeadersProxyStats(): DmcBinaryHeadersProxyStats {
    const connections = Array.from(this.connections.values())
      .filter((connection) => connection.dmcBinaryHeadersProxy !== undefined)
      .map((connection) => ({
        id: connection.id,
        clientAddress: connection.clientAddress,
        clientPort: connection.clientPort,
        connectedAt: connection.connectedAt,
        bindhrEnabled: connection.dmcBinaryHeadersProxy!.bindhrEnabled,
        requests: [...connection.dmcBinaryHeadersProxy!.requests],
      }));

    return {
      connections,
      requests: connections.flatMap((connection) => connection.requests),
    };
  }

  public clearDmcBinaryHeadersProxyStats(): void {
    for (const connection of this.connections.values()) {
      connection.dmcBinaryHeadersProxy?.requests.splice(0);
    }
  }

  public closeConnection(connectionId: string): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return false;
    }

    connection.clientSocket.destroy();
    connection.serverSocket.destroy();
    this.connections.delete(connectionId);
    this.emit('disconnect', connection);
    return true;
  }

  public sendToClient(connectionId: string, data: Buffer): SendResult {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return {
        success: false,
        error: 'Connection not found',
        connectionId
      };
    }

    if (connection.clientSocket.destroyed || !connection.clientSocket.writable) {
      return {
        success: false,
        error: 'Client socket is not writable',
        connectionId
      };
    }

    try {
      connection.clientSocket.write(data);

      this.log(`Sent ${data.length} bytes to client ${connectionId}`);
      this.emit('data', connectionId, 'server->client', data);

      return {
        success: true,
        connectionId
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.log(`Failed to send data to client ${connectionId}: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
        connectionId
      };
    }
  }

  public sendToAllClients(data: Buffer): readonly SendResult[] {
    const connectionIds = Array.from(this.connections.keys());
    const results = connectionIds.map((connectionId) =>
      this.sendToClient(connectionId, data)
    );

    const successCount = results.filter((result) => result.success).length;
    const totalCount = results.length;

    this.log(`Sent ${data.length} bytes to ${successCount}/${totalCount} clients`);

    return results;
  }

  public sendToClients(connectionIds: readonly string[], data: Buffer): readonly SendResult[] {
    const results = connectionIds.map((connectionId) =>
      this.sendToClient(connectionId, data)
    );

    const successCount = results.filter((result) => result.success).length;
    const totalCount = results.length;

    this.log(`Sent ${data.length} bytes to ${successCount}/${totalCount} specified clients`);

    return results;
  }

  public getActiveConnectionIds(): readonly string[] {
    return Array.from(this.connections.keys());
  }

  private createServer(): net.Server {
    return net.createServer((clientSocket) => {
      this.handleClientConnection(clientSocket);
    });
  }

  private handleClientConnection(clientSocket: net.Socket): void {
    clientSocket.pause();
    const serverSocket = this.createTargetSocket();
    serverSocket.once('connect', clientSocket.resume.bind(clientSocket));

    const connectionInfo = this.createConnectionInfo(clientSocket, serverSocket);
    this.connections.set(connectionInfo.id, connectionInfo);
    this.log(`New connection ${connectionInfo.id} from ${connectionInfo.clientAddress}:${connectionInfo.clientPort}`);

    clientSocket.setTimeout(this.config.timeout);

    serverSocket.on('connect', () => {
      this.log(`Connected to Redis server for connection ${connectionInfo.id}`);
      this.emit('connection', connectionInfo);
    });

    const respQueue = new RespQueue(serverSocket);
    const forwardRawRequest = this.createRawRequestForwarder(connectionInfo, respQueue);

    this.attachClientRequestHandler(connectionInfo, respQueue, forwardRawRequest);
    this.attachPushHandler(connectionInfo, respQueue);
    this.attachSocketLifecycleHandlers(connectionInfo);
  }

  private createTargetSocket(): net.Socket {
    return net.createConnection({
      host: this.config.targetHost,
      port: this.config.targetPort
    });
  }

  private createConnectionInfo(
    clientSocket: net.Socket,
    serverSocket: net.Socket
  ): ActiveConnection {
    return {
      id: this.generateConnectionId(),
      clientAddress: clientSocket.remoteAddress || 'unknown',
      clientPort: clientSocket.remotePort || 0,
      connectedAt: new Date(),
      clientSocket,
      serverSocket,
      interceptors: [],
      dmcBinaryHeadersProxy: this.config.dmcBinaryHeadersProxy === undefined ? undefined : {
        bindhrEnabled: this.config.dmcBinaryHeadersProxy.bindhrEnabled ?? true,
        requests: [],
      },
    };
  }

  private createRawRequestForwarder(
    connection: ActiveConnection,
    respQueue: RespQueue
  ): Next {
    return async (data: Buffer): Promise<Buffer> => {
      const localDmcResponse = this.handleDmcBinaryHeadersRawRequest(connection, data);
      if (localDmcResponse !== null) {
        return localDmcResponse;
      }

      return this.createInterceptorChain(connection, respQueue)(data);
    };
  }

  private createInterceptorChain(
    connection: ActiveConnection,
    respQueue: RespQueue
  ): Next {
    const last = async (data: Buffer): Promise<Buffer> => {
      this.emit('data', connection.id, 'client->server', data);
      return respQueue.request(data);
    };

    return connection.interceptors.concat(this.globalInterceptors).reduceRight<Next>(
      (next, interceptor) => (data) =>
        interceptor.fn(data, next, interceptor.state),
      last,
    );
  }

  private attachClientRequestHandler(
    connection: ActiveConnection,
    respQueue: RespQueue,
    forwardRawRequest: Next
  ): void {
    if (connection.dmcBinaryHeadersProxy !== undefined) {
      this.attachDmcBinaryHeadersRequestHandler(connection, respQueue, forwardRawRequest);
      return;
    }

    this.attachRespRequestHandler(connection, forwardRawRequest);
  }

  private attachDmcBinaryHeadersRequestHandler(
    connection: ActiveConnection,
    respQueue: RespQueue,
    forwardRawRequest: Next
  ): void {
    const requestFramer = new DmcBinaryHeadersRequestFramer();
    let responseChain = Promise.resolve();

    requestFramer.on('message', (frame: DmcBinaryHeadersRequestFrame) => {
      responseChain = responseChain.then(async () => {
        const response = frame.type === 'binary'
          ? await this.handleDmcBinaryHeadersRequest(connection, frame, respQueue)
          : await forwardRawRequest(frame.data);
        this.writeResponseToClient(connection, response);
      }).catch((err) => {
        this.handleProxyError(connection, err);
      });
    });

    connection.clientSocket.on('data', data => requestFramer.write(data));
  }

  private attachRespRequestHandler(
    connection: ActiveConnection,
    forwardRawRequest: Next
  ): void {
    const clientRespFramer = new RespFramer();
    clientRespFramer.on('message', async (data) => {
      try {
        const response = await forwardRawRequest(data);
        this.writeResponseToClient(connection, response);
      } catch (err) {
        this.handleProxyError(connection, err);
      }
    });

    connection.clientSocket.on('data', data => clientRespFramer.write(data));
  }

  private attachPushHandler(
    connection: ActiveConnection,
    respQueue: RespQueue
  ): void {
    respQueue.on('push', (data) => {
      this.writeResponseToClient(connection, data);
    });
  }

  private writeResponseToClient(connection: ActiveConnection, response: Buffer): void {
    this.emit('data', connection.id, 'server->client', response);
    connection.clientSocket.write(response);
  }

  private handleProxyError(connection: ActiveConnection, error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.log(`Proxy error for connection ${connection.id}: ${err.message}`);
    this.emit('error', err, connection.id);
    connection.clientSocket.destroy();
    connection.serverSocket.destroy();
    this.cleanupConnection(connection.id);
  }

  private attachSocketLifecycleHandlers(connection: ActiveConnection): void {
    connection.clientSocket.on('close', () => {
      this.log(`Client disconnected for connection ${connection.id}`);
      connection.serverSocket.destroy();
      this.cleanupConnection(connection.id);
    });

    connection.serverSocket.on('close', () => {
      this.log(`Server disconnected for connection ${connection.id}`);
      connection.clientSocket.destroy();
      this.cleanupConnection(connection.id);
    });

    connection.clientSocket.on('error', (error) => {
      this.log(`Client error for connection ${connection.id}: ${error.message}`);
      this.emit('error', error, connection.id);
      connection.serverSocket.destroy();
      this.cleanupConnection(connection.id);
    });

    connection.serverSocket.on('error', (error) => {
      this.log(`Server error for connection ${connection.id}: ${error.message}`);
      this.emit('error', error, connection.id);
      connection.clientSocket.destroy();
      this.cleanupConnection(connection.id);
    });

    connection.clientSocket.on('timeout', () => {
      this.log(`Connection ${connection.id} timed out`);
      connection.clientSocket.destroy();
      connection.serverSocket.destroy();
      this.cleanupConnection(connection.id);
    });
  }

  private cleanupConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      this.connections.delete(connectionId);
      this.emit('disconnect', connection);
    }
  }

  private generateConnectionId(): string {
    return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private log(message: string): void {
    if (this.config.enableLogging) {
      console.log(`[RedisProxy] ${new Date().toISOString()} - ${message}`);
    }
  }

  private handleDmcBinaryHeadersRawRequest(connection: ActiveConnection, data: Buffer): Buffer | null {
    if (connection.dmcBinaryHeadersProxy === undefined) {
      return null;
    }

    const commands = parseRespCommandArrays(data);
    const names = commandNames(commands);
    const bindhrCommand = commands.length === 1 && names[0] === 'BINDHR';
    const record: DmcBinaryHeadersProxyRequestRecord = {
      connectionId: connection.id,
      type: 'raw',
      bindhrEnabled: connection.dmcBinaryHeadersProxy.bindhrEnabled,
      commands: stringifyCommands(commands),
      commandNames: names,
      commandCount: commands.length,
      handledLocally: bindhrCommand,
    };
    connection.dmcBinaryHeadersProxy.requests.push(record);

    if (!bindhrCommand) {
      return null;
    }

    return this.handleBindhrCommand(connection, commands[0]);
  }

  private handleBindhrCommand(
    connection: ActiveConnection,
    command: ReadonlyArray<RedisArgument>,
  ): Buffer {
    const subcommand = redisArgumentToString(command[1]).toUpperCase();
    if (command.length > 2) {
      return Buffer.from('-ERR syntax error\r\n');
    }

    switch (subcommand || 'STATUS') {
      case 'ENABLE':
        connection.dmcBinaryHeadersProxy!.bindhrEnabled = true;
        return Buffer.from(':1\r\n');
      case 'DISABLE':
        connection.dmcBinaryHeadersProxy!.bindhrEnabled = false;
        return Buffer.from(':0\r\n');
      case 'STATUS':
        return Buffer.from(`:${connection.dmcBinaryHeadersProxy!.bindhrEnabled ? 1 : 0}\r\n`);
      default:
        return Buffer.from('-ERR syntax error\r\n');
    }
  }

  private async handleDmcBinaryHeadersRequest(
    connection: ActiveConnection,
    frame: Extract<DmcBinaryHeadersRequestFrame, { type: 'binary' }>,
    respQueue: RespQueue,
  ): Promise<Buffer> {
    const dmcBinaryHeadersProxy = connection.dmcBinaryHeadersProxy;
    if (dmcBinaryHeadersProxy === undefined) {
      return respQueue.request(frame.data, frame.header.commandCount);
    }

    let commands: ReadonlyArray<ReadonlyArray<RedisArgument>> = [];
    let validationError = this.validateDmcBinaryHeadersRequestHeader(frame);

    if (validationError === null) {
      try {
        commands = parseRespCommandArrays(frame.payload);
        validationError = this.validateDmcBinaryHeadersCommands(frame, commands, dmcBinaryHeadersProxy);
      } catch (err) {
        validationError = err instanceof Error ? err.message : String(err);
      }
    }

    const record: DmcBinaryHeadersProxyRequestRecord = {
      connectionId: connection.id,
      type: 'binary',
      bindhrEnabled: dmcBinaryHeadersProxy.bindhrEnabled,
      commands: stringifyCommands(commands),
      commandNames: commandNames(commands),
      commandCount: frame.header.commandCount,
      slot: frame.header.slot,
      clientIdx: frame.header.clientIdx,
      rejected: validationError !== null,
      error: validationError ?? undefined,
    };
    dmcBinaryHeadersProxy.requests.push(record);

    if (validationError !== null) {
      return this.createDmcBinaryHeadersProtocolErrorResponse(
        validationError,
        frame.header.commandCount,
        frame.header.clientIdx,
      );
    }

    this.emit('data', connection.id, 'client->server', frame.payload);
    const redisResponse = await respQueue.request(frame.payload, frame.header.commandCount);
    return this.createDmcBinaryHeadersReplyFrame(redisResponse, frame.header.commandCount, frame.header.clientIdx);
  }

  private validateDmcBinaryHeadersRequestHeader(
    frame: Extract<DmcBinaryHeadersRequestFrame, { type: 'binary' }>,
  ): string | null {
    if (frame.header.commandCount < RequestHeaderEncoder.commandCountMinValue()) {
      return `Invalid binary-header command count ${frame.header.commandCount}`;
    }

    if (frame.header.commandCount > RequestHeaderEncoder.commandCountMaxValue()) {
      return `Invalid binary-header command count ${frame.header.commandCount}`;
    }

    if (
      frame.header.slot !== RequestHeaderEncoder.slotNullValue() &&
      frame.header.slot > RequestHeaderEncoder.slotMaxValue()
    ) {
      return `Invalid binary-header slot ${frame.header.slot}`;
    }

    return null;
  }

  private validateDmcBinaryHeadersCommands(
    frame: Extract<DmcBinaryHeadersRequestFrame, { type: 'binary' }>,
    commands: ReadonlyArray<ReadonlyArray<RedisArgument>>,
    dmcBinaryHeadersProxy: NonNullable<ActiveConnection['dmcBinaryHeadersProxy']>,
  ): string | null {
    if (!dmcBinaryHeadersProxy.bindhrEnabled) {
      return 'Binary headers are disabled for this connection';
    }

    if (commands.length !== frame.header.commandCount) {
      return `Binary-header command count ${frame.header.commandCount} does not match RESP payload command count ${commands.length}`;
    }

    const validateEligibility = this.config.dmcBinaryHeadersProxy?.validateEligibility !== false;
    const resolver = this.dmcBinaryHeadersEligibilityResolver;
    if (validateEligibility && resolver === undefined) {
      return 'DMC proxy eligibility resolver was not initialized';
    }

    if (!validateEligibility) {
      for (const command of commands) {
        const name = redisArgumentToString(command[0]).toUpperCase();
        if (name === 'BINDHR') {
          return 'BINDHR must be sent as raw RESP';
        }
      }
      return null;
    }

    let resolvedSlot = RequestHeaderEncoder.slotNullValue();
    for (const command of commands) {
      const name = redisArgumentToString(command[0]).toUpperCase();
      if (name === 'BINDHR') {
        return 'BINDHR must be sent as raw RESP';
      }

      const result = resolver!.getEligibility(command);
      if (!result.eligible) {
        return `${name || '<empty>'} is not binary-header eligible in this proxy`;
      }

      if (result.slot === RequestHeaderEncoder.slotNullValue()) {
        continue;
      }

      if (resolvedSlot === RequestHeaderEncoder.slotNullValue()) {
        resolvedSlot = result.slot;
      } else if (resolvedSlot !== result.slot) {
        return `Binary-header payload contains multiple slots (${resolvedSlot}, ${result.slot})`;
      }
    }

    if (frame.header.slot !== resolvedSlot) {
      return `Binary-header slot ${frame.header.slot} does not match decoded command slot ${resolvedSlot}`;
    }

    return null;
  }

  private createDmcBinaryHeadersReplyFrame(
    payload: Buffer,
    commandCount: number,
    clientIdx: number,
    protocolError = false,
  ): Buffer {
    return Buffer.concat([
      ResponseHeaderEncoder.allocateAndEncode(payload.length, commandCount, protocolError, clientIdx),
      payload,
    ]);
  }

  private createDmcBinaryHeadersProtocolErrorResponse(
    message: string,
    commandCount: number,
    clientIdx: number,
  ): Buffer {
    const safeCommandCount = commandCount >= ResponseHeaderEncoder.commandCountMinValue() &&
      commandCount <= ResponseHeaderEncoder.commandCountMaxValue()
      ? commandCount
      : 1;
    const payload = Buffer.concat(
      Array.from(
        { length: safeCommandCount },
        () => Buffer.from(`-ERR DMC binary header proxy rejected request: ${message}\r\n`),
      ),
    );

    return this.createDmcBinaryHeadersReplyFrame(payload, safeCommandCount, clientIdx, true);
  }
}
import { createServer } from 'net';

export function getFreePortNumber(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.listen(0, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        }
      });
    });

    server.on('error', reject);
  });
}

export { RedisProxy as RedisTransparentProxy };
export type { ProxyConfig, ConnectionInfo, ProxyEvents, SendResult, DataDirection, ProxyStats };
