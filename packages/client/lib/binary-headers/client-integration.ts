import type { RedisArgument } from '../RESP/types';
import type { CommandCodec } from '../client/commands-queue';
import { EligibilityResolver } from './eligibility-resolver';
import { createDefaultResolver } from './eligibility-static-data';
import { createBinhdrInterceptor } from './interceptor';
import {
  CommandPacker,
  createDefaultPackingStrategy,
  createBufferedCommand,
} from './packing';

/**
 * Options for creating the binary headers codec.
 */
export interface BinhdrCodecOptions {
  readonly onProtocolError?: (clientIdx: number) => void;
}

/**
 * Creates a binary headers codec for the command queue.
 * Handles eligibility checking, command packing, and response interception.
 */
export function createBinhdrCodec(
  options: BinhdrCodecOptions = {}
): CommandCodec {
  const { onProtocolError } = options;

  let resolver: EligibilityResolver | null = null;

  // Initialize eligibility resolver asynchronously
  createDefaultResolver()
    .then(r => { resolver = r; })
    .catch(() => { /* stays null - all commands ineligible */ });

  // Create packer with default strategy
  const packer = new CommandPacker(createDefaultPackingStrategy());

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
    ): ReadonlyArray<RedisArgument> | null {
      // If resolver not ready, pass through without packing
      if (!resolver) {
        return resp;
      }

      const eligibility = resolver.getEligibility(command);

      // Ineligible commands: flush buffer and pass through
      if (!eligibility.eligible) {
        // Return resp directly - the queue will handle flushing
        // by calling flush() before yielding ineligible commands
        return resp;
      }

      // Create buffered command
      const buffered = createBufferedCommand(command, resp, eligibility);

      // Try to add to packer
      const flushed = packer.add(buffered);

      // If packer flushed, return the packed frame
      // The newly added command is now in the buffer
      return flushed;
    },

    flush(): ReadonlyArray<RedisArgument> | null {
      return packer.flush();
    },

    decode(chunk: Buffer, push: (data: Buffer) => void): void {
      interceptor(chunk, push);
    }
  };
}
