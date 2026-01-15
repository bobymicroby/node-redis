import { BINHDR } from './constants';
import type { BinaryResponseHeader } from './types';
import { parseResponseHeader, isBinaryHeaderDesignator } from './decoder';
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

interface FrameState {
  partial: Buffer | null;
  payloadRemaining: number;
}

export function createBinhdrInterceptor(options: InterceptorOptions = {}): InboundInterceptor {
  const { onHeader, onProtocolError } = options;

  const state: FrameState = {
    partial: null,
    payloadRemaining: 0,
  };

  return (chunk: Buffer, next: InboundNext): void => {
    let data = state.partial ? Buffer.concat([state.partial, chunk]) : chunk;
    state.partial = null;

    let offset = 0;

    while (offset < data.length) {
      if (state.payloadRemaining > 0) {
        const available = data.length - offset;
        const bytesToForward = Math.min(state.payloadRemaining, available);

        if (bytesToForward === available && offset === 0) {
          next(data);
        } else {
          next(data.subarray(offset, offset + bytesToForward));
        }

        state.payloadRemaining -= bytesToForward;
        offset += bytesToForward;
        continue;
      }

      if (isBinaryHeaderDesignator(data[offset])) {
        if (data.length - offset < BINHDR.RESPONSE_HEADER_SIZE) {
          state.partial = data.subarray(offset);
          return;
        }

        const result = parseResponseHeader(data, offset);

        if (!result.success) {
          next(data.subarray(offset));
          return;
        }

        const header = result.header;
        state.payloadRemaining = header.length;

        if (onHeader) onHeader(header);
        if (header.protocolError && onProtocolError) onProtocolError(header);

        offset += BINHDR.RESPONSE_HEADER_SIZE;
        continue;
      }

      // Non-binary-header data passes through as regular RESP
      next(data.subarray(offset));
      return;
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
  if (interceptors.length === 0) return passthroughInbound();
  if (interceptors.length === 1) return interceptors[0];

  return (chunk: Buffer, next: InboundNext): void => {
    let current = next;
    for (let i = interceptors.length - 1; i >= 0; i--) {
      const interceptor = interceptors[i];
      const downstream = current;
      current = (data: Buffer) => interceptor(data, downstream);
    }
    current(chunk);
  };
}
