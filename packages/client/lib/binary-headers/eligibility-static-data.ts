import type { CommandRecord, CommandRecordFetcher } from './eligibility-types';
import { EligibilityResolver, createEligibilityResolver } from './eligibility-resolver';

export const STATIC_COMMAND_RECORDS: ReadonlyArray<CommandRecord> = [
  { name: 'SET' },
  { name: 'GET' },
  { name: 'MSET' },
  { name: 'MGET' },
  { name: 'DEL' },
  { name: 'HSET' },
  { name: 'HGET' },
  { name: 'TIME', keyPosition: { keyless: true } },
  { name: 'PING', keyPosition: { keyless: true } },
  { name: 'XREAD', blocking: { type: 'conditional', argName: 'BLOCK' } },
  { name: 'XREADGROUP', blocking: { type: 'conditional', argName: 'BLOCK' } },
  {
    name: 'OBJECT',
    subcommands: [
      { name: 'ENCODING', keyPosition: { index: 2 } },
    ]
  },
];

export function createMockRecordFetcher(): CommandRecordFetcher {
  return async () => STATIC_COMMAND_RECORDS;
}

export async function createDefaultResolver(): Promise<EligibilityResolver> {
  return createEligibilityResolver(createMockRecordFetcher());
}
