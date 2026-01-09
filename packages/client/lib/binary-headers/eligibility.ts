import calculateSlot from 'cluster-key-slot';
import { BINHDR } from './constants';
import type { RedisArgument } from '../RESP/types';

// ============================================================================
// Core Types
// ============================================================================

/**
 * Either monad for typed error handling.
 */
export type Either<TOk, TError> =
  | { readonly ok: true; readonly value: TOk }
  | { readonly ok: false; readonly error: TError };

/**
 * Blocking behavior classification.
 */
export type BlockingBehavior =
  | { readonly type: 'never' }
  | { readonly type: 'always' }
  | { readonly type: 'conditional'; readonly triggerArg: string };

/**
 * Binary header eligibility info for a command (processed form).
 */
export interface CommandBinhdrReply {
  readonly name: string;
  readonly binhdrFlag: boolean;
  readonly hasKeys: boolean;
  readonly blocking: BlockingBehavior;
}

/**
 * Node in the resolver's internal structure.
 * Supports commands with subcommands (e.g., CLUSTER SLOTS, CLIENT SETINFO).
 */
export interface CommandBinhdrNode {
  readonly self?: CommandBinhdrReply;
  readonly subcommands?: Record<string, CommandBinhdrReply>;
}

/**
 * Internal records structure for the resolver.
 */
export type CommandBinhdrRecords = Record<string, CommandBinhdrNode>;

// ============================================================================
// Raw Reply Types (what COMMAND BINHDR returns / what mock produces)
// ============================================================================

/**
 * Raw reply structure from COMMAND BINHDR.
 * Mirrors Redis COMMAND response structure with nested subcommands.
 */
export interface CommandBinhdrRawReply {
  readonly name: string;
  readonly binhdrFlag: boolean;
  readonly hasKeys: boolean;
  readonly blockingType: 'never' | 'always' | 'conditional';
  readonly conditionalBlockingArg?: string;
  readonly subcommands?: ReadonlyArray<CommandBinhdrRawReply>;
}

/**
 * Fetcher type for COMMAND BINHDR response.
 */
export type CommandBinhdrFetcher = () => Promise<ReadonlyArray<CommandBinhdrRawReply>>;

// ============================================================================
// Resolver Types
// ============================================================================

export type EligibilityResolverError = 'unknown-command';

export type EligibilityResult = Either<CommandBinhdrReply, EligibilityResolverError>;

/**
 * Resolver interface for command binhdr eligibility.
 */
export interface EligibilityResolver {
  /**
   * Resolve eligibility for a command.
   * @param redisArgs - The parsed command arguments (from CommandParser.redisArgs)
   */
  resolveEligibility(redisArgs: ReadonlyArray<RedisArgument>): EligibilityResult;

  /**
   * Create a new resolver that falls back to another on failure.
   */
  withFallback(fallbackResolver: EligibilityResolver): EligibilityResolver;
}

// ============================================================================
// Runtime Eligibility Types
// ============================================================================

/**
 * Reasons why a command is not eligible for binary headers at runtime.
 */
export type EligibilityReason =
  | 'no_binhdr_flag'
  | 'blocking'
  | 'cross_slot'
  | 'binhdr_command'
  | 'unknown_command';

/**
 * Runtime eligibility result after checking args and keys.
 */
export interface RuntimeEligibility {
  readonly eligible: boolean;
  readonly slot: number;
  readonly reason?: EligibilityReason;
}

// ============================================================================
// Static Eligibility Resolver
// ============================================================================

export class StaticEligibilityResolver implements EligibilityResolver {
  readonly #records: CommandBinhdrRecords;
  readonly #fallback: EligibilityResolver | null;

  constructor(
    records: CommandBinhdrRecords,
    fallback?: EligibilityResolver
  ) {
    this.#records = records;
    this.#fallback = fallback ?? null;
  }

  resolveEligibility(redisArgs: ReadonlyArray<RedisArgument>): EligibilityResult {
    if (redisArgs.length === 0) {
      return { ok: false, error: 'unknown-command' };
    }

    const cmd = argToString(redisArgs[0]).toUpperCase();
    const node = this.#records[cmd];

    if (!node) {
      return this.#fallback?.resolveEligibility(redisArgs)
        ?? { ok: false, error: 'unknown-command' };
    }

    // If node has subcommands and we have more args, try subcommand first
    if (node.subcommands && redisArgs.length > 1) {
      const subcmd = argToString(redisArgs[1]).toUpperCase();
      const subResult = node.subcommands[subcmd];
      if (subResult) {
        return { ok: true, value: subResult };
      }
    }

    // Use parent command's eligibility (if it exists)
    if (node.self) {
      return { ok: true, value: node.self };
    }

    // Has subcommands but none matched, and no self
    return this.#fallback?.resolveEligibility(redisArgs)
      ?? { ok: false, error: 'unknown-command' };
  }

  withFallback(fallbackResolver: EligibilityResolver): StaticEligibilityResolver {
    return new StaticEligibilityResolver(this.#records, fallbackResolver);
  }
}

// ============================================================================
// Dynamic Resolver Factory
// ============================================================================

export class DynamicEligibilityResolverFactory {
  /**
   * Create a resolver by fetching eligibility data from the server.
   */
  static async create(
    fetcher: CommandBinhdrFetcher,
    fallbackResolver?: EligibilityResolver
  ): Promise<StaticEligibilityResolver> {
    const commands = await fetcher();
    const records: CommandBinhdrRecords = {};

    for (const command of commands) {
      const name = command.name.toUpperCase();
      records[name] = this.#buildNode(command);
    }

    return new StaticEligibilityResolver(records, fallbackResolver);
  }

  static #buildNode(raw: CommandBinhdrRawReply): CommandBinhdrNode {
    const self = this.#buildReply(raw);

    if (raw.subcommands?.length) {
      const subcommands: Record<string, CommandBinhdrReply> = {};
      for (const sub of raw.subcommands) {
        subcommands[sub.name.toUpperCase()] = this.#buildReply(sub);
      }
      return { self, subcommands };
    }

    return { self };
  }

  static #buildReply(raw: CommandBinhdrRawReply): CommandBinhdrReply {
    let blocking: BlockingBehavior;

    switch (raw.blockingType) {
      case 'always':
        blocking = { type: 'always' };
        break;
      case 'conditional':
        blocking = { type: 'conditional', triggerArg: raw.conditionalBlockingArg! };
        break;
      default:
        blocking = { type: 'never' };
    }

    return {
      name: raw.name.toUpperCase(),
      binhdrFlag: raw.binhdrFlag,
      hasKeys: raw.hasKeys,
      blocking,
    };
  }
}

// ============================================================================
// Runtime Eligibility Check
// ============================================================================

/**
 * Check if a command is eligible for binary headers at runtime.
 * This combines resolver metadata with actual args and keys.
 *
 * @param resolver - The eligibility resolver
 * @param redisArgs - The parsed command arguments
 * @param keys - The extracted keys for the command
 */
export function checkRuntimeEligibility(
  resolver: EligibilityResolver,
  redisArgs: ReadonlyArray<RedisArgument>,
  keys: ReadonlyArray<RedisArgument>
): RuntimeEligibility {
  // Resolve command eligibility metadata
  const result = resolver.resolveEligibility(redisArgs);

  if (!result.ok) {
    return {
      eligible: false,
      slot: BINHDR.SLOT_NO_SLOT,
      reason: 'unknown_command',
    };
  }

  const info = result.value;

  // Check binhdr flag
  if (!info.binhdrFlag) {
    // Check if it's the BINDHR command specifically
    if (info.name === 'BINDHR') {
      return {
        eligible: false,
        slot: BINHDR.SLOT_NO_SLOT,
        reason: 'binhdr_command',
      };
    }
    return {
      eligible: false,
      slot: BINHDR.SLOT_NO_SLOT,
      reason: 'no_binhdr_flag',
    };
  }

  // Check blocking behavior
  if (isBlockingAtRuntime(info, redisArgs)) {
    return {
      eligible: false,
      slot: BINHDR.SLOT_NO_SLOT,
      reason: 'blocking',
    };
  }

  // Check slot consistency
  const slotResult = calculateSlotForKeys(keys);
  if (slotResult === null) {
    return {
      eligible: false,
      slot: BINHDR.SLOT_NO_SLOT,
      reason: 'cross_slot',
    };
  }

  return {
    eligible: true,
    slot: slotResult,
  };
}

/**
 * Check if a command is blocking at runtime based on its args.
 */
function isBlockingAtRuntime(
  info: CommandBinhdrReply,
  redisArgs: ReadonlyArray<RedisArgument>
): boolean {
  const blocking = info.blocking;
  switch (blocking.type) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'conditional':
      return redisArgs.some(arg =>
        argToString(arg).toUpperCase() === blocking.triggerArg
      );
  }
}

/**
 * Calculate the slot for a list of keys.
 * Returns SLOT_NO_SLOT if no keys, null if cross-slot.
 */
function calculateSlotForKeys(keys: ReadonlyArray<RedisArgument>): number | null {
  if (keys.length === 0) {
    return BINHDR.SLOT_NO_SLOT;
  }

  const firstSlot = calculateSlot(keys[0]);

  for (let i = 1; i < keys.length; i++) {
    if (calculateSlot(keys[i]) !== firstSlot) {
      return null; // Cross-slot
    }
  }

  return firstSlot;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert a RedisArgument to string.
 */
function argToString(arg: RedisArgument): string {
  return typeof arg === 'string' ? arg : arg.toString('utf8');
}

// ============================================================================
// Static Records
// ============================================================================

const NEVER = 'never' as const;
const ALWAYS = 'always' as const;
const CONDITIONAL = 'conditional' as const;

/**
 * Static eligibility records.
 * This serves as fallback and will be replaced by COMMAND BINHDR response.
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
  { name: 'DBSIZE', binhdrFlag: false, hasKeys: false, blockingType: NEVER }, // Has request_policy

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
      { name: 'SET', binhdrFlag: false, hasKeys: false, blockingType: NEVER }, // Admin command
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

// ============================================================================
// Mock Fetcher
// ============================================================================

/**
 * Creates a mock fetcher that returns static records.
 * Replace with actual COMMAND BINHDR parser later.
 */
export function createMockBinhdrFetcher(): CommandBinhdrFetcher {
  return async () => STATIC_BINHDR_RECORDS;
}

/**
 * Create a static resolver from the built-in records.
 */
export async function createDefaultResolver(): Promise<StaticEligibilityResolver> {
  return DynamicEligibilityResolverFactory.create(createMockBinhdrFetcher());
}

/**
 * A resolver that returns "not eligible" for all commands.
 * Used as initial state before async eligibility data is fetched.
 */
class PendingEligibilityResolver implements EligibilityResolver {
  resolveEligibility(_redisArgs: ReadonlyArray<RedisArgument>): EligibilityResult {
    return {
      ok: false,
      error: 'unknown-command'
    };
  }

  withFallback(_fallbackResolver: EligibilityResolver): EligibilityResolver {
    return this;
  }
}

/**
 * A resolver that starts pending and upgrades to a real resolver once fetched.
 * All commands are ineligible until the async fetch completes.
 */
export class AsyncEligibilityResolver implements EligibilityResolver {
  #inner: EligibilityResolver = new PendingEligibilityResolver();
  #ready = false;

  get isReady(): boolean {
    return this.#ready;
  }

  /**
   * Start fetching eligibility data in the background.
   * Returns a promise that resolves when the resolver is ready.
   */
  async initialize(fetcher: CommandBinhdrFetcher = createMockBinhdrFetcher()): Promise<void> {
    const resolver = await DynamicEligibilityResolverFactory.create(fetcher);
    this.#inner = resolver;
    this.#ready = true;
  }

  resolveEligibility(redisArgs: ReadonlyArray<RedisArgument>): EligibilityResult {
    return this.#inner.resolveEligibility(redisArgs);
  }

  withFallback(fallbackResolver: EligibilityResolver): EligibilityResolver {
    return this.#inner.withFallback(fallbackResolver);
  }
}

/**
 * Create an async resolver that starts pending and fetches eligibility in background.
 * All commands are ineligible until initialization completes.
 */
export function createAsyncResolver(): AsyncEligibilityResolver {
  const resolver = new AsyncEligibilityResolver();
  // Fire and forget - initialization happens in background
  resolver.initialize().catch(() => {
    // Silently ignore errors - resolver stays in pending state
  });
  return resolver;
}
