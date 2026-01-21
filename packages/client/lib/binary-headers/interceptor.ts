import { ResponseHeaderDecoder, type ResponseHeader as BinaryResponseHeader } from './generated/response-header-codec';
import type {
  InboundNext,
  InboundInterceptor,
  OutboundInterceptor,
  OutboundCommand
} from '../client/commands-queue';

export type OnHeader = (header: BinaryResponseHeader) => void;
export type OnProtocolError = (header: BinaryResponseHeader) => void;

export interface InterceptorOptions {
  readonly onHeader?: OnHeader;
  readonly onProtocolError?: OnProtocolError;
}

type ProcessAction =
  | { readonly type: 'passthrough'; readonly from: number }
  | { readonly type: 'buffer_partial'; readonly from: number }
  | { readonly type: 'forward_payload'; readonly from: number; readonly length: number; readonly newRemaining: number }
  | { readonly type: 'header_parsed'; readonly from: number };

function computeNextAction(
  data: Buffer,
  offset: number,
  payloadRemaining: number,
  decoder: ResponseHeaderDecoder
): ProcessAction {
  if (payloadRemaining > 0) {
    const available = data.length - offset;
    const toForward = Math.min(payloadRemaining, available);
    return {
      type: 'forward_payload',
      from: offset,
      length: toForward,
      newRemaining: payloadRemaining - toForward
    };
  }

  if (data[offset] !== ResponseHeaderDecoder.designatorConstantValue()) {
    return { type: 'passthrough', from: offset };
  }

  const remaining = data.length - offset;
  if (remaining < ResponseHeaderDecoder.ENCODED_LENGTH) {
    return { type: 'buffer_partial', from: offset };
  }

  decoder.wrap(data, offset);

  if (!decoder.isValid()) {
    return { type: 'passthrough', from: offset };
  }

  return { type: 'header_parsed', from: offset };
}



export function createBinhdrInterceptor(options: InterceptorOptions = {}): InboundInterceptor {
  let partial: Buffer | null = null;
  let payloadRemaining = 0;
  const decoder = new ResponseHeaderDecoder();

  return (chunk: Buffer, next: InboundNext): void => {
    const data = partial !== null ? Buffer.concat([partial, chunk]) : chunk;
    partial = null;
    let offset = 0;

    while (offset < data.length) {
      const action = computeNextAction(data, offset, payloadRemaining, decoder);

      switch (action.type) {
        case 'passthrough':
          next(data.subarray(action.from));
          return;

        case 'buffer_partial':
          partial = data.subarray(action.from);
          return;

        case 'forward_payload':
          next(data.subarray(action.from, action.from + action.length));
          payloadRemaining = action.newRemaining;
          offset = action.from + action.length;
          break;

        case 'header_parsed': {
          const length = decoder.length();
          const protocolError = decoder.protocolError();

          payloadRemaining = length;
          offset = action.from + ResponseHeaderDecoder.ENCODED_LENGTH;

          if (options.onHeader !== undefined || (protocolError && options.onProtocolError !== undefined)) {
            const header = decoder.toObject();
            if (options.onHeader !== undefined) {
              options.onHeader(header);
            }
            if (protocolError && options.onProtocolError !== undefined) {
              options.onProtocolError(header);
            }
          }
          break;
        }
      }
    }
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
