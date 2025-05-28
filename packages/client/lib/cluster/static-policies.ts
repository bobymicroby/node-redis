import { CommandPolicies, REQUEST_POLICIES, RESPONSE_POLICIES } from "./routing-policies";

export type CommandPolicyRecords = Record<string, CommandPolicies>;
// The response of the COMMAND command uses "." to separate the module name from the command name.
// For example, "ft.search" refers to the "search" command in the "ft" module. It is important to use the same naming convention here.
export type ModulePolicyRecords = Record<string, CommandPolicyRecords>;

export const POLICIES: ModulePolicyRecords = {
  std: {

  },
  ft: {
    create: {
      request: REQUEST_POLICIES.ALL_SHARDS,
      response: RESPONSE_POLICIES.ALL_SUCCEEDED
    },
    search: {
      request: REQUEST_POLICIES.ALL_SHARDS,
      response: RESPONSE_POLICIES.SPECIAL
    },
    aggregate: {
      request: REQUEST_POLICIES.ALL_SHARDS,
      response: RESPONSE_POLICIES.SPECIAL
    },
    sugadd: {
      request: REQUEST_POLICIES.DEFAULT_KEYED,
      response: RESPONSE_POLICIES.DEFAULT_KEYED
    },
    sugget: {
      request: REQUEST_POLICIES.DEFAULT_KEYED,
      response: RESPONSE_POLICIES.DEFAULT_KEYED
    },
    sugdel: {
      request: REQUEST_POLICIES.DEFAULT_KEYED,
      response: RESPONSE_POLICIES.DEFAULT_KEYED
    },
    suglen: {
      request: REQUEST_POLICIES.DEFAULT_KEYED,
      response: RESPONSE_POLICIES.DEFAULT_KEYED
    },
    spellcheck: {
      request: REQUEST_POLICIES.ALL_SHARDS,
      response: RESPONSE_POLICIES.SPECIAL
    },
    cursor: {
      request: REQUEST_POLICIES.SPECIAL,
      response: RESPONSE_POLICIES.DEFAULT_KEYLESS
    },
    dictadd: {
      request: REQUEST_POLICIES.ALL_SHARDS,
      response: RESPONSE_POLICIES.ALL_SUCCEEDED
    },
    dictdel: {
      request: REQUEST_POLICIES.ALL_SHARDS,
      response: RESPONSE_POLICIES.ALL_SUCCEEDED
    },
    dictdump: {
      request: REQUEST_POLICIES.DEFAULT_KEYLESS,
      response: RESPONSE_POLICIES.DEFAULT_KEYLESS
    }
  }
} as const;
