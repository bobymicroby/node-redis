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
export interface DmcProxyConfig {
  readonly bindhrEnabled?: boolean;
  readonly supportedCommands?: ReadonlyArray<CommandRecord>;
  readonly enableLogging?: boolean;
  readonly validateEligibility?: boolean;
}

/**
 * Listen socket, Redis target, and optional proxy plugins.
 */
interface ProxyConfig {
  readonly listenPort: number;
  readonly listenHost?: string;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly timeout?: number;
  readonly enableLogging?: boolean;
  readonly plugins?: readonly PipelinePlugin[];
  readonly dmcBinaryHeadersProxy?: DmcProxyConfig;
}

interface ConnectionBase {
  readonly id: string;
  readonly clientAddress: string;
  readonly clientPort: number;
  readonly connectedAt: Date;
}

/**
 * One client request group parsed by the DMC plugin.
 *
 * `raw` is one RESP command message. `binary` is one DMC request frame whose
 * payload contains `commandCount` RESP command arrays.
 */
export interface DmcRequest {
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
 * Per-connection DMC state returned to tests.
 */
export interface DmcConnection extends ConnectionBase {
  readonly bindhrEnabled: boolean;
  readonly requests: readonly DmcRequest[];
}

/**
 * Copies of all DMC records kept by the plugin.
 */
export interface DmcStats {
  readonly connections: readonly DmcConnection[];
  readonly requests: readonly DmcRequest[];
}

interface ConnectionInfo extends ConnectionBase {
  readonly interceptors: InterceptorState[];
}

interface ActiveConnection extends ConnectionBase {
  readonly clientSocket: net.Socket;
  readonly serverSocket: net.Socket;
  interceptors: Interceptor[];
}

type SendResult =
  | { readonly success: true; readonly connectionId: string }
  | { readonly success: false; readonly error: string; readonly connectionId: string };

type Direction = 'client->server' | 'server->client';

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
type DmcFrame =
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
  'data': (connectionId: string, direction: Direction, data: Buffer) => void;
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
 * Pass RESP bytes to the next interceptor or Redis writer. Resolves with RESP
 * replies.
 */
export type Next = (data: Buffer) => Promise<Buffer>;

/**
 * Public RESP interceptor.
 *
 * Runs after the proxy byte pipeline and before the Redis writer.
 */
export type InterceptorFn = (data: Buffer, next: Next, state: InterceptorState) => Promise<Buffer>;

export interface InterceptorSpec {
  name: string;
  matchLimit?: number;
  fn: InterceptorFn;
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
  fn: InterceptorFn;
}

export type NextStage<O, R> = (output: O) => Promise<R>;

/**
 * Proxy stage.
 *
 * A stage may emit zero or more values and may change the value type. Returned
 * values are the responses produced while handling the input.
 */
export interface Stage<I, O, R = Buffer> {
  write(input: I, next: NextStage<O, R>): Promise<readonly R[]>;
}

/**
 * Composable proxy stage.
 *
 * A stage can change request bytes before `next()` and response bytes after
 * `next()` resolves.
 */
export type PipelineStage = Stage<Buffer, Buffer>;

interface DmcState extends ConnectionBase {
  bindhrEnabled: boolean;
  requests: DmcRequest[];
}

/**
 * Proxy plugin.
 *
 * Runs before public RESP interceptors.
 */
export interface PipelinePlugin {
  initialize?(): Promise<void> | void;

  createStage(connection: ConnectionInfo): PipelineStage;

  cleanupConnection?(connectionId: string): void;
}

/**
 * A pipeline plugin that exposes DMC request records.
 */
interface DmcStatsSource extends PipelinePlugin {
  getDmcStats(): DmcStats;

  clearDmcStats(): void;
}

type ResolvedProxyConfig = Omit<Required<ProxyConfig>, 'dmcBinaryHeadersProxy'> & {
  readonly dmcBinaryHeadersProxy?: DmcProxyConfig;
};

/**
 * Compose two stages whose adjacent types match.
 */
export function composeStages<A, B, C>(
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
 * Compose same-boundary proxy stages from left to right.
 */
function composeBufferStages(stages: readonly PipelineStage[]): PipelineStage {
  if (stages.length === 0) {
    return {
      write: async (input, next) => [await next(input)],
    };
  }

  let stage = stages[0];
  for (let i = 1; i < stages.length; i++) {
    stage = composeStages(stage, stages[i]);
  }
  return stage;
}

function hasDmcStats(
  plugin: PipelinePlugin
): plugin is DmcStatsSource {
  const candidate: Partial<DmcStatsSource> = plugin;
  return typeof candidate.getDmcStats === 'function' &&
    typeof candidate.clearDmcStats === 'function';
}

/**
 * Incremental framer for DMC mode.
 *
 * The client stream may contain RESP messages and DMC request frames in the
 * same connection.
 */
class DmcFramer extends EventEmitter {
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
  #readFrame(start: number): { frame: DmcFrame; end: number } | null {
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

function countRespMessages(data: Buffer): number {
  let count = 0;
  const framer = new RespFramer();
  framer.on('message', () => count++);
  framer.write(data);

  return count || 1;
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
 * Default parser for client byte streams that contain plain RESP only.
 */
class RespPlugin implements PipelinePlugin {
  public createStage(): PipelineStage {
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
          responses.push(await next(frame));
        }
        return responses;
      },
    };
  }
}

/**
 * Parser for client byte streams that may contain DMC binary-header frames.
 *
 * Raw RESP is passed through. Binary-header requests are checked, stripped to
 * RESP before Redis sees them, and wrapped again on the reply path.
 */
class DmcPlugin implements DmcStatsSource {
  private readonly config: DmcProxyConfig;
  private eligibilityResolver?: EligibilityResolver;
  private readonly connections = new Map<string, DmcState>();

  constructor(config: DmcProxyConfig) {
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
  public createStage(connection: ConnectionInfo): PipelineStage {
    return composeStages(
      this.createFrameStage(),
      this.createDmcRequestStage(this.createConnectionState(connection)),
    );
  }

  public cleanupConnection(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  /**
   * Return copied per-connection records.
   */
  public getDmcStats(): DmcStats {
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

  public clearDmcStats(): void {
    for (const connection of this.connections.values()) {
      connection.requests.splice(0);
    }
  }

  /**
   * Frame client byte chunks as RESP or DMC messages.
   */
  private createFrameStage(): Stage<Buffer, DmcFrame> {
    const framer = new DmcFramer();
    return {
      write: async (chunk, next) => {
        const frames: DmcFrame[] = [];
        const onMessage = (frame: DmcFrame) => frames.push(frame);
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
   * Strip binary request headers and wrap their replies.
   */
  private createDmcRequestStage(
    state: DmcState
  ): Stage<DmcFrame, Buffer> {
    return {
      write: async (frame, next) => frame.type === 'binary'
        ? this.handleRequestFrame(state, frame, next)
        : this.handleRawFrame(state, frame.data, next),
    };
  }

  private createConnectionState(
    connection: ConnectionInfo
  ): DmcState {
    const existing = this.connections.get(connection.id);
    if (existing !== undefined) {
      return existing;
    }

    const state: DmcState = {
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
    state: DmcState,
    data: Buffer,
    next: NextStage<Buffer, Buffer>
  ): Promise<readonly Buffer[]> {
    const commands = parseRespCommandArrays(data);
    const names = commandNames(commands);
    const record: DmcRequest = {
      connectionId: state.id,
      type: 'raw',
      bindhrEnabled: state.bindhrEnabled,
      commands: stringifyCommands(commands),
      commandNames: names,
      commandCount: commands.length,
    };
    state.requests.push(record);

    return [await next(data)];
  }

  /**
   * Strip a valid DMC request to RESP; wrap the RESP replies on return.
   */
  private async handleRequestFrame(
    state: DmcState,
    frame: Extract<DmcFrame, { type: 'binary' }>,
    next: NextStage<Buffer, Buffer>
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

    const record: DmcRequest = {
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

    const redisResponse = await next(frame.payload);
    return [this.createReplyFrame(redisResponse, frame.header.commandCount, frame.header.clientIdx)];
  }

  /**
   * Header checks do not require RESP payload decoding.
   */
  private validateRequestHeader(
    frame: Extract<DmcFrame, { type: 'binary' }>,
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
    frame: Extract<DmcFrame, { type: 'binary' }>,
    commands: ReadonlyArray<ReadonlyArray<RedisArgument>>,
    state: DmcState,
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
   * Return one RESP error per expected command, wrapped as a protocol-error DMC reply.
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
 * Client bytes pass through a built-in parser, configured proxy plugins,
 * public RESP interceptors, then the Redis writer. Enabling the DMC config
 * swaps the built-in RESP parser for the DMC parser.
 */
export class RedisProxy extends EventEmitter {
  private readonly server: net.Server;
  public readonly config: ResolvedProxyConfig;
  private readonly connections: Map<string, ActiveConnection>;
  private isRunning: boolean;
  private globalInterceptors: Interceptor[] = [];
  private readonly plugins: readonly PipelinePlugin[];

  constructor(config: ProxyConfig) {
    super();

    const enableLogging = config.enableLogging ?? config.dmcBinaryHeadersProxy?.enableLogging ?? false;

    this.config = {
      listenHost: '127.0.0.1',
      timeout: 30000,
      plugins: [],
      ...config,
      enableLogging
    };

    this.connections = new Map();
    this.isRunning = false;
    this.plugins = this.createPlugins();
    this.server = this.createServer();
  }

  /**
   * Initialize plugins before accepting client sockets.
   */
  public async start(): Promise<void> {
    await this.initializePlugins();

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

  private createPlugins(): readonly PipelinePlugin[] {
    const parserPlugin = this.config.dmcBinaryHeadersProxy === undefined
      ? new RespPlugin()
      : new DmcPlugin(this.config.dmcBinaryHeadersProxy);

    return [
      parserPlugin,
      ...(this.config.plugins ?? []),
    ];
  }

  private async initializePlugins(): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.initialize?.();
    }
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

  private makeInterceptor(spec: InterceptorSpec): Interceptor {
    const { name, fn, matchLimit } = spec;
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
    interceptorSpecs: Array<InterceptorSpec>,
  ) {
    const interceptors: Interceptor[] = interceptorSpecs.map(this.makeInterceptor);
    this.globalInterceptors = interceptors;
  }

  public addGlobalInterceptor(
    interceptorSpec: InterceptorSpec,
  ) {
    const interceptor = this.makeInterceptor(interceptorSpec);
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
   * DMC request records live on the parser plugin.
   */
  public getDmcStats(): DmcStats {
    return this.getDmcStatsSource()?.getDmcStats() ?? {
      connections: [],
      requests: [],
    };
  }

  public clearDmcStats(): void {
    this.getDmcStatsSource()?.clearDmcStats();
  }

  private getDmcStatsSource(): DmcStatsSource | undefined {
    return this.plugins.find(hasDmcStats);
  }

  private cleanupPlugins(connectionId: string): void {
    for (const plugin of this.plugins) {
      plugin.cleanupConnection?.(connectionId);
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
    this.cleanupPlugins(connectionId);
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
    const pipelineStage = this.createPipelineStage(connectionInfo);
    const interceptorStage = this.createInterceptorChainStage(connectionInfo);
    const sendToRedis = this.createRedisTerminal(connectionInfo, respQueue);

    this.attachPipeline(connectionInfo, pipelineStage, interceptorStage, sendToRedis);
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

  private getConnectionInfo(connection: ActiveConnection): ConnectionInfo {
    return {
      id: connection.id,
      clientAddress: connection.clientAddress,
      clientPort: connection.clientPort,
      connectedAt: connection.connectedAt,
      interceptors: connection.interceptors.map((interceptor) => interceptor.state),
    };
  }

  /**
   * Build this connection's byte pipeline.
   */
  private createPipelineStage(connection: ActiveConnection): PipelineStage {
    const connectionInfo = this.getConnectionInfo(connection);
    return composeBufferStages(
      this.plugins.map((plugin) => plugin.createStage(connectionInfo))
    );
  }

  /**
   * Run public RESP interceptors after the proxy pipeline.
   */
  private createInterceptorChainStage(connection: ActiveConnection): Stage<Buffer, Buffer> {
    return {
      write: async (data, next) => {
        const interceptorChain = connection.interceptors.concat(this.globalInterceptors).reduceRight<NextStage<Buffer, Buffer>>(
          (nextInterceptor, interceptor) => (data) =>
            interceptor.fn(
              data,
              nextInterceptor,
              interceptor.state,
            ),
          next,
        );

        return [await interceptorChain(data)];
      },
    };
  }

  /**
   * Redis writer. Reply count is derived after interceptors have run.
   */
  private createRedisTerminal(
    connection: ActiveConnection,
    respQueue: RespQueue
  ): NextStage<Buffer, Buffer> {
    return async (data) => {
      this.emit('data', connection.id, 'client->server', data);
      return respQueue.request(data, countRespMessages(data));
    };
  }

  /**
   * Keep response order equal to request read order.
   */
  private attachPipeline(
    connection: ActiveConnection,
    pipelineStage: PipelineStage,
    interceptorStage: Stage<Buffer, Buffer>,
    terminal: NextStage<Buffer, Buffer>
  ): void {
    const requestStage = composeStages(pipelineStage, interceptorStage);
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
      this.cleanupPlugins(connectionId);
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
export type { ProxyConfig, ConnectionInfo, ProxyEvents, SendResult, Direction, ProxyStats };
