import type { CommandPolicies } from './policies-constants';

export type Either<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: 'policy-not-found' | 'unknown-command' | 'unknown-module' | 'wrong-command-or-module-name' | 'no-policy-resolved' };

export interface PolicyResolver {
  /**
   * The response of the COMMAND command uses "." to separate the module name from the command name.
   */
  resolvePolicy(command: string): Either<CommandPolicies>;

  /**
   * Sets a fallback resolver to use when policies are not found in this resolver.
   * 
   * @param fallbackResolver The resolver to fall back to
   * @returns A new PolicyResolver with the specified fallback
   */
  withFallback(fallbackResolver: PolicyResolver): PolicyResolver;
}