import type {
  OutboundCodec,
  InboundCodec,
  WireCodec,
  SocketChunk,
  CommandArguments,
  CommandToWrite,
  WriteBatch,
  WriteCommandMeta,
  WriteSink,
  Scheduler,
  Cancellable
} from '../client/commands-queue';
import type { EligibilityResolver } from './eligibility';
import { SLOT_INELIGIBLE, NOOP_RESOLVER } from './eligibility';
import { CommandPacker, calculatePayloadLength as calcPayloadLength, type CommandPackerOptions } from './packing';
import { ResponseHeaderDecoder, type ResponseHeader as BinaryResponseHeader } from './generated/response-header-codec';
import { FlushReason, disabledBinaryHeaderStatsCounter, type BinaryHeaderStatsCounter, type BinaryHeaderStats } from './stats';
import {
  PlainRespFrameScanner,
  PLAIN_FRAME_INVALID,
  PLAIN_FRAME_NEED_MORE,
} from './plain-resp-frame-scanner';

export type OnHeader = (header: BinaryResponseHeader) => void;
export type OnProtocolError = (header: BinaryResponseHeader) => void;

export interface BinaryHeadersOutboundOptions {
  readonly resolver?: EligibilityResolver;
  /**
   * Maximum number of commands to batch before flushing.
   * Must be between 1 and RequestHeaderEncoder.commandCountMaxValue().
   * Default: RequestHeaderEncoder.commandCountMaxValue()
   */
  readonly maxCommandCount?: number;
  /**
   * Maximum payload length in bytes before flushing.
   * Must be between 1 and RequestHeaderEncoder.lengthMaxValue().
   * Default: RequestHeaderEncoder.lengthMaxValue()
   */
  readonly maxPayloadLength?: number;
  /**
   * Optional timer used for auto-pipelining segments.
   * Explicit pipeline segments always drain at iteration end instead.
   */
  readonly timer?: BinaryHeadersOutboundTimerOptions;
}

export interface BinaryHeadersOutboundTimerOptions {
  readonly maxWaitMs: number;
  readonly scheduler: Scheduler;
}

export interface BinaryHeadersInboundOptions {
  readonly onHeader?: OnHeader;
  readonly onProtocolError?: OnProtocolError;
}

export interface BinaryHeadersCodecOptions {
  readonly outbound?: BinaryHeadersOutboundOptions;
  readonly inbound?: BinaryHeadersInboundOptions;
  readonly statsCounter?: BinaryHeaderStatsCounter;
}

/**
 * Binary headers outbound codec.
 *
 * Encodes outbound commands into binary-header batches when they are eligible.
 * Uses the resolver to determine eligibility and the packer to batch by slot.
 *
 * Batching behavior:
 * - Eligible commands accumulate in a buffer until a flush is triggered
 * - Flush triggers: slot change, max commands reached, timer expiry, or ineligible command
 * - Ineligible commands always pass through unchanged, but first flush any pending batch
 * - This preserves command ordering while maximizing batching opportunities
 *
 * What `push()` / `drain()` return in different scenarios:
 * - Eligible, still buffering        -> null
 * - Eligible, triggers batch emit    -> { writes: [packed], emittedCommands: [...] }
 * - Ineligible, nothing buffered     -> { writes: [encoded], emittedCommands: [command] }
 * - Ineligible with buffered batch   -> { writes: [pending, encoded], emittedCommands: [...] }
 */
export class BinaryHeadersOutboundCodec implements OutboundCodec {
  readonly #resolver: EligibilityResolver;
  readonly #packer: CommandPacker;
  readonly #statsCounter: BinaryHeaderStatsCounter;
  readonly #scheduler: Scheduler | null;
  readonly #maxWaitMs: number;
  #chainSlotCache: Map<symbol, number> = new Map();
  #lastChainId: symbol | undefined;
  #bufferedCommands: CommandToWrite[] = [];
  #pendingChainId: symbol | undefined;
  #pendingRequiresDrainAtEnd = false;
  #pendingFlush: Cancellable | null = null;
  #sink: WriteSink | null = null;

  constructor(
    options: BinaryHeadersOutboundOptions = {},
    statsCounter?: BinaryHeaderStatsCounter
  ) {
    this.#statsCounter = statsCounter ?? disabledBinaryHeaderStatsCounter();
    this.#resolver = options.resolver ?? NOOP_RESOLVER;
    this.#scheduler = options.timer?.scheduler ?? null;
    this.#maxWaitMs = options.timer?.maxWaitMs ?? 0;
    const packerOptions: CommandPackerOptions = {
      maxCommandCount: options.maxCommandCount,
      maxPayloadLength: options.maxPayloadLength,
    };
    this.#packer = new CommandPacker(this.#statsCounter, packerOptions);
  }

  #takeBufferedCommands(): CommandToWrite[] {
    const buffered = this.#bufferedCommands;
    this.#bufferedCommands = [];
    return buffered;
  }

  #resetPendingSegment(): void {
    this.#pendingChainId = undefined;
    this.#pendingRequiresDrainAtEnd = false;
  }

  #markPendingSegment(meta?: WriteCommandMeta): void {
    this.#pendingChainId = meta?.chainId;
    if (meta?.chainId !== undefined) {
      this.#pendingRequiresDrainAtEnd = true;
    }
  }

  #cancelPendingFlush(): void {
    if (this.#pendingFlush !== null) {
      this.#pendingFlush.cancel();
      this.#pendingFlush = null;
    }
  }

  #shouldUseTimer(): boolean {
    return this.#scheduler !== null && !this.#pendingRequiresDrainAtEnd;
  }

  #scheduleFlushIfNeeded(): void {
    if (
      this.#sink === null ||
      this.#pendingFlush !== null ||
      !this.hasBuffered() ||
      !this.#shouldUseTimer()
    ) {
      return;
    }

    this.#pendingFlush = this.#scheduler!.schedule(this.#maxWaitMs, () => {
      this.#pendingFlush = null;
      try {
        const batch = this.#flushBuffered(FlushReason.TIMER_EXPIRED);
        if (batch !== null) {
          this.#sink!.emit(batch);
        }
      } catch (err) {
        this.#sink?.onError(err);
      }
    });
  }

  #flushBuffered(reason: FlushReason): WriteBatch | null {
    const packed = this.#packer.drain(reason);
    if (packed === null) return null;
    this.#cancelPendingFlush();
    const emittedCommands = this.#takeBufferedCommands();
    this.#resetPendingSegment();
    return {
      writes: [packed],
      emittedCommands
    };
  }

  bind(sink: WriteSink): void {
    this.#sink = sink;
    this.#scheduleFlushIfNeeded();
  }

  static #mergeBatches(left: WriteBatch | null, right: WriteBatch | null): WriteBatch | null {
    if (left === null) return right;
    if (right === null) return left;
    return {
      writes: [...left.writes, ...right.writes],
      emittedCommands: [...left.emittedCommands, ...right.emittedCommands]
    };
  }

  #pushEncoded(
    command: CommandToWrite,
    encoded: SocketChunk,
    args: CommandArguments,
    byteLength?: number,
    chainId?: symbol,
    meta?: WriteCommandMeta
  ): WriteBatch | null {
    let slot: number;

    // Fast path: reuse cached slot for same chain (multi/pipeline)
    // If chainId is set, we trust that all commands in the chain are valid and use the same slot.
    // If user sends invalid commands or different slots in same chain, they'll get server-side errors.
    if (chainId !== undefined && this.#chainSlotCache.has(chainId)) {
      slot = this.#chainSlotCache.get(chainId)!;
    } else {
      // Calculate slot (only once per chain)
      slot = this.#resolver.getSlot(args);

      // Cache for subsequent commands in this chain
      if (chainId !== undefined && slot !== SLOT_INELIGIBLE) {
        this.#chainSlotCache.set(chainId, slot);
      }
    }

    if (slot === SLOT_INELIGIBLE) {
      this.#statsCounter.recordIneligible();
      const pending = this.#flushBuffered(FlushReason.DRAIN);
      if (pending === null) {
        return {
          writes: [encoded],
          emittedCommands: [command]
        };
      }
      return {
        writes: [...pending.writes, encoded],
        emittedCommands: [...pending.emittedCommands, command]
      };
    }

    this.#statsCounter.recordBatchedCommand();

    const payloadLength = byteLength ?? calcPayloadLength(encoded);
    const packed = this.#packer.add(encoded, slot, payloadLength);
    if (!packed) {
      this.#bufferedCommands.push(command);
      this.#markPendingSegment(meta);
      return null;
    }

    this.#cancelPendingFlush();
    const emittedCommands = this.#takeBufferedCommands();
    this.#resetPendingSegment();
    this.#bufferedCommands.push(command);
    this.#markPendingSegment(meta);
    return {
      writes: [packed],
      emittedCommands
    };
  }

  push(
    command: CommandToWrite,
    encoded: SocketChunk,
    args: CommandArguments,
    byteLength?: number,
    meta?: WriteCommandMeta
  ): WriteBatch | null {
    this.#statsCounter.recordCommand();
    const chainId = meta?.chainId;

    // Clear cache when chain changes (to avoid memory leak)
    if (chainId !== this.#lastChainId) {
      if (this.#lastChainId !== undefined) {
        this.#chainSlotCache.delete(this.#lastChainId);
      }
      this.#lastChainId = chainId;
    }

    let batch: WriteBatch | null = null;

    // Flush on chain boundary only when the pending segment already belongs to an explicit pipeline.
    // This preserves the existing behavior where auto-pipelined commands can be absorbed into a later
    // explicit pipeline segment, but explicit segments never leak into the following segment.
    if (this.hasBuffered() && this.#pendingChainId !== undefined && chainId !== this.#pendingChainId) {
      batch = this.drain(FlushReason.DRAIN);
    }

    batch = BinaryHeadersOutboundCodec.#mergeBatches(
      batch,
      this.#pushEncoded(command, encoded, args, byteLength, chainId, meta)
    );

    if (meta?.forceImmediate && this.hasBuffered()) {
      batch = BinaryHeadersOutboundCodec.#mergeBatches(
        batch,
        this.drain(FlushReason.DRAIN)
      );
    }

    this.#scheduleFlushIfNeeded();
    return batch;
  }

  drain(reason: FlushReason): WriteBatch | null {
    this.#cancelPendingFlush();
    return this.#flushBuffered(reason);
  }

  completePushes(): WriteBatch | null {
    if (!this.hasBuffered()) return null;
    if (!this.#shouldUseTimer()) {
      return this.drain(FlushReason.DRAIN);
    }
    this.#scheduleFlushIfNeeded();
    return null;
  }

  hasBuffered(): boolean {
    return this.#packer.bufferSize > 0;
  }

  reset(): CommandToWrite[] {
    this.#cancelPendingFlush();
    this.#packer.reset();
    this.#chainSlotCache.clear();
    this.#lastChainId = undefined;
    this.#resetPendingSegment();
    return this.#takeBufferedCommands();
  }

  destroy(): void {
    this.#cancelPendingFlush();
  }

  stats(): BinaryHeaderStats {
    return this.#statsCounter.snapshot();
  }
}

const HEADER_LENGTH = ResponseHeaderDecoder.ENCODED_LENGTH;
const DESIGNATOR = ResponseHeaderDecoder.designatorConstantValue();
const enum HeaderParseResult {
  CONTINUE,
  INVALID,
  BUFFER_PARTIAL,
}

/**
 * Developer note: inbound state model
 *
 * Decode loop:
 *   [payloadRemaining > 0] -> forward payload bytes
 *   [plain frame in progress OR non-designator at frame boundary] -> consume one plain RESP frame
 *   [designator candidate] -> parse header (valid => BINARY + payloadRemaining)
 */

/**
 * Binary headers inbound codec.
 *
 * - Parses binary header frames from incoming data
 * - Strips headers and forwards payload to decoder
 * - Falls back to passthrough for non-binary-header data
 */
export class BinaryHeadersInboundCodec implements InboundCodec {
  readonly #headerDecoder = new ResponseHeaderDecoder();
  readonly #onHeader: OnHeader | undefined;
  readonly #onProtocolError: OnProtocolError | undefined;
  readonly #plainFrameScanner = new PlainRespFrameScanner();
  #partial: Buffer | null = null;
  #payloadRemaining = 0;

  constructor(options: BinaryHeadersInboundOptions = {}) {
    this.#onHeader = options.onHeader;
    this.#onProtocolError = options.onProtocolError;
  }

  decode(chunk: Buffer, next: (data: Buffer) => void): void {
    this.#decode(chunk, next);
  }

  reset(): void {
    this.#partial = null;
    this.#payloadRemaining = 0;
    this.#plainFrameScanner.reset();
  }

  #decode(chunk: Buffer, emit: (data: Buffer) => void): void {
    const data = this.#partial !== null ? Buffer.concat([this.#partial, chunk]) : chunk;
    this.#partial = null;
    let offset = 0;

    while (offset < data.length) {
      if (this.#payloadRemaining > 0) {
        offset = this.#forwardPayload(data, offset, emit);
        continue;
      }

      if (this.#plainFrameScanner.inProgress || data[offset] !== DESIGNATOR) {
        const plainFrameEnd = this.#consumePlainFrame(data, offset, emit);
        if (plainFrameEnd === -1) {
          return;
        }
        offset = plainFrameEnd;
        continue;
      }

      const result = this.#parseHeader(data, offset);
      if (result === HeaderParseResult.BUFFER_PARTIAL) {
        return;
      }
      if (result === HeaderParseResult.INVALID) {
        emit(data.subarray(offset));
        return;
      }
      offset += HEADER_LENGTH;
    }
  }

  #forwardPayload(data: Buffer, offset: number, emit: (data: Buffer) => void): number {
    const available = data.length - offset;
    const toForward = available < this.#payloadRemaining ? available : this.#payloadRemaining;
    emit(data.subarray(offset, offset + toForward));
    this.#payloadRemaining -= toForward;
    return offset + toForward;
  }

  #consumePlainFrame(data: Buffer, offset: number, emit: (data: Buffer) => void): number {
    const plainFrameEnd = this.#plainFrameScanner.consumeFrameEnd(data, offset);
    if (
      plainFrameEnd === PLAIN_FRAME_NEED_MORE ||
      plainFrameEnd === PLAIN_FRAME_INVALID
    ) {
      emit(data.subarray(offset));
      return -1;
    }
    emit(data.subarray(offset, plainFrameEnd));
    return plainFrameEnd;
  }

  #parseHeader(data: Buffer, offset: number): HeaderParseResult {
    if (data.length - offset < HEADER_LENGTH) {
      this.#partial = data.subarray(offset);
      return HeaderParseResult.BUFFER_PARTIAL;
    }

    this.#headerDecoder.wrap(data, offset);

    if (!this.#headerDecoder.isValid()) {
      return HeaderParseResult.INVALID;
    }

    this.#payloadRemaining = this.#headerDecoder.length();
    this.#plainFrameScanner.reset();

    if (this.#onHeader !== undefined || (this.#onProtocolError !== undefined && this.#headerDecoder.protocolError())) {
      const header = this.#headerDecoder.toObject();
      if (this.#onHeader !== undefined) {
        this.#onHeader(header);
      }
      if (this.#onProtocolError !== undefined && header.protocolError) {
        this.#onProtocolError(header);
      }
    }

    return HeaderParseResult.CONTINUE;
  }
}

/**
 * Binary headers codec combining outbound and inbound processing.
 * This is the main entry point for binary headers support.
 */
export class BinaryHeadersCodec implements WireCodec {
  readonly outbound: BinaryHeadersOutboundCodec;
  readonly inbound: BinaryHeadersInboundCodec;
  readonly #statsCounter: BinaryHeaderStatsCounter;

  constructor(options: BinaryHeadersCodecOptions = {}) {
    this.#statsCounter = options.statsCounter ?? disabledBinaryHeaderStatsCounter();
    this.inbound = new BinaryHeadersInboundCodec(options.inbound);
    this.outbound = new BinaryHeadersOutboundCodec(options.outbound, this.#statsCounter);
  }

  stats(): BinaryHeaderStats {
    return this.#statsCounter.snapshot();
  }
}

/**
 * Factory function to create a WireCodec for binary headers.
 */
export function createBinaryHeadersCodec(
  resolver: EligibilityResolver,
  options?: {
    onHeader?: OnHeader;
    onProtocolError?: OnProtocolError;
    statsCounter?: BinaryHeaderStatsCounter;
  }
): WireCodec {
  return new BinaryHeadersCodec({
    outbound: {
      resolver,
    },
    inbound: {
      onHeader: options?.onHeader,
      onProtocolError: options?.onProtocolError,
    },
    statsCounter: options?.statsCounter,
  });
}
