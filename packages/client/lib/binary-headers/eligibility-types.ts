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
