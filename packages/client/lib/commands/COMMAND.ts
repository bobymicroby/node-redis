import { CommandParser } from '../client/parser';
import { ArrayReply, Command, UnwrapReply } from '../RESP/types';
import { CommandRawReply, CommandReply, transformCommandReply } from './generic-transformers';


export const REQUEST_POLICIES = {
  ALL_NODES: "all_nodes",
  ALL_SHARDS: "all_shards",
  MULTI_SHARD: "multi_shard",
  SPECIAL: "special"
} as const;

export const RESPONSE_POLICIES = {
  ONE_SUCCEEDED: "one_succeeded",
  ALL_SUCCEEDED: "all_succeeded",
  AGG_LOGICAL_AND: "agg_logical_and",
  AGG_LOGICAL_OR: "agg_logical_or",
  AGG_MIN: "agg_min",
  AGG_MAX: "agg_max",
  AGG_SUM: "agg_sum",
  SPECIAL: "special"
} as const;

export type ResponsePolicy = typeof RESPONSE_POLICIES[keyof typeof RESPONSE_POLICIES];
export type RequestPolicy = typeof REQUEST_POLICIES[keyof typeof REQUEST_POLICIES];

export default {
  NOT_KEYED_COMMAND: true,
  IS_READ_ONLY: true,
  parseCommand(parser: CommandParser) {
    parser.push('COMMAND');
  },
  // TODO: This works, as we don't currently handle any of the items returned as a map
  transformReply(reply: UnwrapReply<ArrayReply<CommandRawReply>>): Array<CommandReply> {
    return reply.map(transformCommandReply);
  }
} as const satisfies Command;
