import { BINHDR } from './constants';
import type { BinaryResponseHeader } from './types';
import { parseResponseHeader, isBinaryHeaderDesignator } from './decoder';

/**
 * Handler for processing data chunks
 */
export type DataHandler = (chunk: Buffer) => void;

/**
 * Interceptor function signature (Next.js middleware style)
 * Receives a chunk and a next function to pass data to the next handler
 */
export type DataInterceptor = (chunk: Buffer, next: DataHandler) => void;

/**
 * Callback when a binary header is parsed
 */
export type OnBinhdrHeader = (header: BinaryResponseHeader) => void;

/**
 * Callback when a protocol error is detected in response
 */
export type OnBinhdrProtocolError = (header: BinaryResponseHeader) => void;

/**
 * Options for creating a binary header interceptor
 */
export interface BinhdrInterceptorOptions {
  readonly onHeader?: OnBinhdrHeader;
  readonly onProtocolError?: OnBinhdrProtocolError;
}

/**
 * State for the binary header interceptor to handle partial data
 */
interface InterceptorState {
  /** Pending buffer for incomplete headers */
  pending: Buffer | null;
  /** Current header being processed (waiting for payload) */
  currentHeader: BinaryResponseHeader | null;
  /** Bytes of payload remaining to forward */
  remainingPayload: number;
}

/**
 * Creates a binary header response interceptor.
 *
 * The interceptor detects binary header frames (starting with 0x80),
 * parses the 8-byte header, and forwards only the RESP payload to the next handler.
 *
 * For non-binary-header data, it passes through unchanged.
 *
 * @param options - Optional callbacks for header events
 * @returns DataInterceptor function
 */
export function createBinhdrInterceptor(
  options: BinhdrInterceptorOptions = {}
): DataInterceptor {
  const { onHeader, onProtocolError } = options;

  const state: InterceptorState = {
    pending: null,
    currentHeader: null,
    remainingPayload: 0,
  };

  return function binhdrInterceptor(chunk: Buffer, next: DataHandler): void {
    // Combine with any pending data from previous incomplete read
    let data = state.pending ? Buffer.concat([state.pending, chunk]) : chunk;
    state.pending = null;

    let offset = 0;

    while (offset < data.length) {
      // If we're in the middle of forwarding a payload
      if (state.remainingPayload > 0) {
        const available = data.length - offset;
        const toForward = Math.min(state.remainingPayload, available);

        // Forward the payload portion to the RESP decoder
        if (toForward === available && offset === 0) {
          // Optimization: forward entire buffer without slicing
          next(data);
        } else {
          next(data.subarray(offset, offset + toForward));
        }

        state.remainingPayload -= toForward;
        offset += toForward;

        // Clear current header when payload is complete
        if (state.remainingPayload === 0) {
          state.currentHeader = null;
        }
        continue;
      }

      // Check if this looks like a binary header
      if (isBinaryHeaderDesignator(data[offset])) {
        // Check if we have enough bytes for header
        if (data.length - offset < BINHDR.RESPONSE_HEADER_SIZE) {
          // Save incomplete header for next chunk
          state.pending = data.subarray(offset);
          return;
        }

        // Parse the header
        const result = parseResponseHeader(data, offset);

        if (!result.success) {
          // Should not happen if designator was correct
          // Fall through to pass data as-is
          next(data.subarray(offset));
          return;
        }

        const header = result.header;
        state.currentHeader = header;
        state.remainingPayload = header.length;

        // Notify about header
        if (onHeader) {
          onHeader(header);
        }

        // Check for protocol error
        if (header.protocolError && onProtocolError) {
          onProtocolError(header);
        }

        // Skip past header
        offset += BINHDR.RESPONSE_HEADER_SIZE;
        continue;
      }

      // Not a binary header - pass remaining data through as regular RESP
      // This handles the case where binary headers are mixed with regular RESP
      // or when binary headers are disabled
      next(data.subarray(offset));
      return;
    }
  };
}

/**
 * Creates a passthrough interceptor that does nothing.
 * Used when binary headers are disabled.
 */
export function createPassthroughInterceptor(): DataInterceptor {
  return function passthroughInterceptor(chunk: Buffer, next: DataHandler): void {
    next(chunk);
  };
}
