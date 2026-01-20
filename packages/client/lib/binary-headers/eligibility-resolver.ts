import type { RedisArgument } from '../RESP/types';
import type {
  CommandNode,
  CommandAttrs,
  CommandRecord,
  CommandRecordFetcher,
  KeyPosition,
  BlockingBehavior,
  EligibilityResult,
} from './eligibility-types';
import { BINHDR } from './generated/constants';
import calculateSlot from 'cluster-key-slot';

const DEFAULT_KEY_INDEX = 1;

function argToString(arg: RedisArgument): string {
  return typeof arg === 'string' ? arg : arg.toString('utf8');
}

function keyPositionToIndex(keyPosition: KeyPosition | undefined): number | null {
  if (!keyPosition) return DEFAULT_KEY_INDEX;
  if ('keyless' in keyPosition) return null;
  return keyPosition.index;
}

function calculateCommandSlot(args: ReadonlyArray<RedisArgument>, firstKeyIndex: number | null): number {
  if (firstKeyIndex === null || firstKeyIndex >= args.length) return BINHDR.SLOT_NO_SLOT;
  const key = args[firstKeyIndex];
  const keyStr = typeof key === 'string' ? key : key.toString();
  return calculateSlot(keyStr);
}

function hasBlockingArg(args: ReadonlyArray<RedisArgument>, argName: string): boolean {
  const upperArgName = argName.toUpperCase();
  for (let i = 1; i < args.length; i++) {
    const str = argToString(args[i]);
    if (str.toUpperCase() === upperArgName) return true;
  }
  return false;
}

function isBlocking(args: ReadonlyArray<RedisArgument>, blocking: BlockingBehavior | undefined): boolean {
  if (!blocking) return false;
  if (blocking.type === 'always') return true;
  return hasBlockingArg(args, blocking.argName);
}

function calculateEligibility(args: ReadonlyArray<RedisArgument>, attrs: CommandAttrs): EligibilityResult {
  if (isBlocking(args, attrs.blocking)) {
    return { eligible: false };
  }
  const firstKeyIndex = keyPositionToIndex(attrs.keyPosition);
  const slot = calculateCommandSlot(args, firstKeyIndex);
  return { eligible: true, slot };
}

/**
 * Determines if a command can be packed with binary headers.
 *
 * Ineligible: unknown commands, blocking commands (BLPOP, XREAD with BLOCK).
 * Eligible commands return their slot for pack grouping.
 */
export class EligibilityResolver {
  readonly #map: Map<string, CommandNode>;

  constructor(map: Map<string, CommandNode>) {
    this.#map = map;
  }

  getEligibility(args: ReadonlyArray<RedisArgument>): EligibilityResult {
    if (args.length === 0) return { eligible: false };

    const cmd = argToString(args[0]);
    const node = this.#map.get(cmd);
    if (!node) return { eligible: false };

    if (node.subs && args.length >= 2) {
      const subcmd = argToString(args[1]);
      const subAttrs = node.subs.get(subcmd);
      if (subAttrs) return calculateEligibility(args, subAttrs);
    }

    return calculateEligibility(args, node);
  }
}

function buildCommandNode(record: CommandRecord): CommandNode {
  const { keyPosition, blocking } = record;

  if (!record.subcommands?.length) {
    return { keyPosition, blocking };
  }

  const subs = new Map<string, CommandAttrs>();
  for (const sub of record.subcommands) {
    subs.set(sub.name.toUpperCase(), {
      keyPosition: sub.keyPosition,
      blocking: sub.blocking,
    });
  }

  return { keyPosition, blocking, subs };
}

export async function createEligibilityResolver(fetcher: CommandRecordFetcher): Promise<EligibilityResolver> {
  const commands = await fetcher();
  const map = new Map<string, CommandNode>();

  for (const command of commands) {
    map.set(command.name.toUpperCase(), buildCommandNode(command));
  }

  return new EligibilityResolver(map);
}
