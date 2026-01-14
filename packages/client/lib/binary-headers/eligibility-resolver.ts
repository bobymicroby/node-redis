import type { RedisArgument } from '../RESP/types';
import type {
  EligibleNode,
  EligibilityResult,
  KeyPositionInfo,
  CommandBinhdrRawReply,
  CommandBinhdrFetcher,
} from './eligibility-types';

const DEFAULT_KEY_INDEX = 1;

function keyInfoToFirstKeyIndex(keyInfo: KeyPositionInfo | undefined): number | null {
  if (!keyInfo) {
    return DEFAULT_KEY_INDEX;
  }
  if ('keyless' in keyInfo) {
    return null;
  }
  return keyInfo.keyPosition;
}

/**
 * High-performance eligibility resolver.
 *
 * Optimizations:
 * - Map for O(1) command lookup
 * - Map for O(1) subcommand lookup
 * - UPPERCASE only (client always sends UPPERCASE)
 */
export class EligibilityResolver {
  readonly #map: Map<string, EligibleNode>;

  constructor(map: Map<string, EligibleNode>) {
    this.#map = map;
  }

  getEligibility(redisArgs: ReadonlyArray<RedisArgument>): EligibilityResult {
    const len = redisArgs.length;
    if (len === 0) {
      return { eligible: false };
    }

    const arg0 = redisArgs[0];
    const cmd = typeof arg0 === 'string' ? arg0 : arg0.toString('utf8');

    const node = this.#map.get(cmd);
    if (!node) {
      return { eligible: false };
    }

    // Check subcommand if present
    if (node.subs && len >= 2) {
      const arg1 = redisArgs[1];
      const subcmd = typeof arg1 === 'string' ? arg1 : arg1.toString('utf8');
      if (node.subs.has(subcmd)) {
        const subKeyInfo = node.subs.get(subcmd);
        return { eligible: true, firstKeyIndex: keyInfoToFirstKeyIndex(subKeyInfo) };
      }
    }

    // Fall back to base command eligibility
    if (node.self) {
      return { eligible: true, firstKeyIndex: keyInfoToFirstKeyIndex(node.keyInfo) };
    }

    return { eligible: false };
  }

  /**
   * Check if command is eligible for binary headers.
   * Convenience method that wraps getEligibility().
   */
  isEligible(redisArgs: ReadonlyArray<RedisArgument>): boolean {
    return this.getEligibility(redisArgs).eligible;
  }
}

function rawToKeyInfo(raw: CommandBinhdrRawReply): KeyPositionInfo | undefined {
  if (raw.keyless) {
    return { keyless: true };
  }
  if (raw.keyPosition !== undefined) {
    return { keyPosition: raw.keyPosition };
  }
  return undefined;
}

/**
 * Factory to create resolver from COMMAND BINHDR data.
 */
export class DynamicEligibilityResolverFactory {
  static async create(fetcher: CommandBinhdrFetcher): Promise<EligibilityResolver> {
    const commands = await fetcher();
    const map = new Map<string, EligibleNode>();

    for (const command of commands) {
      const name = command.name.toUpperCase();
      const node = this.#buildNode(command);

      if (node.self || node.subs) {
        map.set(name, node);
      }
    }

    return new EligibilityResolver(map);
  }

  static #buildNode(raw: CommandBinhdrRawReply): EligibleNode {
    const self = raw.binhdrFlag;
    const keyInfo = rawToKeyInfo(raw);

    if (raw.subcommands?.length) {
      const eligibleSubs = new Map<string, KeyPositionInfo | undefined>();

      for (const sub of raw.subcommands) {
        if (sub.binhdrFlag) {
          eligibleSubs.set(sub.name.toUpperCase(), rawToKeyInfo(sub));
        }
      }

      if (eligibleSubs.size > 0) {
        return { self, keyInfo, subs: eligibleSubs };
      }
    }

    return { self, keyInfo };
  }
}
