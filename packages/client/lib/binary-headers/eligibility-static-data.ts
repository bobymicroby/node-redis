import type { CommandBinhdrRawReply, CommandBinhdrFetcher } from './eligibility-types';
import {
  EligibilityResolver,
  DynamicEligibilityResolverFactory
} from './eligibility-resolver';

/**
 * Static eligibility records (test/fallback data).
 *
 * Key position rules:
 * - If keyless/keyPosition absent: first key is at index 1 (default)
 * - keyless: true = command has no keys
 * - keyPosition: number = first key is at that index (when != 1)
 */
export const STATIC_BINHDR_RECORDS: ReadonlyArray<CommandBinhdrRawReply> = [
  // Commands with keys at default position (index 1)
  { name: 'SET', binhdrFlag: true },
  { name: 'GET', binhdrFlag: true },
  { name: 'MSET', binhdrFlag: true },
  { name: 'MGET', binhdrFlag: true },
  { name: 'DEL', binhdrFlag: true },
  { name: 'HSET', binhdrFlag: true },
  { name: 'HGET', binhdrFlag: true },

  // Commands without keys
  { name: 'TIME', binhdrFlag: true, keyless: true },
  { name: 'PING', binhdrFlag: true, keyless: true },

  // Command with subcommands (key at index 2 for OBJECT subcommands)
  {
    name: 'OBJECT',
    binhdrFlag: false,
    subcommands: [
      { name: 'ENCODING', binhdrFlag: true, keyPosition: 2 },
    ]
  },
];

export function createMockBinhdrFetcher(): CommandBinhdrFetcher {
  return async () => STATIC_BINHDR_RECORDS;
}

export async function createDefaultResolver(): Promise<EligibilityResolver> {
  return DynamicEligibilityResolverFactory.create(createMockBinhdrFetcher());
}
