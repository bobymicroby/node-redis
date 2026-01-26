import type {
  CommandRecord,
  CommandRecordFetcher,
  CommandNode,
} from './eligibility-types';
import { EligibilityResolver, createEligibilityResolver, buildCommandNode } from './eligibility-resolver';

export const STATIC_COMMAND_RECORDS: ReadonlyArray<CommandRecord> = [
  { name: 'SET' },
  { name: 'GET' },
  { name: 'MSET' },
  { name: 'MGET' },
  { name: 'DEL' },
  { name: 'EXISTS' },
  { name: 'EXPIRE' },
  { name: 'TTL' },
  { name: 'PTTL' },
  { name: 'INCR' },
  { name: 'DECR' },
  { name: 'INCRBY' },
  { name: 'DECRBY' },
  { name: 'APPEND' },
  { name: 'STRLEN' },
  { name: 'GETEX' },
  { name: 'GETDEL' },
  { name: 'SETEX' },
  { name: 'SETNX' },

  { name: 'HSET' },
  { name: 'HGET' },
  { name: 'HMSET' },
  { name: 'HMGET' },
  { name: 'HDEL' },
  { name: 'HEXISTS' },
  { name: 'HGETALL' },
  { name: 'HKEYS' },
  { name: 'HVALS' },
  { name: 'HLEN' },
  { name: 'HINCRBY' },
  { name: 'HINCRBYFLOAT' },

  { name: 'LPUSH' },
  { name: 'RPUSH' },
  { name: 'LPOP' },
  { name: 'RPOP' },
  { name: 'LLEN' },
  { name: 'LRANGE' },
  { name: 'LINDEX' },
  { name: 'LSET' },
  { name: 'LREM' },
  { name: 'LTRIM' },

  { name: 'SADD' },
  { name: 'SREM' },
  { name: 'SMEMBERS' },
  { name: 'SISMEMBER' },
  { name: 'SCARD' },
  { name: 'SPOP' },
  { name: 'SRANDMEMBER' },

  { name: 'ZADD' },
  { name: 'ZREM' },
  { name: 'ZSCORE' },
  { name: 'ZRANK' },
  { name: 'ZREVRANK' },
  { name: 'ZRANGE' },
  { name: 'ZREVRANGE' },
  { name: 'ZRANGEBYSCORE' },
  { name: 'ZCARD' },
  { name: 'ZCOUNT' },
  { name: 'ZINCRBY' },

  { name: 'TIME', keyPosition: { keyless: true } },
  { name: 'PING', keyPosition: { keyless: true } },
  { name: 'ECHO', keyPosition: { keyless: true } },
  { name: 'DBSIZE', keyPosition: { keyless: true } },

  { name: 'BLPOP', blocking: { type: 'always' } },
  { name: 'BRPOP', blocking: { type: 'always' } },
  { name: 'BLMOVE', blocking: { type: 'always' } },
  { name: 'BRPOPLPUSH', blocking: { type: 'always' } },
  { name: 'BLMPOP', blocking: { type: 'always' } },
  { name: 'BZPOPMIN', blocking: { type: 'always' } },
  { name: 'BZPOPMAX', blocking: { type: 'always' } },
  { name: 'BZMPOP', blocking: { type: 'always' } },
  { name: 'XREAD', blocking: { type: 'conditional', argName: 'BLOCK' } },
  { name: 'XREADGROUP', blocking: { type: 'conditional', argName: 'BLOCK' } },

  {
    name: 'OBJECT',
    subcommands: [
      { name: 'ENCODING', keyPosition: { index: 2 } },
      { name: 'FREQ', keyPosition: { index: 2 } },
      { name: 'IDLETIME', keyPosition: { index: 2 } },
      { name: 'REFCOUNT', keyPosition: { index: 2 } },
    ]
  },
  {
    name: 'CLIENT',
    keyPosition: { keyless: true },
    subcommands: [
      { name: 'GETNAME', keyPosition: { keyless: true } },
      { name: 'SETNAME', keyPosition: { keyless: true } },
      { name: 'LIST', keyPosition: { keyless: true } },
      { name: 'ID', keyPosition: { keyless: true } },
    ]
  },
  {
    name: 'MEMORY',
    keyPosition: { keyless: true },
    subcommands: [
      { name: 'USAGE', keyPosition: { index: 2 } },
      { name: 'DOCTOR', keyPosition: { keyless: true } },
      { name: 'STATS', keyPosition: { keyless: true } },
    ]
  },
];

function buildCommandMap(records: ReadonlyArray<CommandRecord>): Map<string, CommandNode> {
  const map = new Map<string, CommandNode>();

  for (const record of records) {
    map.set(record.name.toUpperCase(), buildCommandNode(record));
  }

  return map;
}

const STATIC_COMMAND_MAP: ReadonlyMap<string, CommandNode> = buildCommandMap(STATIC_COMMAND_RECORDS);

export const STATIC_RESOLVER: EligibilityResolver = new EligibilityResolver(STATIC_COMMAND_MAP);

export function createMockRecordFetcher(): CommandRecordFetcher {
  return async () => STATIC_COMMAND_RECORDS;
}

export async function createDefaultResolver(): Promise<EligibilityResolver> {
  return STATIC_RESOLVER;
}

export async function createDynamicResolver(fetcher: CommandRecordFetcher): Promise<EligibilityResolver> {
  return createEligibilityResolver(fetcher);
}
