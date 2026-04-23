import type { RedisArgument } from '../RESP/types';
import type { CommandToWrite } from '../client/commands-queue';

export interface Cancellable {
  cancel(): void;
}

export interface Scheduler {
  schedule(delayMs: number, callback: () => void): Cancellable;
}

/**
 * Raw command arguments before encoding.
 */
export type CommandArguments = ReadonlyArray<RedisArgument>;

/**
 * A single chunk of data ready to be written to the socket.
 * Represents one encoded command or batch.
 */
export type SocketChunk = ReadonlyArray<RedisArgument>;

/**
 * Multiple chunks ready to be written to the socket.
 */
export type SocketChunks = ReadonlyArray<SocketChunk>;

/**
 * A batch of encoded socket writes produced by an outbound codec.
 *
 * `writes` contains the wire payload ready for `socket.write(...)`.
 * `emittedCommands` contains the queue command records that those writes
 * put on the wire and should therefore move into `waitingForReply`.
 */
export interface WriteBatch {
  writes: SocketChunks;
  emittedCommands: ReadonlyArray<CommandToWrite>;
}

export type BufferedCommands = ReadonlyArray<CommandToWrite>;

/**
 * Queue-owned metadata that influences outbound batching policy.
 */
export interface WriteCommandMeta {
  chainId?: symbol;
  forceImmediate?: boolean;
}

/**
 * Async sink used by codecs that can emit writes outside the generator flow,
 * such as timer-driven batching.
 */
export interface WriteSink {
  emit(batch: WriteBatch): void;
  onError(err: unknown): void;
}

/**
 * Pluggable outbound transport codec.
 *
 * The queue treats this as a black box that accepts encoded commands and
 * decides whether to buffer, aggregate, or emit socket-ready writes.
 */
export interface OutboundCodec {
  /**
   * Bind an async sink used for write batches emitted outside the generator flow
   * (for example from an internal timer).
   */
  bind(sink: WriteSink): void;

  /**
   * Push one encoded command into the codec.
   *
   * Returns a write batch when the command caused bytes to become ready for the
   * socket, or `null` when the command was only buffered.
   */
  push(
    command: CommandToWrite,
    encoded: SocketChunk,
    args: CommandArguments,
    byteLength?: number,
    meta?: WriteCommandMeta
  ): WriteBatch | null;

  /**
   * Signal that no more `push(...)` calls will arrive for now.
   *
   * The codec decides whether pending data should drain now or stay buffered
   * for an internal timer.
   */
  completePushes(): WriteBatch | null;

  /**
   * Whether the codec currently holds buffered data that has not been emitted.
   */
  hasBuffered(): boolean;

  /**
   * Drop any codec-owned buffered commands that were never emitted.
   *
   * The queue uses the returned commands to reject the corresponding promises.
   */
  reset(): BufferedCommands;

  /**
   * Cleanup hook for codecs that keep async resources such as timers.
   */
  destroy(): void;
}

/**
 * Pluggable inbound transport codec.
 *
 * Inbound flow is streaming: the socket pushes chunks as they arrive, and the
 * codec forwards decoded RESP data to `next(...)`.
 */
export interface InboundCodec {
  /**
   * Decode an incoming wire chunk and forward RESP payload to `next(...)`.
   */
  decode(chunk: Buffer, next: (data: Buffer) => void): void;

  /**
   * Queue-to-codec notification telling the inbound codec whether a decoded
   * top-level RESP value was treated as a pending-command reply or as a push
   * notification.
   *
   * Generic codecs may ignore this hook. Binary Headers uses it when
   * reply-stream validation is enabled, because in RESP2 only the queue can
   * decide, based on connection state and message contents, whether a decoded
   * array consumed reply-credit or was handled as push. In RESP3, push frames
   * are explicit on the wire (`>`).
   */
  noteReplyOrPush?(kind: ReplyOrPush): void;

  /**
   * Clear codec-internal state (e.g. partial frame buffers)
   * when the queue decoder is reset due to reconnect/error recovery.
   */
  reset(): void;
}

export type ReplyOrPush = 'reply' | 'push';

/**
 * Paired inbound/outbound transport codecs used by the command queue.
 */
export interface WireCodec {
  readonly outbound?: OutboundCodec;
  readonly inbound?: InboundCodec;
}

/**
 * Callback used by the queue when encoded writes are ready for the socket.
 */
export type WriteHandler = (writes: SocketChunks) => void;
