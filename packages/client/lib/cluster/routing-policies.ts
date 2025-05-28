import { ShardNode } from "./cluster-slots";
import { POLICIES } from "./static-policies";

export const REQUEST_POLICIES = {
  DEFAULT_KEYLESS: 'default_keyless',
  DEFAULT_KEYED: 'default_keyed',
  ALL_SHARDS: 'all_shards',
  SPECIAL: 'special'
} as const;

export const RESPONSE_POLICIES = {
  DEFAULT_KEYLESS: 'default_keyless',
  DEFAULT_KEYED: 'default_keyed',
  ALL_SUCCEEDED: 'all_succeeded',
  SPECIAL: 'special'
} as const;

export type RequestPolicy = (typeof REQUEST_POLICIES)[keyof typeof REQUEST_POLICIES];
export type ResponsePolicy = (typeof RESPONSE_POLICIES)[keyof typeof RESPONSE_POLICIES];

export interface CommandPolicies {
  readonly request: RequestPolicy;
  readonly response: ResponsePolicy;
}

export type Either<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: 'policy-not-found' | 'unknown-command' | 'unknown-module' | 'wrong-command-or-module-name' };
export interface PolicyResolver {

  /**
   * The response of the COMMAND command uses "." to separate the module name from the command name.
   *
  */
  resolvePolicy(command: string): Either<CommandPolicies>;
}

export class StaticPolicyResolver implements PolicyResolver {

  constructor(private readonly policies = POLICIES) { }

  resolvePolicy(command: string): Either<CommandPolicies> {// Count the number of dots in the command
    const parts = command.split('.');

    if (parts.length > 2) {
      return { ok: false, error: 'wrong-command-or-module-name' };
    }

    const [moduleName, commandName] = parts.length === 1
      ? ['std', command]
      : parts;

    if (!this.policies[moduleName]) {
      return { ok: false, error: 'unknown-module' };
    }

    if (!this.policies[moduleName][commandName]) {
      return { ok: false, error: 'unknown-command' };
    }

    return {
      ok: true,
      value: this.policies[moduleName][commandName]
    }


  }
}



export interface CommandRouter {
  routeCommand(
    command: string,
    policy: RequestPolicy,
  ): Either<ShardNode>;

}
