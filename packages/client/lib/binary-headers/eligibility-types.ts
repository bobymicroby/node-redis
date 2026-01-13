/**
 * Node storing eligibility info for a command.
 * Only eligible commands are stored - presence means eligible.
 */
export interface EligibleNode {
  /** True if base command is eligible (for fallback when subcommand not found) */
  readonly self: boolean;
  /** Set of eligible subcommand names (UPPERCASE) */
  readonly subs?: Set<string>;
}

/**
 * Raw reply structure from COMMAND BINHDR.
 * Used to build the eligibility map.
 */
export interface CommandBinhdrRawReply {
  readonly name: string;
  readonly binhdrFlag: boolean;
  readonly subcommands?: ReadonlyArray<CommandBinhdrRawReply>;
}

/**
 * Fetcher type for COMMAND BINHDR response.
 */
export type CommandBinhdrFetcher = () => Promise<ReadonlyArray<CommandBinhdrRawReply>>;
