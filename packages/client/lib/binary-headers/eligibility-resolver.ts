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
