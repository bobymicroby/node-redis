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

/**
 * Creates an inbound interceptor that strips binary response headers.
 *
 * Handles chunked data: buffers partial headers across calls,
 * tracks remaining payload bytes, and forwards decoded RESP to `next`.
 * Non-binary data passes through unchanged.
 */
export function createBinhdrInterceptor(options: InterceptorOptions = {}): InboundInterceptor {
  let partial: Buffer | null = null;
  let payloadRemaining = 0;

  return (chunk: Buffer, next: InboundNext): void => {
    const data = partial ? Buffer.concat([partial, chunk]) : chunk;
    partial = null;
    let offset = 0;

    while (offset < data.length) {
      // Forwarding payload
      if (payloadRemaining > 0) {
        const toForward = Math.min(payloadRemaining, data.length - offset);
        next(data.subarray(offset, offset + toForward));
        payloadRemaining -= toForward;
        offset += toForward;
        continue;
      }

      // Not a binary header - passthrough
      if (!isBinaryHeaderDesignator(data[offset])) {
        next(data.subarray(offset));
        return;
      }

      // Incomplete header - buffer for next call
      if (data.length - offset < BINHDR.RESPONSE_HEADER_SIZE) {
        partial = data.subarray(offset);
        return;
      }

      // Parse header
      const result = parseResponseHeader(data, offset);
      if (!result.success) {
        next(data.subarray(offset));
        return;
      }

      payloadRemaining = result.header.length;
      options.onHeader?.(result.header);
      if (result.header.protocolError) options.onProtocolError?.(result.header);
      offset += BINHDR.RESPONSE_HEADER_SIZE;
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

/** Composes interceptors right-to-left: first in array processes data first. */
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
