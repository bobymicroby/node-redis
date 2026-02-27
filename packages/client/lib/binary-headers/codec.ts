import type { OutboundInterceptor, InboundInterceptor, WireInterceptor, SocketChunk, SocketChunks, CommandArguments } from '../client/commands-queue';
import type { EligibilityResolver } from './eligibility';
import { SLOT_INELIGIBLE, NOOP_RESOLVER } from './eligibility';
import { CommandPacker, calculatePayloadLength as calcPayloadLength, type CommandPackerOptions } from './packing';
import { ResponseHeaderDecoder, type ResponseHeader as BinaryResponseHeader } from './generated/response-header-codec';
import { FlushReason, disabledBinaryHeaderStatsCounter, type BinaryHeaderStatsCounter, type BinaryHeaderStats } from './stats';

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

  intercept(encoded: SocketChunk, args: CommandArguments, byteLength?: number, chainId?: symbol): SocketChunks {
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
      const pending = this.#packer.drain(FlushReason.DRAIN);
      return pending ? [pending, encoded] : [encoded];
    }

    this.#statsCounter.recordBatchedCommand();

    const payloadLength = byteLength ?? calcPayloadLength(encoded);
    const packed = this.#packer.add(encoded, slot, payloadLength);
    return packed ? [packed] : [];
  }

  flush(reason: FlushReason): SocketChunk | null {
    return this.#packer.drain(reason);
  }

  hasPending(): boolean {
    return this.#packer.bufferSize > 0;
  }

  stats(): BinaryHeaderStats {
    return this.#statsCounter.snapshot();
  }
}

const HEADER_LENGTH = ResponseHeaderDecoder.ENCODED_LENGTH;
const DESIGNATOR = ResponseHeaderDecoder.designatorConstantValue();
const CR = 0x0D;
const LF = 0x0A;

const enum ParseResult {
  CONTINUE,
  PASSTHROUGH,
  BUFFER_PARTIAL,
}

const enum InboundMode {
  UNKNOWN,
  PLAIN,
  BINARY,
}

const enum PlainParseState {
  EXPECT_TYPE,
  READ_SIMPLE_LINE,
  READ_LENGTH_LINE,
  READ_BOOLEAN_VALUE,
  EXPECT_BOOLEAN_CR,
  EXPECT_BOOLEAN_LF,
  EXPECT_NULL_CR,
  EXPECT_NULL_LF,
  READ_BULK_DATA,
  EXPECT_BULK_CR,
  EXPECT_BULK_LF,
}

const enum PlainLengthKind {
  BULK,
  AGGREGATE,
}

const enum PlainConsumeResult {
  CONTINUE,
  COMPLETE,
  INVALID,
}

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
  #plainProbeActive = false;
  #plainParseState = PlainParseState.EXPECT_TYPE;
  #plainLine = '';
  #plainSawCR = false;
  #plainBulkRemaining = 0;
  #plainLengthKind: PlainLengthKind = PlainLengthKind.BULK;
  #plainAggregateMultiplier = 1;
  readonly #plainContainerRemaining: number[] = [];
  #partial: Buffer | null = null;
  #payloadRemaining = 0;
  #mode = InboundMode.UNKNOWN;

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
    this.#mode = InboundMode.UNKNOWN;
    this.#resetPlainProbe();
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

      // If a plain RESP frame was started in a previous chunk while in binary mode,
      // continue consuming it even if this chunk starts with 0x80.
      if (this.#mode === InboundMode.BINARY && this.#plainProbeActive) {
        const plainFrameEnd = this.#findPlainFrameEnd(data, offset);
        if (plainFrameEnd === -1) {
          emit(data.subarray(offset));
          return;
        }

        emit(data.subarray(offset, plainFrameEnd));
        offset = plainFrameEnd;
        continue;
      }

      if (data[offset] !== DESIGNATOR) {
        // Once binary mode is observed, plain RESP and binhdr frames may coalesce in one chunk.
        // Consume exactly one plain RESP frame, then continue scanning for the next header.
        if (this.#mode === InboundMode.BINARY) {
          const plainFrameEnd = this.#findPlainFrameEnd(data, offset);
          if (plainFrameEnd === -1) {
            emit(data.subarray(offset));
            return;
          }

          emit(data.subarray(offset, plainFrameEnd));
          offset = plainFrameEnd;
          continue;
        }

        // Pre-binary mode: any non-designator data means plain RESP path.
        if (this.#mode === InboundMode.UNKNOWN) {
          this.#mode = InboundMode.PLAIN;
        }
        emit(data.subarray(offset));
        return;
      }

      // Pre-binary mode was already classified as plain: never probe header candidates.
      if (this.#mode === InboundMode.PLAIN) {
        emit(data.subarray(offset));
        return;
      }

      const result = this.#parseHeader(data, offset, emit);
      if (result === ParseResult.PASSTHROUGH || result === ParseResult.BUFFER_PARTIAL) {
        if (result === ParseResult.PASSTHROUGH && this.#mode === InboundMode.UNKNOWN) {
          this.#mode = InboundMode.PLAIN;
        }
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

  #findPlainFrameEnd(data: Buffer, startOffset: number): number {
    for (let i = startOffset; i < data.length; i++) {
      const consume = this.#consumePlainByte(data[i]);
      if (consume === PlainConsumeResult.INVALID) {
        this.#resetPlainProbe();
        return -1;
      }
      if (consume === PlainConsumeResult.COMPLETE) {
        this.#resetPlainProbe();
        return i + 1;
      }
    }

    this.#plainProbeActive = true;
    return -1;
  }

  #resetPlainProbe(): void {
    this.#plainParseState = PlainParseState.EXPECT_TYPE;
    this.#plainLine = '';
    this.#plainSawCR = false;
    this.#plainBulkRemaining = 0;
    this.#plainLengthKind = PlainLengthKind.BULK;
    this.#plainAggregateMultiplier = 1;
    this.#plainContainerRemaining.length = 0;
    this.#plainProbeActive = false;
  }

  #consumePlainByte(byte: number): PlainConsumeResult {
    switch (this.#plainParseState) {
      case PlainParseState.EXPECT_TYPE:
        return this.#consumePlainType(byte);

      case PlainParseState.READ_SIMPLE_LINE:
        return this.#consumeSimpleLineByte(byte);

      case PlainParseState.READ_LENGTH_LINE:
        return this.#consumeLengthLineByte(byte);

      case PlainParseState.READ_BOOLEAN_VALUE:
        this.#plainParseState = PlainParseState.EXPECT_BOOLEAN_CR;
        return PlainConsumeResult.CONTINUE;

      case PlainParseState.EXPECT_BOOLEAN_CR:
        if (byte !== CR) return PlainConsumeResult.INVALID;
        this.#plainParseState = PlainParseState.EXPECT_BOOLEAN_LF;
        return PlainConsumeResult.CONTINUE;

      case PlainParseState.EXPECT_BOOLEAN_LF:
        if (byte !== LF) return PlainConsumeResult.INVALID;
        return this.#onPlainValueComplete();

      case PlainParseState.EXPECT_NULL_CR:
        if (byte !== CR) return PlainConsumeResult.INVALID;
        this.#plainParseState = PlainParseState.EXPECT_NULL_LF;
        return PlainConsumeResult.CONTINUE;

      case PlainParseState.EXPECT_NULL_LF:
        if (byte !== LF) return PlainConsumeResult.INVALID;
        return this.#onPlainValueComplete();

      case PlainParseState.READ_BULK_DATA:
        this.#plainBulkRemaining--;
        if (this.#plainBulkRemaining === 0) {
          this.#plainParseState = PlainParseState.EXPECT_BULK_CR;
        }
        return PlainConsumeResult.CONTINUE;

      case PlainParseState.EXPECT_BULK_CR:
        if (byte !== CR) return PlainConsumeResult.INVALID;
        this.#plainParseState = PlainParseState.EXPECT_BULK_LF;
        return PlainConsumeResult.CONTINUE;

      case PlainParseState.EXPECT_BULK_LF:
        if (byte !== LF) return PlainConsumeResult.INVALID;
        return this.#onPlainValueComplete();

      default:
        return PlainConsumeResult.INVALID;
    }
  }

  #consumePlainType(byte: number): PlainConsumeResult {
    switch (byte) {
      case 0x2B: // +
      case 0x2D: // -
      case 0x3A: // :
      case 0x2C: // ,
      case 0x28: // (
        this.#plainParseState = PlainParseState.READ_SIMPLE_LINE;
        this.#plainSawCR = false;
        return PlainConsumeResult.CONTINUE;

      case 0x23: // #
        this.#plainParseState = PlainParseState.READ_BOOLEAN_VALUE;
        return PlainConsumeResult.CONTINUE;

      case 0x5F: // _
        this.#plainParseState = PlainParseState.EXPECT_NULL_CR;
        return PlainConsumeResult.CONTINUE;

      case 0x24: // $
      case 0x21: // !
      case 0x3D: // =
        this.#plainParseState = PlainParseState.READ_LENGTH_LINE;
        this.#plainLengthKind = PlainLengthKind.BULK;
        this.#plainAggregateMultiplier = 1;
        this.#plainLine = '';
        this.#plainSawCR = false;
        return PlainConsumeResult.CONTINUE;

      case 0x2A: // *
      case 0x7E: // ~
      case 0x3E: // >
        this.#plainParseState = PlainParseState.READ_LENGTH_LINE;
        this.#plainLengthKind = PlainLengthKind.AGGREGATE;
        this.#plainAggregateMultiplier = 1;
        this.#plainLine = '';
        this.#plainSawCR = false;
        return PlainConsumeResult.CONTINUE;

      case 0x25: // %
        this.#plainParseState = PlainParseState.READ_LENGTH_LINE;
        this.#plainLengthKind = PlainLengthKind.AGGREGATE;
        this.#plainAggregateMultiplier = 2;
        this.#plainLine = '';
        this.#plainSawCR = false;
        return PlainConsumeResult.CONTINUE;

      default:
        return PlainConsumeResult.INVALID;
    }
  }

  #consumeSimpleLineByte(byte: number): PlainConsumeResult {
    if (!this.#plainSawCR) {
      if (byte === CR) {
        this.#plainSawCR = true;
      }
      return PlainConsumeResult.CONTINUE;
    }

    if (byte !== LF) {
      this.#plainSawCR = false;
      return PlainConsumeResult.CONTINUE;
    }

    return this.#onPlainValueComplete();
  }

  #consumeLengthLineByte(byte: number): PlainConsumeResult {
    if (!this.#plainSawCR) {
      if (byte === CR) {
        this.#plainSawCR = true;
      } else {
        this.#plainLine += String.fromCharCode(byte);
      }
      return PlainConsumeResult.CONTINUE;
    }

    if (byte !== LF) {
      return PlainConsumeResult.INVALID;
    }

    const length = Number(this.#plainLine);
    if (!Number.isInteger(length)) {
      return PlainConsumeResult.INVALID;
    }

    this.#plainLine = '';
    this.#plainSawCR = false;

    if (this.#plainLengthKind === PlainLengthKind.BULK) {
      if (length < -1) {
        return PlainConsumeResult.INVALID;
      }
      if (length === -1) {
        return this.#onPlainValueComplete();
      }
      if (length === 0) {
        this.#plainParseState = PlainParseState.EXPECT_BULK_CR;
      } else {
        this.#plainParseState = PlainParseState.READ_BULK_DATA;
        this.#plainBulkRemaining = length;
      }
      return PlainConsumeResult.CONTINUE;
    }

    if (length < -1) {
      return PlainConsumeResult.INVALID;
    }
    if (length <= 0) {
      return this.#onPlainValueComplete();
    }

    this.#plainContainerRemaining.push(length * this.#plainAggregateMultiplier);
    this.#plainParseState = PlainParseState.EXPECT_TYPE;
    return PlainConsumeResult.CONTINUE;
  }

  #onPlainValueComplete(): PlainConsumeResult {
    this.#plainParseState = PlainParseState.EXPECT_TYPE;
    this.#plainLine = '';
    this.#plainSawCR = false;
    this.#plainBulkRemaining = 0;

    while (this.#plainContainerRemaining.length > 0) {
      const idx = this.#plainContainerRemaining.length - 1;
      const remaining = this.#plainContainerRemaining[idx] - 1;
      this.#plainContainerRemaining[idx] = remaining;
      if (remaining > 0) {
        return PlainConsumeResult.CONTINUE;
      }
      this.#plainContainerRemaining.pop();
    }

    return PlainConsumeResult.COMPLETE;
  }

  #parseHeader(data: Buffer, offset: number, emit: (data: Buffer) => void): ParseResult {
    if (data[offset] !== DESIGNATOR) {
      emit(data.subarray(offset));
      return ParseResult.PASSTHROUGH;
    }

    if (data.length - offset < HEADER_LENGTH) {
      this.#partial = data.subarray(offset);
      return ParseResult.BUFFER_PARTIAL;
    }

    this.#headerDecoder.wrap(data, offset);

    if (!this.#headerDecoder.isValid()) {
      emit(data.subarray(offset));
      return ParseResult.PASSTHROUGH;
    }

    this.#payloadRemaining = this.#headerDecoder.length();
    this.#mode = InboundMode.BINARY;
    this.#resetPlainProbe();

    if (this.#onHeader !== undefined || (this.#onProtocolError !== undefined && this.#headerDecoder.protocolError())) {
      const header = this.#headerDecoder.toObject();
      if (this.#onHeader !== undefined) {
        this.#onHeader(header);
      }
      if (this.#onProtocolError !== undefined && header.protocolError) {
        this.#onProtocolError(header);
      }
    }

    return ParseResult.CONTINUE;
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
    this.outbound = new BinaryHeadersOutboundInterceptor(options.outbound, this.#statsCounter);
    this.inbound = new BinaryHeadersInboundInterceptor(options.inbound);
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
