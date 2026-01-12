import type { RedisArgument } from '../RESP/types';

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

export type EligibilityResolverError = 'unknown-command';

export type EligibilityResult = Either<CommandBinhdrReply, EligibilityResolverError>;

/**
 * Resolver interface for command binhdr eligibility.
 */
export interface EligibilityResolver {
  resolveEligibility(redisArgs: ReadonlyArray<RedisArgument>): EligibilityResult;
  withFallback(fallbackResolver: EligibilityResolver): EligibilityResolver;
}

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
