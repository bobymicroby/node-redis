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

/**
 * DMC binary-header mode for this test proxy.
 *
 * Client input may be RESP or DMC binary-header request frames. The proxy
 * writes RESP only to Redis: the test Redis server does not decode binary
 * headers. Replies to binary-header requests are wrapped before they are
 * written back to the client.
 */
export interface DmcBinaryHeadersProxyConfig {
  readonly bindhrEnabled?: boolean;
  readonly supportedCommands?: ReadonlyArray<CommandRecord>;
  readonly enableLogging?: boolean;
  readonly validateEligibility?: boolean;
}

/**
 * Listen socket and Redis target.
 */
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

/**
 * One client request group parsed by the DMC plugin.
 *
 * `raw` is one complete RESP message. `binary` is one DMC request frame whose
 * payload contains `commandCount` RESP command arrays.
 */
export interface DmcBinaryHeadersProxyRequestRecord {
  readonly connectionId: string;
  readonly type: 'raw' | 'binary';
  readonly bindhrEnabled: boolean;
  readonly commands: readonly string[][];
  readonly commandNames: readonly string[];
  readonly commandCount: number;
  readonly slot?: number;
  readonly clientIdx?: number;
  readonly rejected?: boolean;
  readonly error?: string;
}

/**
 * DMC state kept for one live client connection.
 */
export interface DmcBinaryHeadersProxyConnectionInfo {
  readonly bindhrEnabled: boolean;
  readonly requests: readonly DmcBinaryHeadersProxyRequestRecord[];
}

/**
 * Per-connection DMC state returned to tests.
 */
export interface DmcBinaryHeadersProxyConnectionStats extends ConnectionInfoCommon, DmcBinaryHeadersProxyConnectionInfo {}

/**
 * Copies of all DMC records kept by the plugin.
 */
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

/**
 * Frame parsed from client bytes in DMC mode.
 *
 * `raw.data` is a complete RESP message. `binary.payload` is the RESP bytes
 * inside one DMC request frame.
 */
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
  /** Emitted after the Redis-side socket connects for a client. */
  'connection': (connectionInfo: ConnectionInfo) => void;
  /** Emitted after connection cleanup removes the socket pair. */
  'disconnect': (connectionInfo: ConnectionInfo) => void;
  /** Emitted for bytes written toward Redis or toward the client. */
  'data': (connectionId: string, direction: DataDirection, data: Buffer) => void;
  /** Emitted for client, Redis-side, or proxy server socket errors. */
  'error': (error: Error, connectionId?: string) => void;
  /** Emitted after the proxy listen socket is bound. */
  'listening': (host: string, port: number) => void;
  /** Emitted after the proxy listen socket closes. */
  'close': () => void;
}

/**
 * Continuation passed to public RESP interceptors.
 *
 * `data` is RESP bytes for one or more command arrays. `next()` passes those
 * bytes to later interceptors and then to Redis, and resolves with the RESP
 * replies. DMC headers and reply counts are outside this API.
 */
export type Next = (data: Buffer) => Promise<Buffer>;

/**
 * Public RESP interceptor.
 *
 * It runs after client input has been converted to RESP bytes and before those
 * bytes are written to Redis. In DMC mode the binary header is already stripped.
 */
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

type StageNext<O, R> = (output: O) => Promise<R>;

/**
 * Request pipeline stage.
 *
 * A stage may emit zero or more values and may change the value type. The
 * return value is the response bytes for the input it consumed.
 */
interface Stage<I, O, R = Buffer> {
  write(input: I, next: StageNext<O, R>): Promise<readonly R[]>;
}

/**
 * RESP bytes to write to Redis plus the number of RESP replies to read.
 */
interface ProxyRequest {
  readonly data: Buffer;
  readonly expectedReplies: number;
}

/**
 * Parser from client socket chunks to `ProxyRequest` values.
 */
type RequestParserStage = Stage<Buffer, ProxyRequest>;

interface DmcBinaryHeadersConnectionState extends ConnectionInfoCommon {
  bindhrEnabled: boolean;
  requests: DmcBinaryHeadersProxyRequestRecord[];
}

/**
 * Optional parser for client input before public RESP interceptors.
 *
 * Output must be `ProxyRequest`; `ProxyRequest.data` must be RESP.
 */
interface RequestPipelinePlugin {
  initialize(): Promise<void>;

  createRequestStage(connection: ActiveConnection): RequestParserStage;

  cleanupConnection(connectionId: string): void;
}

type ResolvedProxyConfig = Omit<Required<ProxyConfig>, 'dmcBinaryHeadersProxy'> & {
  readonly dmcBinaryHeadersProxy?: DmcBinaryHeadersProxyConfig;
};

/**
 * Keep adjacent pipeline types explicit.
 *
 * DMC parsing is `Buffer -> DmcBinaryHeadersRequestFrame -> ProxyRequest`.
 * Pairwise composition gives the proxy core one parser without a list whose
 * elements have different input and output types.
 */
function composeStages<A, B, C>(
  first: Stage<A, B>,
  second: Stage<B, C>
): Stage<A, C> {
  return {
    write: (input, next) => first.write(input, async (middle) => {
      const responses = await second.write(middle, next);
      return Buffer.concat(responses);
    }),
  };
}

/**
 * Incremental framer for DMC mode.
 *
 * The client stream may contain RESP messages and DMC request frames in the
 * same connection.
 */
class DmcBinaryHeadersRequestFramer extends EventEmitter {
  readonly #respFramer = new RespFramer();
  readonly #headerDecoder = new RequestHeaderDecoder();
  #buffer = Buffer.alloc(0);
  #offset = 0;

  /**
   * Emit complete frames; keep a trailing partial frame buffered.
   */
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

  /**
   * Return null if the buffer does not yet hold a full frame.
   */
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

/**
 * Parser plugin for the DMC binary-header subset used by client tests.
 *
 * Raw RESP is passed through. Binary-header requests are checked, stripped to
 * RESP before Redis sees them, and wrapped again on the reply path.
 */
class DmcBinaryHeadersProxyPlugin implements RequestPipelinePlugin {
  private readonly config: DmcBinaryHeadersProxyConfig;
  private eligibilityResolver?: EligibilityResolver;
  private readonly connections = new Map<string, DmcBinaryHeadersConnectionState>();

  constructor(config: DmcBinaryHeadersProxyConfig) {
    this.config = config;
  }

  /**
   * Build the static command eligibility table used by this test proxy.
   */
  public async initialize(): Promise<void> {
    if (this.eligibilityResolver !== undefined) {
      return;
    }

    const supportedCommands = this.config.supportedCommands ?? STATIC_COMMAND_RECORDS;
    this.eligibilityResolver = await createEligibilityResolver(async () => supportedCommands);
  }

  /**
   * Each connection has its own framer; partial TCP chunks are per socket.
   */
  public createRequestStage(connection: ActiveConnection): RequestParserStage {
    return composeStages(
      this.createFrameStage(),
      this.createDmcRequestStage(this.createConnectionState(connection)),
    );
  }

  public cleanupConnection(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  /**
   * Return copies; tests must not mutate live connection state.
   */
  public getStats(): DmcBinaryHeadersProxyStats {
    const connections = Array.from(this.connections.values())
      .map((connection) => ({
        id: connection.id,
        clientAddress: connection.clientAddress,
        clientPort: connection.clientPort,
        connectedAt: connection.connectedAt,
        bindhrEnabled: connection.bindhrEnabled,
        requests: [...connection.requests],
      }));

    return {
      connections,
      requests: connections.flatMap((connection) => connection.requests),
    };
  }

  public clearStats(): void {
    for (const connection of this.connections.values()) {
      connection.requests.splice(0);
    }
  }

  /**
   * First DMC parser step: client bytes to RESP/DMC frames.
   */
  private createFrameStage(): Stage<Buffer, DmcBinaryHeadersRequestFrame> {
    const framer = new DmcBinaryHeadersRequestFramer();
    return {
      write: async (chunk, next) => {
        const frames: DmcBinaryHeadersRequestFrame[] = [];
        const onMessage = (frame: DmcBinaryHeadersRequestFrame) => frames.push(frame);
        framer.on('message', onMessage);

        try {
          framer.write(chunk);
        } finally {
          framer.off('message', onMessage);
        }

        const responses: Buffer[] = [];
        for (const frame of frames) {
          responses.push(await next(frame));
        }
        return responses;
      },
    };
  }

  /**
   * Second DMC parser step: framer output to Redis RESP requests.
   */
  private createDmcRequestStage(
    state: DmcBinaryHeadersConnectionState
  ): Stage<DmcBinaryHeadersRequestFrame, ProxyRequest> {
    return {
      write: async (frame, next) => frame.type === 'binary'
        ? this.handleRequestFrame(state, frame, next)
        : this.handleRawFrame(state, frame.data, next),
    };
  }

  private createConnectionState(
    connection: ActiveConnection
  ): DmcBinaryHeadersConnectionState {
    const existing = this.connections.get(connection.id);
    if (existing !== undefined) {
      return existing;
    }

    const state: DmcBinaryHeadersConnectionState = {
      id: connection.id,
      clientAddress: connection.clientAddress,
      clientPort: connection.clientPort,
      connectedAt: connection.connectedAt,
      bindhrEnabled: this.config.bindhrEnabled ?? true,
      requests: [],
    };
    this.connections.set(connection.id, state);
    return state;
  }

  /**
   * Record raw RESP and forward it unchanged.
   */
  private async handleRawFrame(
    state: DmcBinaryHeadersConnectionState,
    data: Buffer,
    next: StageNext<ProxyRequest, Buffer>
  ): Promise<readonly Buffer[]> {
    const commands = parseRespCommandArrays(data);
    const names = commandNames(commands);
    const record: DmcBinaryHeadersProxyRequestRecord = {
      connectionId: state.id,
      type: 'raw',
      bindhrEnabled: state.bindhrEnabled,
      commands: stringifyCommands(commands),
      commandNames: names,
      commandCount: commands.length,
    };
    state.requests.push(record);

    return [await next({ data, expectedReplies: commands.length || 1 })];
  }

  /**
   * Strip a valid DMC request to RESP; wrap the RESP replies on return.
   */
  private async handleRequestFrame(
    state: DmcBinaryHeadersConnectionState,
    frame: Extract<DmcBinaryHeadersRequestFrame, { type: 'binary' }>,
    next: StageNext<ProxyRequest, Buffer>
  ): Promise<readonly Buffer[]> {
    let commands: ReadonlyArray<ReadonlyArray<RedisArgument>> = [];
    let validationError = this.validateRequestHeader(frame);

    if (validationError === null) {
      try {
        commands = parseRespCommandArrays(frame.payload);
        validationError = this.validateCommands(frame, commands, state);
      } catch (err) {
        validationError = err instanceof Error ? err.message : String(err);
      }
    }

    const record: DmcBinaryHeadersProxyRequestRecord = {
      connectionId: state.id,
      type: 'binary',
      bindhrEnabled: state.bindhrEnabled,
      commands: stringifyCommands(commands),
      commandNames: commandNames(commands),
      commandCount: frame.header.commandCount,
      slot: frame.header.slot,
      clientIdx: frame.header.clientIdx,
      rejected: validationError !== null,
      error: validationError ?? undefined,
    };
    state.requests.push(record);

    if (validationError !== null) {
      return [this.createProtocolErrorResponse(
        validationError,
        frame.header.commandCount,
        frame.header.clientIdx,
      )];
    }

    const redisResponse = await next({
      data: frame.payload,
      expectedReplies: frame.header.commandCount,
    });
    return [this.createReplyFrame(redisResponse, frame.header.commandCount, frame.header.clientIdx)];
  }

  /**
   * Header checks do not require RESP payload decoding.
   */
  private validateRequestHeader(
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

  /**
   * Enforce the static eligibility config used by this test proxy.
   */
  private validateCommands(
    frame: Extract<DmcBinaryHeadersRequestFrame, { type: 'binary' }>,
    commands: ReadonlyArray<ReadonlyArray<RedisArgument>>,
    state: DmcBinaryHeadersConnectionState,
  ): string | null {
    if (!state.bindhrEnabled) {
      return 'Binary headers are disabled for this connection';
    }

    if (commands.length !== frame.header.commandCount) {
      return `Binary-header command count ${frame.header.commandCount} does not match RESP payload command count ${commands.length}`;
    }

    const validateEligibility = this.config.validateEligibility !== false;
    const resolver = this.eligibilityResolver;
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

  private createReplyFrame(
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

  /**
   * Return enough RESP errors to satisfy the client's reply tracker.
   */
  private createProtocolErrorResponse(
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

    return this.createReplyFrame(payload, safeCommandCount, clientIdx, true);
  }
}

/**
 * TCP proxy between node-redis and a Redis test server.
 *
 * Client bytes are parsed to `ProxyRequest`, passed through public RESP
 * interceptors, then written to Redis. DMC request frames are stripped before
 * the public interceptors run.
 */
export class RedisProxy extends EventEmitter {
  private readonly server: net.Server;
  public readonly config: ResolvedProxyConfig;
  private readonly connections: Map<string, ActiveConnection>;
  private isRunning: boolean;
  private globalInterceptors: Interceptor[] = [];
  private readonly requestPipelinePlugin?: RequestPipelinePlugin;

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
    this.requestPipelinePlugin = this.createRequestPipelinePlugin();
    this.server = this.createServer();
  }

  /**
   * Initialize the parser before accepting client sockets.
   */
  public async start(): Promise<void> {
    await this.initializeRequestPipelinePlugin();

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

  /**
   * DMC replaces the plain RESP parser when binary-header mode is enabled.
   */
  private createRequestPipelinePlugin(): RequestPipelinePlugin | undefined {
    if (this.config.dmcBinaryHeadersProxy === undefined) {
      return undefined;
    }

    return new DmcBinaryHeadersProxyPlugin(this.config.dmcBinaryHeadersProxy);
  }

  /**
   * Parser setup may load command eligibility data.
   */
  private async initializeRequestPipelinePlugin(): Promise<void> {
    await this.requestPipelinePlugin?.initialize();
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

  /**
   * Existing connections use the new list on their next request.
   */
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
        interceptors: conn.interceptors.map(i => i.state)
      })),
    };
  }

  /**
   * DMC records are separate from `getStats()` socket/interceptor counters.
   */
  public getDmcBinaryHeadersProxyStats(): DmcBinaryHeadersProxyStats {
    return this.getDmcBinaryHeadersProxyPlugin()?.getStats() ?? {
      connections: [],
      requests: [],
    };
  }

  public clearDmcBinaryHeadersProxyStats(): void {
    this.getDmcBinaryHeadersProxyPlugin()?.clearStats();
  }

  private getDmcBinaryHeadersProxyPlugin(): DmcBinaryHeadersProxyPlugin | undefined {
    return this.requestPipelinePlugin instanceof DmcBinaryHeadersProxyPlugin
      ? this.requestPipelinePlugin
      : undefined;
  }

  private cleanupRequestPipelinePlugin(connectionId: string): void {
    this.requestPipelinePlugin?.cleanupConnection(connectionId);
  }

  public closeConnection(connectionId: string): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return false;
    }

    connection.clientSocket.destroy();
    connection.serverSocket.destroy();
    this.connections.delete(connectionId);
    this.cleanupRequestPipelinePlugin(connectionId);
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

  /**
   * Do not read client bytes until the Redis socket exists and the pipeline is
   * installed.
   */
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
    const requestParser = this.createRequestParserStage(connectionInfo);
    const interceptorStage = this.createInterceptorChainStage(connectionInfo);
    const sendToRedis = this.createRedisTerminal(connectionInfo, respQueue);

    this.attachRequestPipeline(connectionInfo, requestParser, interceptorStage, sendToRedis);
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
    };
  }

  /**
   * Choose the client-byte parser for this connection.
   */
  private createRequestParserStage(connection: ActiveConnection): RequestParserStage {
    return this.requestPipelinePlugin?.createRequestStage(connection) ?? this.createRespFrameStage();
  }

  /**
   * Plain RESP parser: one complete client message becomes one Redis request.
   */
  private createRespFrameStage(): Stage<Buffer, ProxyRequest> {
    const framer = new RespFramer();
    return {
      write: async (chunk, next) => {
        const frames: Buffer[] = [];
        const onMessage = (frame: Buffer) => frames.push(frame);
        framer.on('message', onMessage);

        try {
          framer.write(chunk);
        } finally {
          framer.off('message', onMessage);
        }

        const responses: Buffer[] = [];
        for (const frame of frames) {
          responses.push(await next({ data: frame, expectedReplies: 1 }));
        }
        return responses;
      },
    };
  }

  /**
   * Hide `expectedReplies` from public interceptors; keep it around their
   * `Buffer -> Buffer` calls.
   */
  private createInterceptorChainStage(connection: ActiveConnection): Stage<ProxyRequest, ProxyRequest> {
    return {
      write: async (request, next) => {
        const interceptorChain = connection.interceptors.concat(this.globalInterceptors).reduceRight<StageNext<ProxyRequest, Buffer>>(
          (nextInterceptor, interceptor) => (request) =>
            interceptor.fn(
              request.data,
              (data) => nextInterceptor({ ...request, data }),
              interceptor.state,
            ),
          next,
        );

        return [await interceptorChain(request)];
      },
    };
  }

  /**
   * Redis writer. `request.data` must be RESP.
   */
  private createRedisTerminal(
    connection: ActiveConnection,
    respQueue: RespQueue
  ): StageNext<ProxyRequest, Buffer> {
    return async (request) => {
      this.emit('data', connection.id, 'client->server', request.data);
      return respQueue.request(request.data, request.expectedReplies);
    };
  }

  /**
   * Keep response order equal to request read order.
   */
  private attachRequestPipeline(
    connection: ActiveConnection,
    requestParser: RequestParserStage,
    interceptorStage: Stage<ProxyRequest, ProxyRequest>,
    terminal: StageNext<ProxyRequest, Buffer>
  ): void {
    const requestStage = composeStages(requestParser, interceptorStage);
    let responseChain = Promise.resolve();

    connection.clientSocket.on('data', (chunk) => {
      responseChain = responseChain.then(async () => {
        const responses = await requestStage.write(chunk, terminal);
        for (const response of responses) {
          this.writeResponseToClient(connection, response);
        }
      }).catch((err) => {
        this.handleProxyError(connection, err);
      });
    });
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
      this.cleanupRequestPipelinePlugin(connectionId);
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
