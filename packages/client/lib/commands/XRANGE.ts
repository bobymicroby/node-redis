import { RedisArgument, ArrayReply, UnwrapReply, Command, TypeMapping } from '../RESP/types';
import { StreamMessageRawReply, transformStreamMessageReply } from './generic-transformers';

export interface XRangeOptions {
  COUNT?: number;
}

export function transformXRangeArguments(
  command: RedisArgument,
  key: RedisArgument,
  start: RedisArgument,
  end: RedisArgument,
  options?: XRangeOptions
) {
  const args = [command, key, start, end];

  if (options?.COUNT) {
    args.push('COUNT', options.COUNT.toString());
  }

  return args;
}

export default {
  FIRST_KEY_INDEX: 1,
  IS_READ_ONLY: true,
  transformArguments: transformXRangeArguments.bind(undefined, 'XRANGE'),
  transformReply(
    reply: UnwrapReply<ArrayReply<StreamMessageRawReply>>,
    preserve?: any,
    typeMapping?: TypeMapping
  ) {
    return reply.map(transformStreamMessageReply.bind(undefined, typeMapping));
  }
} as const satisfies Command;
