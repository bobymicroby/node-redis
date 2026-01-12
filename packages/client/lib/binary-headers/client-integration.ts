import type { RedisArgument } from '../RESP/types';
import type { EligibilityResolver } from './eligibility-types';
import { createDefaultResolver } from './eligibility-static-data';
import { createBinhdrInterceptor, type DataHandler } from './interceptor';
import { packSingleCommand, calculateSlotFromKeys } from './packing';

export interface CommandFlags {
  eligibleForBinhdr: boolean;
}

export interface CommandToWrite {
  payload: ReadonlyArray<RedisArgument>;
  flags: CommandFlags;
}

export type CommandsGenerator = Generator<CommandToWrite>;
export type EncodedGenerator = Generator<ReadonlyArray<RedisArgument>>;

export interface BinhdrHandler {
  /** Checks if command args are eligible for binary headers */
  checkEligibility(args: ReadonlyArray<RedisArgument>): boolean;
  /** Packs eligible commands with binary headers */
  pack(commands: CommandsGenerator): EncodedGenerator;
  /** Processes incoming data, stripping binary headers */
  processData(chunk: Buffer, onData: DataHandler): void;
}

/**
 * Creates a binary headers handler for client integration.
 * Encapsulates all binhdr logic in one place.
 */
export function createBinhdrHandler(
  onProtocolError?: (clientIdx: number) => void
): BinhdrHandler {
  let resolver: EligibilityResolver | null = null;

  // Fetch eligibility in background
  createDefaultResolver()
    .then(r => {
      resolver = r;
      console.log('[binhdr] Eligibility resolver ready');
    })
    .catch(() => { /* stays null - all commands ineligible */ });

  const interceptor = createBinhdrInterceptor({
    onProtocolError: onProtocolError
      ? (header) => onProtocolError(header.clientIdx)
      : undefined
  });

  return {
    checkEligibility(args: ReadonlyArray<RedisArgument>): boolean {
      if (!resolver) {
        console.log('[binhdr] Resolver not ready, skipping:', args[0]);
        return false;
      }

      const result = resolver.resolveEligibility(args);
      if (!result.ok || !result.value.binhdrFlag) {
        console.log('[binhdr] Command not eligible:', args[0]);
        return false;
      }

      console.log('[binhdr] Command eligible:', args[0]);
      return true;
    },

    *pack(commands: CommandsGenerator): EncodedGenerator {
      for (const { payload, flags } of commands) {
        if (!flags.eligibleForBinhdr) {
          yield payload;
          continue;
        }

        console.log('[binhdr] Packing command');
        // TODO: extract keys properly from command
        const slot = calculateSlotFromKeys([]);
        const result = packSingleCommand(payload, slot);
        yield result.success ? result.packed : payload;
      }
    },

    processData(chunk: Buffer, onData: DataHandler): void {
      interceptor(chunk, onData);
    }
  };
}
