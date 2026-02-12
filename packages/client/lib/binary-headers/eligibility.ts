import type { RedisArgument } from '../RESP/types';
import type { CommandArguments } from '../client/commands-queue';
import { RequestHeaderEncoder } from './generated/request-header-codec';
import { calculateSlot } from './new-slot-calulator';

export const SLOT_INELIGIBLE = -1;

const DEFAULT_KEY_INDEX = 1;
const NULL_SLOT = RequestHeaderEncoder.slotNullValue();

// Pre-allocated result objects to avoid allocations in hot path
const INELIGIBLE_RESULT: EligibilityResult = Object.freeze({ eligible: false });

// Pre-allocate eligible results for all possible slots (0-16383) + NULL_SLOT
const ELIGIBLE_RESULTS: ReadonlyArray<EligibilityResult> = (() => {
  const results: EligibilityResult[] = new Array(16385);
  for (let i = 0; i <= 16383; i++) {
    results[i] = Object.freeze({ eligible: true, slot: i });
  }
  results[16384] = Object.freeze({ eligible: true, slot: NULL_SLOT });
  return results;
})();

function getEligibleResult(slot: number): EligibilityResult {
  if (slot === NULL_SLOT) return ELIGIBLE_RESULTS[16384];
  return ELIGIBLE_RESULTS[slot];
}

export type KeyPosition =
  | { readonly keyless: true }
  | { readonly index: number };

export type BlockingBehavior =
  | { readonly type: 'always' }
  | { readonly type: 'conditional'; readonly argName: string };

export interface CommandAttrs {
  readonly keyPosition?: KeyPosition;
  readonly blocking?: BlockingBehavior;
}

export interface CommandNode extends CommandAttrs {
  readonly subs?: ReadonlyMap<string, CommandAttrs>;
}

export interface CommandRecord {
  readonly name: string;
  readonly keyPosition?: KeyPosition;
  readonly blocking?: BlockingBehavior;
  readonly subcommands?: ReadonlyArray<CommandRecord>;
}

export type EligibilityResult =
  | { readonly eligible: false }
  | { readonly eligible: true; readonly slot: number };

export type CommandRecordFetcher = () => Promise<ReadonlyArray<CommandRecord>>;

// Fast path: most commands are already uppercase strings
function getCommandUpper(arg: RedisArgument): string {
  if (typeof arg === 'string') {
    // Fast path: check if already uppercase (common case)
    const upper = arg.toUpperCase();
    return upper;
  }
  return arg.toString('utf8').toUpperCase();
}

function keyPositionToIndex(keyPosition: KeyPosition | undefined): number | null {
  if (!keyPosition) return DEFAULT_KEY_INDEX;
  if ('keyless' in keyPosition) return null;
  return keyPosition.index;
}

function calculateCommandSlot(args: CommandArguments, firstKeyIndex: number | null): number {
  if (firstKeyIndex === null || firstKeyIndex >= args.length) return NULL_SLOT;
  const key = args[firstKeyIndex];
  return calculateSlot(key);
}

// argName is pre-uppercased at build time
function hasBlockingArg(args: CommandArguments, upperArgName: string): boolean {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const argStr = typeof arg === 'string' ? arg : arg.toString('utf8');
    if (argStr.toUpperCase() === upperArgName) return true;
  }
  return false;
}

function isBlocking(args: CommandArguments, blocking: BlockingBehavior | undefined): boolean {
  if (!blocking) return false;
  if (blocking.type === 'always') return true;
  return hasBlockingArg(args, blocking.argName);
}

function getSlotForAttrs(args: CommandArguments, attrs: CommandAttrs): number {
  if (isBlocking(args, attrs.blocking)) return SLOT_INELIGIBLE;
  return calculateCommandSlot(args, keyPositionToIndex(attrs.keyPosition));
}

function buildCommandNode(record: CommandRecord): CommandNode {
  const { keyPosition, blocking } = record;

  // Pre-uppercase blocking argName at build time
  const processedBlocking = blocking?.type === 'conditional'
    ? { type: 'conditional' as const, argName: blocking.argName.toUpperCase() }
    : blocking;

  if (!record.subcommands?.length) {
    return { keyPosition, blocking: processedBlocking };
  }

  const subs = new Map<string, CommandAttrs>();
  for (const sub of record.subcommands) {
    const subBlocking = sub.blocking?.type === 'conditional'
      ? { type: 'conditional' as const, argName: sub.blocking.argName.toUpperCase() }
      : sub.blocking;
    subs.set(sub.name.toUpperCase(), {
      keyPosition: sub.keyPosition,
      blocking: subBlocking,
    });
  }

  return { keyPosition, blocking: processedBlocking, subs };
}

function buildCommandMap(records: ReadonlyArray<CommandRecord>): Map<string, CommandNode> {
  const map = new Map<string, CommandNode>();
  for (const record of records) {
    map.set(record.name.toUpperCase(), buildCommandNode(record));
  }
  return map;
}

export class EligibilityResolver {
  readonly #map: ReadonlyMap<string, CommandNode>;

  constructor(map: ReadonlyMap<string, CommandNode>) {
    this.#map = map;
  }

  getEligibility(args: CommandArguments): EligibilityResult {
    const slot = this.getSlot(args);
    if (slot === SLOT_INELIGIBLE) return INELIGIBLE_RESULT;
    return getEligibleResult(slot);
  }

  getSlot(args: CommandArguments): number {
    if (args.length === 0) return SLOT_INELIGIBLE;

    const node = this.#map.get(getCommandUpper(args[0]));
    if (!node) return SLOT_INELIGIBLE;

    if (node.subs && args.length >= 2) {
      const subAttrs = node.subs.get(getCommandUpper(args[1]));
      if (subAttrs) return getSlotForAttrs(args, subAttrs);
    }

    return getSlotForAttrs(args, node);
  }
}

export const NOOP_RESOLVER = new EligibilityResolver(new Map());

export async function createEligibilityResolver(fetcher: CommandRecordFetcher): Promise<EligibilityResolver> {
  const commands = await fetcher();
  return new EligibilityResolver(buildCommandMap(commands));
}

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
];

export const STATIC_RESOLVER = new EligibilityResolver(buildCommandMap(STATIC_COMMAND_RECORDS));

export function createMockRecordFetcher(): CommandRecordFetcher {
  return async () => STATIC_COMMAND_RECORDS;
}
