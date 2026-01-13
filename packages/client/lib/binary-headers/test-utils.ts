import { BINHDR } from './constants';
import type { BinaryResponseHeader } from './types';
import { encodeResponseHeader } from './encoder';

/**
 * Creates a valid response header object for testing.
 */
export function createResponseHeader(
  length: number,
  commandCount: number,
  clientIdx: number,
  protocolError: boolean = false
): BinaryResponseHeader {
  return {
    designator: BINHDR.DESIGNATOR,
    length,
    commandCount,
    protocolError,
    clientIdx,
  };
}

/**
 * Creates a complete binary header response buffer with RESP payload.
 */
export function createBinhdrResponse(respPayload: string): Buffer {
  const payload = Buffer.from(respPayload);
  const header = createResponseHeader(payload.length, 1, 0, false);
  return Buffer.concat([encodeResponseHeader(header), payload]);
}
