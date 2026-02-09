import type { OutboundInterceptor, InboundInterceptor, WireInterceptor, SocketChunk, SocketChunks, CommandArguments } from '../client/commands-queue';
import type { EligibilityResolver } from './eligibility';
import { SLOT_INELIGIBLE, NOOP_RESOLVER } from './eligibility';
import { CommandPacker, calculatePayloadLength } from './packing';
import { ResponseHeaderDecoder, type ResponseHeader as BinaryResponseHeader } from './generated/response-header-codec';
import { FlushReason, disabledBinaryHeaderStatsCounter, type BinaryHeaderStatsCounter, type BinaryHeaderStats } from './stats';

export type OnHeader = (header: BinaryResponseHeader) => void;
export type OnProtocolError = (header: BinaryResponseHeader) => void;

export interface BinaryHeadersOutboundOptions {
  readonly resolver?: EligibilityResolver;
  readonly maxWaitMs?: number;
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

  constructor(
    options: BinaryHeadersOutboundOptions = {},
    statsCounter?: BinaryHeaderStatsCounter
  ) {
    this.#statsCounter = statsCounter ?? disabledBinaryHeaderStatsCounter();
    this.#resolver = options.resolver ?? NOOP_RESOLVER;
    this.#packer = new CommandPacker(options.maxWaitMs ?? null, this.#statsCounter);
  }

  intercept(encoded: SocketChunk, args: CommandArguments): SocketChunks {
    this.#statsCounter.recordCommand();

    const slot = this.#resolver.getSlot(args);

    if (slot === SLOT_INELIGIBLE) {
      this.#statsCounter.recordIneligible();
      const pending = this.#packer.drain(FlushReason.DRAIN);
      return pending ? [pending, encoded] : [encoded];
    }

    this.#statsCounter.recordBatchedCommand();

    const packed = this.#packer.add(encoded, slot, calculatePayloadLength(encoded));
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

const enum ParseResult {
  CONTINUE,
  PASSTHROUGH,
  BUFFER_PARTIAL,
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

      const result = this.#parseHeader(data, offset, emit);
      if (result === ParseResult.PASSTHROUGH || result === ParseResult.BUFFER_PARTIAL) {
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
    maxWaitMs?: number;
    onHeader?: OnHeader;
    onProtocolError?: OnProtocolError;
    statsCounter?: BinaryHeaderStatsCounter;
  }
): WireInterceptor {
  return new BinaryHeadersInterceptor({
    outbound: {
      resolver,
      maxWaitMs: options?.maxWaitMs,
    },
    inbound: {
      onHeader: options?.onHeader,
      onProtocolError: options?.onProtocolError,
    },
    statsCounter: options?.statsCounter,
  });
}
