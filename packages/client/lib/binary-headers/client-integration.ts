import type { RedisArgument } from '../RESP/types';
import type { CommandCodec } from '../client/commands-queue';
import type { EligibilityResolver } from './eligibility-types';
import { createDefaultResolver } from './eligibility-static-data';
import { createBinhdrInterceptor } from './interceptor';
import { packSingleCommand, calculateSlotFromKeys } from './packing';

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
    .then(r => {
      resolver = r;
      console.log('[binhdr] Eligibility resolver ready');
    })
    .catch(() => { /* stays null - all commands ineligible */ });

  // Create interceptor for incoming data
  const interceptor = createBinhdrInterceptor({
    onProtocolError: onProtocolError
      ? (header) => onProtocolError(header.clientIdx)
      : undefined
  });

  return {
    encode(
      command: ReadonlyArray<RedisArgument>,
      resp: ReadonlyArray<RedisArgument>
    ): ReadonlyArray<RedisArgument> {
      // Check eligibility
      if (!resolver) {
        console.log('[binhdr] Resolver not ready, skipping:', command[0]);
        return resp;
      }

      const result = resolver.resolveEligibility(command);
      if (!result.ok || !result.value.binhdrFlag) {
        console.log('[binhdr] Command not eligible:', command[0]);
        return resp;
      }

      console.log('[binhdr] Command eligible:', command[0]);
      console.log('[binhdr] Packing command');

      // Pack with binary header
      // TODO: extract keys properly from command
      const slot = calculateSlotFromKeys([]);
      const packResult = packSingleCommand(resp, slot);
      return packResult.success ? packResult.packed : resp;
    },

    decode(chunk: Buffer, push: (data: Buffer) => void): void {
      interceptor(chunk, push);
    }
  };
}
