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

const INTERNAL_BINARY_FRAME_PRODUCED = Symbol('binaryHeadersOutboundOnBinaryFrameProduced');
const INTERNAL_INBOUND_MODE_STATE = Symbol('binaryHeadersInboundModeState');
type BinaryResponseModeState = {
  mayReceiveBinaryFrames: boolean;
};
type InternalOutboundOptions = BinaryHeadersOutboundOptions & {
  [INTERNAL_BINARY_FRAME_PRODUCED]?: () => void;
};
type InternalInboundOptions = BinaryHeadersInboundOptions & {
  [INTERNAL_INBOUND_MODE_STATE]?: BinaryResponseModeState;
};

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
  readonly #onBinaryFrameProduced: (() => void) | undefined;
  #chainSlotCache: Map<symbol, number> = new Map();
  #lastChainId: symbol | undefined;

  constructor(
    options: BinaryHeadersOutboundOptions = {},
    statsCounter?: BinaryHeaderStatsCounter
  ) {
    this.#statsCounter = statsCounter ?? disabledBinaryHeaderStatsCounter();
    this.#resolver = options.resolver ?? NOOP_RESOLVER;
    this.#onBinaryFrameProduced = (options as InternalOutboundOptions)[INTERNAL_BINARY_FRAME_PRODUCED];
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
      if (!pending) {
        return [encoded];
      }

      this.#onBinaryFrameProduced?.();
      return [pending, encoded];
    }

    this.#statsCounter.recordBatchedCommand();

    const payloadLength = byteLength ?? calcPayloadLength(encoded);
    const packed = this.#packer.add(encoded, slot, payloadLength);
    if (!packed) {
      return [];
    }

    this.#onBinaryFrameProduced?.();
    return [packed];
  }

  flush(reason: FlushReason): SocketChunk | null {
    const packed = this.#packer.drain(reason);
    if (packed) {
      this.#onBinaryFrameProduced?.();
    }
    return packed;
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
const MINUS = 0x2D;
const ASCII_ZERO = 0x30;
const ASCII_NINE = 0x39;
const BOOL_TRUE = 0x74;
const BOOL_FALSE = 0x66;
const RESP_SIMPLE_STRING = 0x2B; // +
const RESP_SIMPLE_ERROR = 0x2D; // -
const RESP_INTEGER = 0x3A; // :
const RESP_DOUBLE = 0x2C; // ,
const RESP_BIG_NUMBER = 0x28; // (
const RESP_BOOLEAN = 0x23; // #
const RESP_NULL = 0x5F; // _
const RESP_BLOB_STRING = 0x24; // $
const RESP_BLOB_ERROR = 0x21; // !
const RESP_VERBATIM_STRING = 0x3D; // =
const RESP_ARRAY = 0x2A; // *
const RESP_SET = 0x7E; // ~
const RESP_PUSH = 0x3E; // >
const RESP_MAP = 0x25; // %

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
  // Await a RESP type byte for the next plain value/frame.
  EXPECT_TYPE,
  // Read until CRLF (for +, -, :, ,, () values).
  READ_SIMPLE_LINE,
  // Read a signed length line until CRLF (for $, !, =, *, ~, >, %).
  READ_LENGTH_LINE,
  // Read single boolean token byte (t/f), then CRLF.
  READ_BOOLEAN_VALUE,
  EXPECT_BOOLEAN_CR,
  EXPECT_BOOLEAN_LF,
  // Read RESP null terminator "_\r\n".
  EXPECT_NULL_CR,
  EXPECT_NULL_LF,
  // Read fixed-size blob payload, then CRLF terminator.
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
 * Developer note: inbound state model
 *
 * Top-level mode transitions:
 *   UNKNOWN --(valid binary header)--> BINARY
 *   UNKNOWN --(non-designator byte)--> PLAIN
 *   PLAIN   --(binary responses expected + valid header)--> BINARY
 *   PLAIN   --(otherwise)-------------------------------> PLAIN
 *   BINARY  --(mixed plain frame)-----> BINARY
 *
 * Decode loop (high level):
 *   [payloadRemaining > 0] -> forward payload bytes
 *   [UNKNOWN/PLAIN pre-binary plain frame] -> consume one plain RESP frame
 *   [BINARY and (plain frame in progress or non-designator)] -> consume one plain RESP frame
 *   [non-designator fallback] -> passthrough tail
 *   [designator candidate] -> parse header (valid => BINARY + payloadRemaining)
 *
 * Plain-frame sub-state machine (used only by BINARY mixed fallback):
 *   EXPECT_TYPE
 *     -> READ_SIMPLE_LINE   (+ - : , ()
 *     -> READ_BOOLEAN_VALUE (#)
 *     -> EXPECT_NULL_CR     (_)
 *     -> READ_LENGTH_LINE   ($ ! = * ~ > %)
 *
 *   READ_SIMPLE_LINE -> COMPLETE on CRLF
 *   READ_BOOLEAN_VALUE -> EXPECT_BOOLEAN_CR -> EXPECT_BOOLEAN_LF -> COMPLETE
 *   EXPECT_NULL_CR -> EXPECT_NULL_LF -> COMPLETE
 *
 *   READ_LENGTH_LINE
 *     bulk-like ($ ! =):
 *       len == -1 -> COMPLETE
 *       len >= 0  -> READ_BULK_DATA -> EXPECT_BULK_CR -> EXPECT_BULK_LF -> COMPLETE
 *     aggregate-like (* ~ > %):
 *       len <= 0  -> COMPLETE
 *       len > 0   -> push remaining child count, loop through EXPECT_TYPE until exhausted
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
  readonly #modeState: BinaryResponseModeState;
  // True when a plain RESP frame began in binary mode but has not completed yet.
  #plainFrameInProgress = false;
  #plainParseState = PlainParseState.EXPECT_TYPE;
  #plainSawCR = false;
  #plainLengthValue = 0;
  #plainLengthNegative = false;
  #plainLengthHasDigit = false;
  #plainBulkRemaining = 0;
  #plainLengthKind: PlainLengthKind = PlainLengthKind.BULK;
  #plainAggregateMultiplier = 1;
  readonly #plainContainerRemaining: number[] = [];
  #partial: Buffer | null = null;
  #payloadRemaining = 0;
  #mode = InboundMode.UNKNOWN;

  constructor(options: BinaryHeadersInboundOptions = {}) {
    const internalOptions = options as InternalInboundOptions;
    this.#onHeader = internalOptions.onHeader;
    this.#onProtocolError = internalOptions.onProtocolError;
    this.#modeState = internalOptions[INTERNAL_INBOUND_MODE_STATE] ?? { mayReceiveBinaryFrames: false };
  }

  intercept(chunk: Buffer, next: (data: Buffer) => void): void {
    this.#decode(chunk, next);
  }

  reset(): void {
    this.#partial = null;
    this.#payloadRemaining = 0;
    this.#mode = InboundMode.UNKNOWN;
    this.#modeState.mayReceiveBinaryFrames = false;
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

      // Before binary mode is established, consume RESP plain frames so we can
      // track frame boundaries across chunks and safely probe future header candidates.
      if (
        this.#mode !== InboundMode.BINARY &&
        (
          this.#plainFrameInProgress ||
          this.#shouldConsumePreBinaryAsPlain(data[offset])
        )
      ) {
        const plainFrameEnd = this.#consumePreBinaryPlainFrame(data, offset, emit);
        if (plainFrameEnd === -1) {
          return;
        }
        offset = plainFrameEnd;
        continue;
      }

      // Once binary mode is observed, plain RESP and binhdr frames may coalesce in one chunk.
      // Consume exactly one plain RESP frame, then continue scanning for the next header.
      // This path also handles the continuation of plain frames split across chunks.
      if (this.#mode === InboundMode.BINARY && (this.#plainFrameInProgress || data[offset] !== DESIGNATOR)) {
        const plainFrameEnd = this.#consumePlainFrame(data, offset, emit);
        if (plainFrameEnd === -1) {
          return;
        }
        offset = plainFrameEnd;
        continue;
      }

      if (data[offset] !== DESIGNATOR) {
        this.#emitPreBinaryPassthroughAndLockMode(data, offset, emit);
        return;
      }

      // Plain mode can recover to binary only after outbound emitted at least one
      // binary request frame. Otherwise, keep passthrough behavior to avoid false
      // header probes in plain traffic.
      if (this.#mode === InboundMode.PLAIN && !this.#modeState.mayReceiveBinaryFrames) {
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

  #shouldConsumePreBinaryAsPlain(byte: number): boolean {
    if (byte !== DESIGNATOR) {
      return true;
    }

    if (this.#mode === InboundMode.UNKNOWN) {
      return false;
    }

    return !this.#modeState.mayReceiveBinaryFrames;
  }

  #forwardPayload(data: Buffer, offset: number, emit: (data: Buffer) => void): number {
    const available = data.length - offset;
    const toForward = available < this.#payloadRemaining ? available : this.#payloadRemaining;
    emit(data.subarray(offset, offset + toForward));
    this.#payloadRemaining -= toForward;
    return offset + toForward;
  }

  #emitPreBinaryPassthroughAndLockMode(data: Buffer, offset: number, emit: (data: Buffer) => void): void {
    // Once we see a non-designator before any valid binary frame, stay in plain mode.
    if (this.#mode === InboundMode.UNKNOWN) {
      this.#mode = InboundMode.PLAIN;
    }
    emit(data.subarray(offset));
  }

  #consumePreBinaryPlainFrame(data: Buffer, offset: number, emit: (data: Buffer) => void): number {
    if (this.#mode === InboundMode.UNKNOWN) {
      this.#mode = InboundMode.PLAIN;
    }
    return this.#consumePlainFrame(data, offset, emit);
  }

  #consumePlainFrame(data: Buffer, offset: number, emit: (data: Buffer) => void): number {
    const plainFrameEnd = this.#consumePlainFrameEnd(data, offset);
    if (plainFrameEnd === -1) {
      emit(data.subarray(offset));
      return -1;
    }
    emit(data.subarray(offset, plainFrameEnd));
    return plainFrameEnd;
  }

  #consumePlainFrameEnd(data: Buffer, startOffset: number): number {
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

    this.#plainFrameInProgress = true;
    return -1;
  }

  #resetPlainProbe(): void {
    // Invariant: reset to parser-start state and clear all pending per-frame metadata.
    this.#plainParseState = PlainParseState.EXPECT_TYPE;
    this.#plainSawCR = false;
    this.#resetPlainLengthParser();
    this.#plainBulkRemaining = 0;
    this.#plainLengthKind = PlainLengthKind.BULK;
    this.#plainAggregateMultiplier = 1;
    this.#plainContainerRemaining.length = 0;
    this.#plainFrameInProgress = false;
  }

  #resetPlainLengthParser(): void {
    this.#plainLengthValue = 0;
    this.#plainLengthNegative = false;
    this.#plainLengthHasDigit = false;
  }

  #startPlainLengthLine(kind: PlainLengthKind, aggregateMultiplier: number): PlainConsumeResult {
    this.#plainParseState = PlainParseState.READ_LENGTH_LINE;
    this.#plainLengthKind = kind;
    this.#plainAggregateMultiplier = aggregateMultiplier;
    this.#plainSawCR = false;
    this.#resetPlainLengthParser();
    return PlainConsumeResult.CONTINUE;
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
        if (byte !== BOOL_TRUE && byte !== BOOL_FALSE) return PlainConsumeResult.INVALID;
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
      case RESP_SIMPLE_STRING:
      case RESP_SIMPLE_ERROR:
      case RESP_INTEGER:
      case RESP_DOUBLE:
      case RESP_BIG_NUMBER:
        this.#plainParseState = PlainParseState.READ_SIMPLE_LINE;
        this.#plainSawCR = false;
        return PlainConsumeResult.CONTINUE;

      case RESP_BOOLEAN:
        this.#plainParseState = PlainParseState.READ_BOOLEAN_VALUE;
        return PlainConsumeResult.CONTINUE;

      case RESP_NULL:
        this.#plainParseState = PlainParseState.EXPECT_NULL_CR;
        return PlainConsumeResult.CONTINUE;

      case RESP_BLOB_STRING:
      case RESP_BLOB_ERROR:
      case RESP_VERBATIM_STRING:
        return this.#startPlainLengthLine(PlainLengthKind.BULK, 1);

      case RESP_ARRAY:
      case RESP_SET:
      case RESP_PUSH:
        return this.#startPlainLengthLine(PlainLengthKind.AGGREGATE, 1);

      case RESP_MAP:
        return this.#startPlainLengthLine(PlainLengthKind.AGGREGATE, 2);

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
        if (!this.#plainLengthHasDigit) {
          return PlainConsumeResult.INVALID;
        }
        this.#plainSawCR = true;
      } else {
        if (
          byte === MINUS &&
          !this.#plainLengthHasDigit &&
          !this.#plainLengthNegative &&
          this.#plainLengthValue === 0
        ) {
          this.#plainLengthNegative = true;
          return PlainConsumeResult.CONTINUE;
        }
        if (byte < ASCII_ZERO || byte > ASCII_NINE) {
          return PlainConsumeResult.INVALID;
        }
        this.#plainLengthHasDigit = true;
        this.#plainLengthValue = this.#plainLengthValue * 10 + (byte - ASCII_ZERO);
      }
      return PlainConsumeResult.CONTINUE;
    }

    if (byte !== LF) {
      return PlainConsumeResult.INVALID;
    }

    const length = this.#plainLengthNegative ? -this.#plainLengthValue : this.#plainLengthValue;
    this.#plainSawCR = false;
    this.#resetPlainLengthParser();

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
    // Invariant: after a value completes, parser points at the next type byte
    // unless we are still inside an aggregate container.
    this.#plainParseState = PlainParseState.EXPECT_TYPE;
    this.#plainSawCR = false;
    this.#resetPlainLengthParser();
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
    const modeState: BinaryResponseModeState = {
      mayReceiveBinaryFrames: false
    };
    const inboundOptions: InternalInboundOptions = {
      ...(options.inbound ?? {})
    };
    inboundOptions[INTERNAL_INBOUND_MODE_STATE] = modeState;
    this.inbound = new BinaryHeadersInboundInterceptor(inboundOptions);
    const outboundOptions: InternalOutboundOptions = {
      ...(options.outbound ?? {})
    };
    outboundOptions[INTERNAL_BINARY_FRAME_PRODUCED] = () => {
      modeState.mayReceiveBinaryFrames = true;
    };
    this.outbound = new BinaryHeadersOutboundInterceptor(
      outboundOptions,
      this.#statsCounter
    );
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
