import type { CommandBinhdrRawReply, CommandBinhdrFetcher } from './eligibility-types';
import { StaticEligibilityResolver, DynamicEligibilityResolverFactory } from './eligibility-resolver';

const NEVER = 'never' as const;
const ALWAYS = 'always' as const;
const CONDITIONAL = 'conditional' as const;

/**
 * Static eligibility records.
 * Will be replaced by COMMAND BINHDR response when available.
 */
export const STATIC_BINHDR_RECORDS: ReadonlyArray<CommandBinhdrRawReply> = [
  // Simple key-value commands
  { name: 'SET', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'GET', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'MSET', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'MGET', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'DEL', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'INCR', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'DECR', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'EXPIRE', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'TTL', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'EXISTS', binhdrFlag: true, hasKeys: true, blockingType: NEVER },

  // List commands
  { name: 'LPUSH', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'RPUSH', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'LPOP', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'RPOP', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'LRANGE', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'LLEN', binhdrFlag: true, hasKeys: true, blockingType: NEVER },

  // Hash commands
  { name: 'HSET', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'HGET', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'HMSET', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'HMGET', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'HGETALL', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'HDEL', binhdrFlag: true, hasKeys: true, blockingType: NEVER },

  // Set commands
  { name: 'SADD', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'SREM', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'SMEMBERS', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'SISMEMBER', binhdrFlag: true, hasKeys: true, blockingType: NEVER },

  // Sorted set commands
  { name: 'ZADD', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'ZREM', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'ZRANGE', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
  { name: 'ZSCORE', binhdrFlag: true, hasKeys: true, blockingType: NEVER },

  // Always blocking commands - never eligible
  { name: 'BLPOP', binhdrFlag: false, hasKeys: true, blockingType: ALWAYS },
  { name: 'BRPOP', binhdrFlag: false, hasKeys: true, blockingType: ALWAYS },
  { name: 'BLMOVE', binhdrFlag: false, hasKeys: true, blockingType: ALWAYS },
  { name: 'BRPOPLPUSH', binhdrFlag: false, hasKeys: true, blockingType: ALWAYS },
  { name: 'BZPOPMIN', binhdrFlag: false, hasKeys: true, blockingType: ALWAYS },
  { name: 'BZPOPMAX', binhdrFlag: false, hasKeys: true, blockingType: ALWAYS },
  { name: 'BLMPOP', binhdrFlag: false, hasKeys: true, blockingType: ALWAYS },
  { name: 'BZMPOP', binhdrFlag: false, hasKeys: true, blockingType: ALWAYS },
  { name: 'WAIT', binhdrFlag: false, hasKeys: false, blockingType: ALWAYS },
  { name: 'WAITAOF', binhdrFlag: false, hasKeys: false, blockingType: ALWAYS },

  // Conditionally blocking commands
  { name: 'XREAD', binhdrFlag: true, hasKeys: true, blockingType: CONDITIONAL, conditionalBlockingArg: 'BLOCK' },
  { name: 'XREADGROUP', binhdrFlag: true, hasKeys: true, blockingType: CONDITIONAL, conditionalBlockingArg: 'BLOCK' },

  // BINDHR meta-command - never eligible
  { name: 'BINDHR', binhdrFlag: false, hasKeys: false, blockingType: NEVER },

  // No-key commands
  { name: 'TIME', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
  { name: 'PING', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
  { name: 'ECHO', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
  { name: 'DBSIZE', binhdrFlag: false, hasKeys: false, blockingType: NEVER },

  // Commands with subcommands
  {
    name: 'CLUSTER',
    binhdrFlag: false,
    hasKeys: false,
    blockingType: NEVER,
    subcommands: [
      { name: 'SLOTS', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
      { name: 'NODES', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
      { name: 'INFO', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
      { name: 'KEYSLOT', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
      { name: 'SHARDS', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
    ]
  },
  {
    name: 'CLIENT',
    binhdrFlag: false,
    hasKeys: false,
    blockingType: NEVER,
    subcommands: [
      { name: 'SETINFO', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
      { name: 'SETNAME', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
      { name: 'GETNAME', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
      { name: 'ID', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
      { name: 'LIST', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
      { name: 'INFO', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
      { name: 'PAUSE', binhdrFlag: false, hasKeys: false, blockingType: ALWAYS },
      { name: 'UNPAUSE', binhdrFlag: false, hasKeys: false, blockingType: NEVER },
    ]
  },
  {
    name: 'ACL',
    binhdrFlag: false,
    hasKeys: false,
    blockingType: NEVER,
    subcommands: [
      { name: 'CAT', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
      { name: 'LIST', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
      { name: 'WHOAMI', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
    ]
  },
  {
    name: 'CONFIG',
    binhdrFlag: false,
    hasKeys: false,
    blockingType: NEVER,
    subcommands: [
      { name: 'GET', binhdrFlag: true, hasKeys: false, blockingType: NEVER },
      { name: 'SET', binhdrFlag: false, hasKeys: false, blockingType: NEVER },
      { name: 'REWRITE', binhdrFlag: false, hasKeys: false, blockingType: NEVER },
      { name: 'RESETSTAT', binhdrFlag: false, hasKeys: false, blockingType: NEVER },
    ]
  },
  {
    name: 'MEMORY',
    binhdrFlag: false,
    hasKeys: false,
    blockingType: NEVER,
    subcommands: [
      { name: 'USAGE', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
      { name: 'DOCTOR', binhdrFlag: false, hasKeys: false, blockingType: NEVER },
      { name: 'STATS', binhdrFlag: false, hasKeys: false, blockingType: NEVER },
    ]
  },
  {
    name: 'OBJECT',
    binhdrFlag: false,
    hasKeys: false,
    blockingType: NEVER,
    subcommands: [
      { name: 'ENCODING', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
      { name: 'FREQ', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
      { name: 'IDLETIME', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
      { name: 'REFCOUNT', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
    ]
  },
  {
    name: 'XGROUP',
    binhdrFlag: false,
    hasKeys: false,
    blockingType: NEVER,
    subcommands: [
      { name: 'CREATE', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
      { name: 'DESTROY', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
      { name: 'SETID', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
    ]
  },
  {
    name: 'XINFO',
    binhdrFlag: false,
    hasKeys: false,
    blockingType: NEVER,
    subcommands: [
      { name: 'GROUPS', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
      { name: 'STREAM', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
      { name: 'CONSUMERS', binhdrFlag: true, hasKeys: true, blockingType: NEVER },
    ]
  },
];

export function createMockBinhdrFetcher(): CommandBinhdrFetcher {
  return async () => STATIC_BINHDR_RECORDS;
}

export async function createDefaultResolver(): Promise<StaticEligibilityResolver> {
  return DynamicEligibilityResolverFactory.create(createMockBinhdrFetcher());
}
