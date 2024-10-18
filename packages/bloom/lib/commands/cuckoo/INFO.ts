import { RedisArgument, Command, NumberReply, TuplesToMapReply, UnwrapReply, Resp2Reply, SimpleStringReply, TypeMapping } from '@redis/client/dist/lib/RESP/types';
import { transformInfoV2Reply } from '../bloom';

export type CfInfoReplyMap = TuplesToMapReply<[
  [SimpleStringReply<'Size'>, NumberReply],
  [SimpleStringReply<'Number of buckets'>, NumberReply],
  [SimpleStringReply<'Number of filters'>, NumberReply],
  [SimpleStringReply<'Number of items inserted'>, NumberReply],
  [SimpleStringReply<'Number of items deleted'>, NumberReply],
  [SimpleStringReply<'Bucket size'>, NumberReply],
  [SimpleStringReply<'Expansion rate'>, NumberReply],
  [SimpleStringReply<'Max iterations'>, NumberReply]
]>;

export default {
  FIRST_KEY_INDEX: 1,
  IS_READ_ONLY: true,
  transformArguments(key: RedisArgument) {
    return ['CF.INFO', key];
  },
  transformReply: {
    2: (reply: UnwrapReply<Resp2Reply<CfInfoReplyMap>>, _, typeMapping?: TypeMapping): CfInfoReplyMap => {
      return transformInfoV2Reply<CfInfoReplyMap>(reply, typeMapping);
    },
    3: undefined as unknown as () => CfInfoReplyMap
  }
} as const satisfies Command;
