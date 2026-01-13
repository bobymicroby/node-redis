import type { RedisArgument } from '../RESP/types';
import type {
  BlockingBehavior,
  CommandBinhdrNode,
  CommandBinhdrRecords,
  CommandBinhdrRawReply,
  CommandBinhdrReply,
  CommandBinhdrFetcher,
  EligibilityResolver,
  EligibilityResult,
} from './eligibility-types';

function argToString(arg: RedisArgument): string {
  return typeof arg === 'string' ? arg : arg.toString('utf8');
}

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

    if (node.subcommands && redisArgs.length > 1) {
      const subcmd = argToString(redisArgs[1]).toUpperCase();
      const subResult = node.subcommands[subcmd];
      if (subResult) {
        return { ok: true, value: subResult };
      }
    }

    if (node.self) {
      return { ok: true, value: node.self };
    }

    return this.#fallback?.resolveEligibility(redisArgs)
      ?? { ok: false, error: 'unknown-command' };
  }

  withFallback(fallbackResolver: EligibilityResolver): StaticEligibilityResolver {
    return new StaticEligibilityResolver(this.#records, fallbackResolver);
  }
}

// ============================================================================
// Fast Eligibility Resolver - Optimized for hot path
// ============================================================================

// Separator for composite keys (command + subcommand)
const SUB_SEP = '\x00';

// Pre-allocated result objects to avoid allocations in hot path
const RESULT_UNKNOWN: EligibilityResult = { ok: false, error: 'unknown-command' };

/**
 * High-performance eligibility resolver optimized for the encoding hot path.
 *
 * Optimizations:
 * - Uses Map for O(1) lookup (faster than object for string keys)
 * - Flattens subcommands into single map with composite keys
 * - Pre-populates both UPPER and lower case variants
 * - Pre-allocates result objects to avoid GC pressure
 * - Inlines string conversion to avoid function call overhead
 */
export class FastEligibilityResolver implements EligibilityResolver {
  // Main lookup map: command -> result
  // For subcommands: "COMMAND\x00SUBCOMMAND" -> result
  readonly #map: Map<string, EligibilityResult>;

  // Commands that have subcommands (for two-part lookup)
  readonly #hasSubcommands: Set<string>;

  readonly #fallback: EligibilityResolver | null;

  constructor(
    map: Map<string, EligibilityResult>,
    hasSubcommands: Set<string>,
    fallback?: EligibilityResolver
  ) {
    this.#map = map;
    this.#hasSubcommands = hasSubcommands;
    this.#fallback = fallback ?? null;
  }

  resolveEligibility(redisArgs: ReadonlyArray<RedisArgument>): EligibilityResult {
    if (redisArgs.length === 0) {
      return RESULT_UNKNOWN;
    }

    // Inline string conversion (avoid function call)
    const arg0 = redisArgs[0];
    const cmd = typeof arg0 === 'string' ? arg0 : arg0.toString('utf8');

    // Fast path: direct lookup (works for pre-populated case variants)
    let result = this.#map.get(cmd);

    if (result === undefined) {
      // Try uppercase (commands might come in different cases)
      const upper = cmd.toUpperCase();
      result = this.#map.get(upper);

      if (result === undefined) {
        return this.#fallback?.resolveEligibility(redisArgs) ?? RESULT_UNKNOWN;
      }
    }

    // Check for subcommands only if this command has them
    if (redisArgs.length > 1 && this.#hasSubcommands.has(cmd.toUpperCase())) {
      const arg1 = redisArgs[1];
      const subcmd = typeof arg1 === 'string' ? arg1 : arg1.toString('utf8');

      // Try composite key: "CMD\x00SUBCMD"
      const compositeKey = cmd.toUpperCase() + SUB_SEP + subcmd.toUpperCase();
      const subResult = this.#map.get(compositeKey);

      if (subResult !== undefined) {
        return subResult;
      }
    }

    return result;
  }

  withFallback(fallbackResolver: EligibilityResolver): FastEligibilityResolver {
    return new FastEligibilityResolver(this.#map, this.#hasSubcommands, fallbackResolver);
  }

  /**
   * Create a FastEligibilityResolver from static records.
   */
  static fromRecords(records: CommandBinhdrRecords): FastEligibilityResolver {
    const map = new Map<string, EligibilityResult>();
    const hasSubcommands = new Set<string>();

    for (const [cmdUpper, node] of Object.entries(records)) {
      // Pre-allocate result object for this command
      if (node.self) {
        const result: EligibilityResult = { ok: true, value: node.self };

        // Add UPPERCASE version
        map.set(cmdUpper, result);

        // Add lowercase version for common commands
        map.set(cmdUpper.toLowerCase(), result);
      }

      // Handle subcommands
      if (node.subcommands) {
        hasSubcommands.add(cmdUpper);

        for (const [subUpper, subReply] of Object.entries(node.subcommands)) {
          const subResult: EligibilityResult = { ok: true, value: subReply };
          const compositeKey = cmdUpper + SUB_SEP + subUpper;

          map.set(compositeKey, subResult);
        }
      }
    }

    return new FastEligibilityResolver(map, hasSubcommands);
  }
}

// ============================================================================
// Ultra-Fast Eligibility Checker - Boolean only, maximum performance
// ============================================================================

/**
 * Ultra-fast eligibility checker optimized for the encoding hot path.
 * Returns just a boolean (eligible or not) - no result objects allocated.
 *
 * Optimizations over FastEligibilityResolver:
 * - Returns boolean instead of result object
 * - Single Map lookup for common case (no subcommands)
 * - Minimal branching in hot path
 */
export class UltraFastEligibilityChecker {
  // Direct lookup: command -> binhdrFlag (true = eligible)
  readonly #eligibleMap: Map<string, boolean>;

  // Commands with subcommands need special handling
  readonly #subcommandMap: Map<string, boolean>;

  // Set of commands that have subcommands
  readonly #hasSubcommands: Set<string>;

  private constructor(
    eligibleMap: Map<string, boolean>,
    subcommandMap: Map<string, boolean>,
    hasSubcommands: Set<string>
  ) {
    this.#eligibleMap = eligibleMap;
    this.#subcommandMap = subcommandMap;
    this.#hasSubcommands = hasSubcommands;
  }

  /**
   * Check if command is eligible for binary headers.
   * Ultra-fast path for common commands.
   */
  isEligible(redisArgs: ReadonlyArray<RedisArgument>): boolean {
    if (redisArgs.length === 0) {
      return false;
    }

    // Inline string conversion
    const arg0 = redisArgs[0];
    const cmd = typeof arg0 === 'string' ? arg0 : arg0.toString('utf8');

    // Fast path: direct lookup (works for pre-populated case variants)
    let eligible = this.#eligibleMap.get(cmd);

    if (eligible === undefined) {
      // Try uppercase
      const upper = cmd.toUpperCase();
      eligible = this.#eligibleMap.get(upper);

      if (eligible === undefined) {
        return false;
      }
    }

    // Check subcommands only for commands that have them
    if (eligible && redisArgs.length > 1) {
      const cmdUpper = cmd.toUpperCase();
      if (this.#hasSubcommands.has(cmdUpper)) {
        const arg1 = redisArgs[1];
        const subcmd = typeof arg1 === 'string' ? arg1 : arg1.toString('utf8');
        const compositeKey = cmdUpper + SUB_SEP + subcmd.toUpperCase();

        const subEligible = this.#subcommandMap.get(compositeKey);
        if (subEligible !== undefined) {
          return subEligible;
        }
      }
    }

    return eligible;
  }

  /**
   * Create from CommandBinhdrRecords.
   */
  static fromRecords(records: CommandBinhdrRecords): UltraFastEligibilityChecker {
    const eligibleMap = new Map<string, boolean>();
    const subcommandMap = new Map<string, boolean>();
    const hasSubcommands = new Set<string>();

    for (const [cmdUpper, node] of Object.entries(records)) {
      if (node.self) {
        const eligible = node.self.binhdrFlag;

        // Add both UPPER and lower case
        eligibleMap.set(cmdUpper, eligible);
        eligibleMap.set(cmdUpper.toLowerCase(), eligible);
      }

      if (node.subcommands) {
        hasSubcommands.add(cmdUpper);

        for (const [subUpper, subReply] of Object.entries(node.subcommands)) {
          const compositeKey = cmdUpper + SUB_SEP + subUpper;
          subcommandMap.set(compositeKey, subReply.binhdrFlag);
        }
      }
    }

    return new UltraFastEligibilityChecker(eligibleMap, subcommandMap, hasSubcommands);
  }
}

export class DynamicEligibilityResolverFactory {
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

  /**
   * Create a FastEligibilityResolver for high-performance lookups.
   */
  static async createFast(
    fetcher: CommandBinhdrFetcher,
    fallbackResolver?: EligibilityResolver
  ): Promise<FastEligibilityResolver> {
    const commands = await fetcher();
    const records: CommandBinhdrRecords = {};

    for (const command of commands) {
      const name = command.name.toUpperCase();
      records[name] = this.#buildNode(command);
    }

    const resolver = FastEligibilityResolver.fromRecords(records);
    return fallbackResolver ? resolver.withFallback(fallbackResolver) : resolver;
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
