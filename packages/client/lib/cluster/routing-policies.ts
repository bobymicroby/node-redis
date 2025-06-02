import { RequestPolicy, REQUEST_POLICIES, RESPONSE_POLICIES } from "../commands/COMMAND";
import { ShardNode } from "./cluster-slots";
import { POLICIES } from "./static-policies";

export const REQUEST_POLICIES_WITH_DEFAULTS = {
  ...REQUEST_POLICIES,
  DEFAULT_KEYLESS: "default-keyless",
  DEFAULT_KEYED: "default-keyed"
} as const;

export type RequestPolicyWithDefaults = typeof REQUEST_POLICIES_WITH_DEFAULTS[keyof typeof REQUEST_POLICIES_WITH_DEFAULTS];
export const RESPONSE_POLICIES_WITH_DEFAULTS = {
  ...RESPONSE_POLICIES,
  DEFAULT_KEYLESS: "default-keyless",
  DEFAULT_KEYED: "default-keyed"
} as const;

export type ResponsePolicyWithDefaults = typeof RESPONSE_POLICIES_WITH_DEFAULTS[keyof typeof RESPONSE_POLICIES_WITH_DEFAULTS];

export interface CommandPolicies {
  readonly request: RequestPolicyWithDefaults;
  readonly response: ResponsePolicyWithDefaults;
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

  resolvePolicy(command: string): Either<CommandPolicies> {
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
