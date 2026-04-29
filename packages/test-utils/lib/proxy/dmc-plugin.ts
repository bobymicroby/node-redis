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
import {
  composeTransformers,
  type ConnectionBase,
  type ConnectionInfo,
  type BufferTransformer,
  type ProxyPlugin,
  type Sink,
  type Transformer,
} from './transformer';

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

/**
 * Proxy plugin that exposes DMC request records.
 */
export interface DmcStatsSource extends ProxyPlugin {
  getDmcStats(): DmcStats;

  clearDmcStats(): void;
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

interface DmcState extends ConnectionBase {
  bindhrEnabled: boolean;
  requests: DmcRequest[];
}

export function hasDmcStats(
  plugin: ProxyPlugin
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

function stringifyCommands(
  commands: ReadonlyArray<ReadonlyArray<RedisArgument>>,
): string[][] {
  return commands.map((command) => command.map(redisArgumentToString));
}

function commandNames(commands: ReadonlyArray<ReadonlyArray<RedisArgument>>): string[] {
  return commands.map((command) => redisArgumentToString(command[0]).toUpperCase());
}

/**
 * Parser for client byte streams that may contain DMC binary-header frames.
 *
 * Raw RESP is passed through. Binary-header requests are checked, stripped to
 * RESP before Redis sees them, and wrapped again on the reply path.
 */
export class DmcPlugin implements DmcStatsSource {
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
  public createTransformer(connection: ConnectionInfo): BufferTransformer {
    return composeTransformers(
      this.createFrameTransformer(),
      this.createDmcRequestTransformer(this.createConnectionState(connection)),
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
  private createFrameTransformer(): Transformer<Buffer, DmcFrame> {
    const framer = new DmcFramer();
    return {
      transform: async (chunk, next) => {
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
  private createDmcRequestTransformer(
    state: DmcState
  ): Transformer<DmcFrame, Buffer> {
    return {
      transform: async (frame, next) => frame.type === 'binary'
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
    next: Sink<Buffer, Buffer>
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
    next: Sink<Buffer, Buffer>
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
