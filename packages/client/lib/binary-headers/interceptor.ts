import { ResponseHeaderDecoder, type ResponseHeader as BinaryResponseHeader } from './generated/response-header-codec';
import type {
  InboundNext,
  InboundInterceptor,
  OutboundInterceptor,
  OutboundCommand
} from '../client/commands-queue';
import type { Decoder } from '../RESP/decoder';

export type OnHeader = (header: BinaryResponseHeader) => void;
export type OnProtocolError = (header: BinaryResponseHeader) => void;

export interface InterceptorOptions {
  readonly onHeader?: OnHeader;
  readonly onProtocolError?: OnProtocolError;
}

export type PayloadSink = (data: Buffer) => void;

const HEADER_LENGTH = ResponseHeaderDecoder.ENCODED_LENGTH;
const DESIGNATOR = ResponseHeaderDecoder.designatorConstantValue();

const enum ParseResult {
  CONTINUE,
  PASSTHROUGH,
  BUFFER_PARTIAL,
}

export class BinhdrInboundDecoder {
  readonly #headerDecoder = new ResponseHeaderDecoder();
  readonly #onHeader: OnHeader | undefined;
  readonly #onProtocolError: OnProtocolError | undefined;
  #partial: Buffer | null = null;
  #payloadRemaining = 0;

  constructor(options: InterceptorOptions = {}) {
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

export function createBinhdrInterceptor(options: InterceptorOptions = {}): InboundInterceptor {
  const decoder = new BinhdrInboundDecoder(options);
  return (chunk: Buffer, next: InboundNext): void => {
    decoder.process(chunk, next);
  };
}

export function passthroughInbound(): InboundInterceptor {
  return (chunk: Buffer, next: InboundNext): void => {
    next(chunk);
  };
}

export function passthroughOutbound(): OutboundInterceptor {
  return {
    process(command: OutboundCommand): OutboundCommand | null {
      return command;
    },
    drain(): OutboundCommand | null {
      return null;
    }
  };
}

export function chainInbound(interceptors: ReadonlyArray<InboundInterceptor>): InboundInterceptor {
  const count = interceptors.length;

  if (count === 0) {
    return passthroughInbound();
  }

  if (count === 1) {
    return interceptors[0];
  }

  return (chunk: Buffer, next: InboundNext): void => {
    let current = next;
    for (let i = count - 1; i >= 0; i--) {
      const interceptor = interceptors[i];
      const downstream = current;
      current = (data: Buffer) => interceptor(data, downstream);
    }
    current(chunk);
  };
}
