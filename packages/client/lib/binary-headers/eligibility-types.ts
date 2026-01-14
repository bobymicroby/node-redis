/**
 * Key position info for a command.
 * - If absent: first key is at index 1 (default for most commands)
 * - If keyless: true: command has no keys
 * - If keyPosition: number: first key is at that index
 */
export type KeyPositionInfo =
  | { readonly keyless: true }
  | { readonly keyPosition: number };

/**
 * Node storing eligibility info for a command.
 */
export interface EligibleNode {
  /** True if base command is eligible */
  readonly self: boolean;
  /** Key position info (absent = key at index 1) */
  readonly keyInfo?: KeyPositionInfo;
  /** Map of eligible subcommand names (UPPERCASE) to their key info */
  readonly subs?: ReadonlyMap<string, KeyPositionInfo | undefined>;
}

/**
 * Result of checking command eligibility.
 */
export type EligibilityResult =
  | { readonly eligible: false }
  | { readonly eligible: true; readonly firstKeyIndex: number | null };

/**
 * Raw reply structure from COMMAND BINHDR.
 * Used to build the eligibility map.
 */
export interface CommandBinhdrRawReply {
  readonly name: string;
  readonly binhdrFlag: boolean;
  /** Only present if command has no keys */
  readonly keyless?: true;
  /** Only present if first key is NOT at index 1 */
  readonly keyPosition?: number;
  readonly subcommands?: ReadonlyArray<CommandBinhdrRawReply>;
}

/**
 * Fetcher type for COMMAND BINHDR response.
 */
export type CommandBinhdrFetcher = () => Promise<ReadonlyArray<CommandBinhdrRawReply>>;
