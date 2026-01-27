import type { RedisArgument } from '../RESP/types';
import type { OutboundCodec, InboundCodec, CommandCodec, TransformResult } from '../client/commands-queue';
import type { EligibilityResolver } from './eligibility';
import { SLOT_INELIGIBLE, NOOP_RESOLVER } from './eligibility';
import { CommandPacker, calculatePayloadLength } from './packing';
import { ResponseHeaderDecoder, type ResponseHeader as BinaryResponseHeader } from './generated/response-header-codec';

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

export interface BinaryHeadersCodecOptions {
  readonly outbound?: BinaryHeadersOutboundOptions;
  readonly inbound?: BinaryHeadersInboundOptions;
}

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
  ): TransformResult {
    const slot = this.#resolver.getSlot(args);

    if (slot === SLOT_INELIGIBLE) {
      return { type: 'passthrough', data: encoded };
    }

    const packed = this.#packer.add(encoded, slot, calculatePayloadLength(encoded));
    if (packed !== null) {
      return { type: 'packed', data: packed };
    }
    return { type: 'buffered' };
  }

  drain(): ReadonlyArray<RedisArgument> | null {
    return this.#packer.drain();
  }

  hasPending(): boolean {
    return this.#packer.bufferSize > 0;
  }
}

const HEADER_LENGTH = ResponseHeaderDecoder.ENCODED_LENGTH;
const DESIGNATOR = ResponseHeaderDecoder.designatorConstantValue();

const enum ParseResult {
  CONTINUE,
  PASSTHROUGH,
  BUFFER_PARTIAL,
}

export class BinhdrInboundDecoder implements InboundCodec {
  readonly #headerDecoder = new ResponseHeaderDecoder();
  readonly #onHeader: OnHeader | undefined;
  readonly #onProtocolError: OnProtocolError | undefined;
  #partial: Buffer | null = null;
  #payloadRemaining = 0;

  constructor(options: BinaryHeadersInboundOptions = {}) {
    this.#onHeader = options.onHeader;
    this.#onProtocolError = options.onProtocolError;
  }

  process(chunk: Buffer, sink: (data: Buffer) => void): void {
    this.#decode(chunk, sink);
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

export class BinaryHeadersCodec implements CommandCodec {
  readonly outbound: BinaryHeadersOutboundCodec;
  readonly inbound: BinhdrInboundDecoder;

  constructor(options: BinaryHeadersCodecOptions = {}) {
    this.outbound = new BinaryHeadersOutboundCodec(options.outbound);
    this.inbound = new BinhdrInboundDecoder(options.inbound);
  }
}

export function createBinaryHeadersCodec(options: BinaryHeadersCodecOptions = {}): BinaryHeadersCodec {
  return new BinaryHeadersCodec(options);
}
