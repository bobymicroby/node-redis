import type { CommandBinhdrRawReply, CommandBinhdrFetcher } from './eligibility-types';
import {
  EligibilityResolver,
  DynamicEligibilityResolverFactory
} from './eligibility-resolver';

/**
 * Static eligibility records (test/fallback data).
 * Will be replaced by COMMAND BINHDR response when available.
 */
export const STATIC_BINHDR_RECORDS: ReadonlyArray<CommandBinhdrRawReply> = [
  // Eligible simple commands
  { name: 'SET', binhdrFlag: true },
  { name: 'GET', binhdrFlag: true },
  { name: 'MSET', binhdrFlag: true },
  { name: 'MGET', binhdrFlag: true },
  { name: 'DEL', binhdrFlag: true },
  { name: 'INCR', binhdrFlag: true },
  { name: 'DECR', binhdrFlag: true },
  { name: 'EXPIRE', binhdrFlag: true },
  { name: 'TTL', binhdrFlag: true },
  { name: 'EXISTS', binhdrFlag: true },
  { name: 'LPUSH', binhdrFlag: true },
  { name: 'RPUSH', binhdrFlag: true },
  { name: 'LPOP', binhdrFlag: true },
  { name: 'RPOP', binhdrFlag: true },
  { name: 'LRANGE', binhdrFlag: true },
  { name: 'LLEN', binhdrFlag: true },
  { name: 'HSET', binhdrFlag: true },
  { name: 'HGET', binhdrFlag: true },
  { name: 'HMSET', binhdrFlag: true },
  { name: 'HMGET', binhdrFlag: true },
  { name: 'HGETALL', binhdrFlag: true },
  { name: 'HDEL', binhdrFlag: true },
  { name: 'SADD', binhdrFlag: true },
  { name: 'SREM', binhdrFlag: true },
  { name: 'SMEMBERS', binhdrFlag: true },
  { name: 'SISMEMBER', binhdrFlag: true },
  { name: 'ZADD', binhdrFlag: true },
  { name: 'ZREM', binhdrFlag: true },
  { name: 'ZRANGE', binhdrFlag: true },
  { name: 'ZSCORE', binhdrFlag: true },
  { name: 'XREAD', binhdrFlag: true },
  { name: 'XREADGROUP', binhdrFlag: true },
  { name: 'TIME', binhdrFlag: true },
  { name: 'PING', binhdrFlag: true },
  { name: 'ECHO', binhdrFlag: true },

  // Not eligible (blocking, admin, etc.)
  { name: 'BLPOP', binhdrFlag: false },
  { name: 'BRPOP', binhdrFlag: false },
  { name: 'BLMOVE', binhdrFlag: false },
  { name: 'BRPOPLPUSH', binhdrFlag: false },
  { name: 'BZPOPMIN', binhdrFlag: false },
  { name: 'BZPOPMAX', binhdrFlag: false },
  { name: 'BLMPOP', binhdrFlag: false },
  { name: 'BZMPOP', binhdrFlag: false },
  { name: 'WAIT', binhdrFlag: false },
  { name: 'WAITAOF', binhdrFlag: false },
  { name: 'BINDHR', binhdrFlag: false },
  { name: 'DBSIZE', binhdrFlag: false },

  // Commands with subcommands
  {
    name: 'CLUSTER',
    binhdrFlag: false,
    subcommands: [
      { name: 'SLOTS', binhdrFlag: true },
      { name: 'NODES', binhdrFlag: true },
      { name: 'INFO', binhdrFlag: true },
      { name: 'KEYSLOT', binhdrFlag: true },
      { name: 'SHARDS', binhdrFlag: true },
    ]
  },
  {
    name: 'CLIENT',
    binhdrFlag: false,
    subcommands: [
      { name: 'SETINFO', binhdrFlag: true },
      { name: 'SETNAME', binhdrFlag: true },
      { name: 'GETNAME', binhdrFlag: true },
      { name: 'ID', binhdrFlag: true },
      { name: 'LIST', binhdrFlag: true },
      { name: 'INFO', binhdrFlag: true },
      { name: 'PAUSE', binhdrFlag: false },
      { name: 'UNPAUSE', binhdrFlag: false },
    ]
  },
  {
    name: 'ACL',
    binhdrFlag: false,
    subcommands: [
      { name: 'CAT', binhdrFlag: true },
      { name: 'LIST', binhdrFlag: true },
      { name: 'WHOAMI', binhdrFlag: true },
    ]
  },
  {
    name: 'CONFIG',
    binhdrFlag: false,
    subcommands: [
      { name: 'GET', binhdrFlag: true },
      { name: 'SET', binhdrFlag: false },
      { name: 'REWRITE', binhdrFlag: false },
      { name: 'RESETSTAT', binhdrFlag: false },
    ]
  },
  {
    name: 'MEMORY',
    binhdrFlag: false,
    subcommands: [
      { name: 'USAGE', binhdrFlag: true },
      { name: 'DOCTOR', binhdrFlag: false },
      { name: 'STATS', binhdrFlag: false },
    ]
  },
  {
    name: 'OBJECT',
    binhdrFlag: false,
    subcommands: [
      { name: 'ENCODING', binhdrFlag: true },
      { name: 'FREQ', binhdrFlag: true },
      { name: 'IDLETIME', binhdrFlag: true },
      { name: 'REFCOUNT', binhdrFlag: true },
    ]
  },
  {
    name: 'XGROUP',
    binhdrFlag: false,
    subcommands: [
      { name: 'CREATE', binhdrFlag: true },
      { name: 'DESTROY', binhdrFlag: true },
      { name: 'SETID', binhdrFlag: true },
    ]
  },
  {
    name: 'XINFO',
    binhdrFlag: false,
    subcommands: [
      { name: 'GROUPS', binhdrFlag: true },
      { name: 'STREAM', binhdrFlag: true },
      { name: 'CONSUMERS', binhdrFlag: true },
    ]
  },
];

export function createMockBinhdrFetcher(): CommandBinhdrFetcher {
  return async () => STATIC_BINHDR_RECORDS;
}

export async function createDefaultResolver(): Promise<EligibilityResolver> {
  return DynamicEligibilityResolverFactory.create(createMockBinhdrFetcher());
}
