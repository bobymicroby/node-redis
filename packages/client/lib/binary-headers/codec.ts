import type {
  OutboundInterceptor,
  InboundInterceptor,
  WireInterceptor,
  SocketChunk,
  SocketChunks,
  CommandArguments,
  CommandToWrite,
  OutboundBatch
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
}

export interface BinaryHeadersInboundOptions {
  readonly onHeader?: OnHeader;
  readonly onProtocolError?: OnProtocolError;
}

export interface BinaryHeadersInterceptorOptions {
  readonly outbound?: BinaryHeadersOutboundOptions;
  readonly inbound?: BinaryHeadersInboundOptions;
  readonly statsCounter?: BinaryHeaderStatsCounter;
}

/**
 * Binary headers outbound interceptor.
 *
 * Intercepts outbound commands to batch eligible ones with binary headers.
 * Uses the resolver to determine eligibility and the packer to batch by slot.
 *
 * Batching behavior:
 * - Eligible commands accumulate in a buffer until a flush is triggered
 * - Flush triggers: slot change, max commands reached, timer expiry, or ineligible command
 * - Ineligible commands always pass through unchanged, but first flush any pending batch
 * - This preserves command ordering while maximizing batching opportunities
 *
 * What write() returns in different scenarios:
 * - Eligible, still buffering        → [] (nothing to send yet)
 * - Eligible, triggers flush         → [packed] (batch with binary header)
 * - Ineligible, nothing pending      → [encoded] (passthrough as-is)
 * - Ineligible, pending batch exists → [pending, encoded] (flush first, then passthrough)
 */
export class BinaryHeadersOutboundInterceptor implements OutboundInterceptor {
  readonly #resolver: EligibilityResolver;
  readonly #packer: CommandPacker;
  readonly #statsCounter: BinaryHeaderStatsCounter;
  #chainSlotCache: Map<symbol, number> = new Map();
  #lastChainId: symbol | undefined;
  #bufferedCommands: CommandToWrite[] = [];

  constructor(
    options: BinaryHeadersOutboundOptions = {},
    statsCounter?: BinaryHeaderStatsCounter
  ) {
    this.#statsCounter = statsCounter ?? disabledBinaryHeaderStatsCounter();
    this.#resolver = options.resolver ?? NOOP_RESOLVER;
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

  #flushBuffered(reason: FlushReason): OutboundBatch | null {
    const packed = this.#packer.drain(reason);
    if (packed === null) return null;
    return {
      writes: [packed],
      sent: this.#takeBufferedCommands()
    };
  }

  intercept(
    command: CommandToWrite,
    encoded: SocketChunk,
    args: CommandArguments,
    byteLength?: number,
    chainId?: symbol
  ): OutboundBatch | null {
    this.#statsCounter.recordCommand();

    // Clear cache when chain changes (to avoid memory leak)
    if (chainId !== this.#lastChainId) {
      if (this.#lastChainId !== undefined) {
        this.#chainSlotCache.delete(this.#lastChainId);
      }
      this.#lastChainId = chainId;
    }

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
          sent: [command]
        };
      }
      return {
        writes: [...pending.writes, encoded],
        sent: [...pending.sent, command]
      };
    }

    this.#statsCounter.recordBatchedCommand();

    const payloadLength = byteLength ?? calcPayloadLength(encoded);
    const packed = this.#packer.add(encoded, slot, payloadLength);
    if (!packed) {
      this.#bufferedCommands.push(command);
      return null;
    }
    const sent = this.#takeBufferedCommands();
    this.#bufferedCommands.push(command);
    return {
      writes: [packed],
      sent
    };
  }

  flush(reason: FlushReason): OutboundBatch | null {
    return this.#flushBuffered(reason);
  }

  hasPending(): boolean {
    return this.#packer.bufferSize > 0;
  }

  reset(): CommandToWrite[] {
    this.#packer.reset();
    this.#chainSlotCache.clear();
    this.#lastChainId = undefined;
    return this.#takeBufferedCommands();
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
 * Binary headers inbound interceptor.
 *
 * - Parses binary header frames from incoming data
 * - Strips headers and forwards payload to decoder
 * - Falls back to passthrough for non-binary-header data
 */
export class BinaryHeadersInboundInterceptor implements InboundInterceptor {
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

  intercept(chunk: Buffer, next: (data: Buffer) => void): void {
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
 * Binary headers interceptor combining outbound and inbound processing.
 * This is the main entry point for binary headers support.
 */
export class BinaryHeadersInterceptor implements WireInterceptor {
  readonly outbound: BinaryHeadersOutboundInterceptor;
  readonly inbound: BinaryHeadersInboundInterceptor;
  readonly #statsCounter: BinaryHeaderStatsCounter;

  constructor(options: BinaryHeadersInterceptorOptions = {}) {
    this.#statsCounter = options.statsCounter ?? disabledBinaryHeaderStatsCounter();
    this.inbound = new BinaryHeadersInboundInterceptor(options.inbound);
    this.outbound = new BinaryHeadersOutboundInterceptor(options.outbound, this.#statsCounter);
  }

  stats(): BinaryHeaderStats {
    return this.#statsCounter.snapshot();
  }
}

/**
 * Factory function to create a WireInterceptor for binary headers.
 */
export function createBinaryHeadersInterceptor(
  resolver: EligibilityResolver,
  options?: {
    onHeader?: OnHeader;
    onProtocolError?: OnProtocolError;
    statsCounter?: BinaryHeaderStatsCounter;
  }
): WireInterceptor {
  return new BinaryHeadersInterceptor({
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
