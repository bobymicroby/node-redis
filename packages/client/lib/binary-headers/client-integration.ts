import type { RedisArgument } from '../RESP/types';
import type { CommandCodec } from '../client/commands-queue';
import { EligibilityResolver } from './eligibility-resolver';
import { createDefaultResolver } from './eligibility-static-data';
import { createBinhdrInterceptor } from './interceptor';
import { BINHDR } from './constants';

/**
 * Creates a binary headers codec for the command queue.
 * Handles eligibility checking, command packing, and response interception.
 */
export function createBinhdrCodec(
  onProtocolError?: (clientIdx: number) => void
): CommandCodec {
  let resolver: EligibilityResolver | null = null;

  // Initialize eligibility resolver asynchronously
  createDefaultResolver()
    .then(r => { resolver = r; })
    .catch(() => { /* stays null - all commands ineligible */ });

  // Create interceptor for incoming data
  const interceptor = createBinhdrInterceptor({
    onProtocolError: onProtocolError
      ? (header) => onProtocolError(header.clientIdx)
      : undefined
  });

  // Ring buffer of pre-allocated headers to avoid race conditions.
  // socket.write() is async - buffer must remain valid until sent.
  // By cycling through N buffers, oldest is likely sent before reuse.
  const RING_SIZE = 32; // 32 * 10 bytes = 320 bytes total
  const headerRing: Buffer[] = new Array(RING_SIZE);
  for (let i = 0; i < RING_SIZE; i++) {
    const buf = Buffer.allocUnsafe(BINHDR.REQUEST_HEADER_SIZE);
    // Pre-fill static fields
    buf[0] = BINHDR.DESIGNATOR;
    buf[5] = 1; // commandCount = 1
    buf.writeUInt16BE(BINHDR.SLOT_NO_SLOT, 6);
    buf.writeUInt16BE(0, 8); // clientIdx = 0
    headerRing[i] = buf;
  }
  let ringIndex = 0;

  return {
    encode(
      command: ReadonlyArray<RedisArgument>,
      resp: ReadonlyArray<RedisArgument>
    ): ReadonlyArray<RedisArgument> {
      // Check eligibility
      if (!resolver || !resolver.isEligible(command)) {
        return resp;
      }

      // Calculate payload length inline
      let payloadLength = 0;
      for (let i = 0; i < resp.length; i++) {
        const part = resp[i];
        payloadLength += typeof part === 'string' ? Buffer.byteLength(part) : part.length;
      }

      // Get next header buffer from ring (cycle through to avoid races)
      const headerBuffer = headerRing[ringIndex];
      ringIndex = (ringIndex + 1) & (RING_SIZE - 1); // Fast modulo for power of 2

      // Only update the dynamic field (payload length) - rest is pre-filled
      headerBuffer.writeUInt32BE(payloadLength, 1);

      // Create result array without spread
      const packed = new Array(resp.length + 1);
      packed[0] = headerBuffer;
      for (let i = 0; i < resp.length; i++) {
        packed[i + 1] = resp[i];
      }

      return packed;
    },

    decode(chunk: Buffer, push: (data: Buffer) => void): void {
      interceptor(chunk, push);
    }
  };
}
