import type { RedisArgument } from '../RESP/types';
import type {
  EligibleNode,
  CommandBinhdrRawReply,
  CommandBinhdrFetcher,
} from './eligibility-types';

/**
 * High-performance eligibility resolver.
 *
 * Optimizations:
 * - Map for O(1) command lookup
 * - Set for O(1) subcommand lookup
 * - UPPERCASE only (client always sends UPPERCASE)
 * - Returns boolean directly (no object allocation)
 */
export class EligibilityResolver {
  readonly #map: Map<string, EligibleNode>;

  constructor(map: Map<string, EligibleNode>) {
    this.#map = map;
  }

  isEligible(redisArgs: ReadonlyArray<RedisArgument>): boolean {
    const len = redisArgs.length;
    if (len === 0) return false;

    const arg0 = redisArgs[0];
    const cmd = typeof arg0 === 'string' ? arg0 : arg0.toString('utf8');

    const node = this.#map.get(cmd);
    if (!node) return false;

    // Check subcommand if present
    if (node.subs && len >= 2) {
      const arg1 = redisArgs[1];
      const subcmd = typeof arg1 === 'string' ? arg1 : arg1.toString('utf8');
      if (node.subs.has(subcmd)) return true;
    }

    // Fall back to base command eligibility
    return node.self;
  }
}

/**
 * Factory to create resolver from COMMAND BINHDR data.
 * Eligibility is computed here - only eligible commands are stored.
 */
export class DynamicEligibilityResolverFactory {
  static async create(fetcher: CommandBinhdrFetcher): Promise<EligibilityResolver> {
    const commands = await fetcher();
    const map = new Map<string, EligibleNode>();

    for (const command of commands) {
      const name = command.name.toUpperCase();
      const node = this.#buildNode(command);

      // Only store if command or any subcommand is eligible
      if (node.self || node.subs) {
        map.set(name, node);
      }
    }

    return new EligibilityResolver(map);
  }

  static #buildNode(raw: CommandBinhdrRawReply): EligibleNode {
    const self = raw.binhdrFlag;

    if (raw.subcommands?.length) {
      const eligibleSubs = raw.subcommands
        .filter(sub => sub.binhdrFlag)
        .map(sub => sub.name.toUpperCase());

      if (eligibleSubs.length > 0) {
        return { self, subs: new Set(eligibleSubs) };
      }
    }

    return { self };
  }
}
