/**
 * Binary Headers Codec Implementation
 *
 * Standalone codec that can be passed to RedisCommandsQueue.
 */

import type { RedisArgument } from '../RESP/types';
import type { Decoder } from '../RESP/decoder';
import type { OutboundCodec, InboundCodec, CommandCodec } from '../client/commands-queue';
import type { EligibilityResolver } from './eligibility-resolver';
import { SLOT_INELIGIBLE, NOOP_RESOLVER } from './eligibility-resolver';
import { CommandPacker, calculatePayloadLength } from './packing';
import { ResponseHeaderDecoder, type ResponseHeader as BinaryResponseHeader } from './generated/response-header-codec';

// ============================================================================
// Types
// ============================================================================

export type OnHeader = (header: BinaryResponseHeader) => void;
export type OnProtocolError = (header: BinaryResponseHeader) => void;
export type PayloadSink = (data: Buffer) => void;

export interface InboundDecoderOptions {
  readonly onHeader?: OnHeader;
  readonly onProtocolError?: OnProtocolError;
}

// ============================================================================
// Options
// ============================================================================

export interface BinaryHeadersOutboundOptions {
  readonly resolver?: EligibilityResolver;
  readonly maxWaitMs?: number;
}

export interface BinaryHeadersInboundOptions {
  readonly onProtocolError?: (requestId: number) => void;
}

export interface BinaryHeadersCodecOptions {
  readonly outbound?: BinaryHeadersOutboundOptions;
  readonly inbound?: BinaryHeadersInboundOptions;
}

// ============================================================================
// Outbound Codec
// ============================================================================

export class BinaryHeadersOutboundCodec implements OutboundCodec {
  readonly #resolver: EligibilityResolver;
  readonly #packer: CommandPacker;

  constructor(options: BinaryHeadersOutboundOptions = {}) {
    this.#resolver = options.resolver ?? NOOP_RESOLVER;
    this.#packer = new CommandPacker(options.maxWaitMs ?? null);
  }

  transform(
    encoded: ReadonlyArray<RedisArgument>,
    args: ReadonlyArray<RedisArgument>
  ): ReadonlyArray<RedisArgument> | null {
    const slot = this.#resolver.getSlot(args);

    // Ineligible commands pass through unchanged
    if (slot === SLOT_INELIGIBLE) {
      return encoded;
    }

    // Try to add to batch
    return this.#packer.add(encoded, slot, calculatePayloadLength(encoded));
  }

  drain(): ReadonlyArray<RedisArgument> | null {
    return this.#packer.drain();
  }

  hasPending(): boolean {
    return this.#packer.bufferSize > 0;
  }
}

// ============================================================================
// Inbound Decoder (frame parser)
// ============================================================================

const HEADER_LENGTH = ResponseHeaderDecoder.ENCODED_LENGTH;
const DESIGNATOR = ResponseHeaderDecoder.designatorConstantValue();

const enum ParseResult {
  CONTINUE,
  PASSTHROUGH,
  BUFFER_PARTIAL,
}

/**
 * Decodes binary header frames from incoming data.
 * Strips headers and forwards payloads to a sink or decoder.
 */
export class BinhdrInboundDecoder {
  readonly #headerDecoder = new ResponseHeaderDecoder();
  readonly #onHeader: OnHeader | undefined;
  readonly #onProtocolError: OnProtocolError | undefined;
  #partial: Buffer | null = null;
  #payloadRemaining = 0;

  constructor(options: InboundDecoderOptions = {}) {
    this.#onHeader = options.onHeader;
    this.#onProtocolError = options.onProtocolError;
  }

  process(chunk: Buffer, sink: PayloadSink): void {
    this.#decode(chunk, sink);
  }

  writeToDecoder(chunk: Buffer, decoder: Decoder): void {
    this.#decode(chunk, data => decoder.write(data));
  }

  reset(): void {
    this.#partial = null;
    this.#payloadRemaining = 0;
  }

  #decode(chunk: Buffer, emit: PayloadSink): void {
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

  #forwardPayload(data: Buffer, offset: number, emit: PayloadSink): number {
    const available = data.length - offset;
    const toForward = available < this.#payloadRemaining ? available : this.#payloadRemaining;
    emit(data.subarray(offset, offset + toForward));
    this.#payloadRemaining -= toForward;
    return offset + toForward;
  }

  #parseHeader(data: Buffer, offset: number, emit: PayloadSink): ParseResult {
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

// ============================================================================
// Inbound Codec
// ============================================================================

export class BinaryHeadersInboundCodec implements InboundCodec {
  readonly #decoder: BinhdrInboundDecoder;

  constructor(options: BinaryHeadersInboundOptions = {}) {
    this.#decoder = new BinhdrInboundDecoder({
      onProtocolError: options.onProtocolError !== undefined
        ? header => options.onProtocolError!(header.requestId)
        : undefined
    });
  }

  process(chunk: Buffer, decoder: Decoder): void {
    this.#decoder.writeToDecoder(chunk, decoder);
  }
}

// ============================================================================
// Combined Codec
// ============================================================================

export class BinaryHeadersCodec implements CommandCodec {
  readonly outbound: BinaryHeadersOutboundCodec;
  readonly inbound: BinaryHeadersInboundCodec;

  constructor(options: BinaryHeadersCodecOptions = {}) {
    this.outbound = new BinaryHeadersOutboundCodec(options.outbound);
    this.inbound = new BinaryHeadersInboundCodec(options.inbound);
  }
}

export function createBinaryHeadersCodec(options: BinaryHeadersCodecOptions = {}): BinaryHeadersCodec {
  return new BinaryHeadersCodec(options);
}
