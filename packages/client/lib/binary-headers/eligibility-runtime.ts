import calculateSlot from 'cluster-key-slot';
import { BINHDR } from './constants';
import type { RedisArgument } from '../RESP/types';
import type {
  CommandBinhdrReply,
  EligibilityResolver,
  RuntimeEligibility,
} from './eligibility-types';

function argToString(arg: RedisArgument): string {
  return typeof arg === 'string' ? arg : arg.toString('utf8');
}

function isBlockingAtRuntime(
  info: CommandBinhdrReply,
  redisArgs: ReadonlyArray<RedisArgument>
): boolean {
  const blocking = info.blocking;
  switch (blocking.type) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'conditional':
      return redisArgs.some(arg =>
        argToString(arg).toUpperCase() === blocking.triggerArg
      );
  }
}

function calculateSlotForKeys(keys: ReadonlyArray<RedisArgument>): number | null {
  if (keys.length === 0) {
    return BINHDR.SLOT_NO_SLOT;
  }

  const firstSlot = calculateSlot(keys[0]);

  for (let i = 1; i < keys.length; i++) {
    if (calculateSlot(keys[i]) !== firstSlot) {
      return null;
    }
  }

  return firstSlot;
}

/**
 * Check if a command is eligible for binary headers at runtime.
 * Combines resolver metadata with actual args and keys.
 */
export function checkRuntimeEligibility(
  resolver: EligibilityResolver,
  redisArgs: ReadonlyArray<RedisArgument>,
  keys: ReadonlyArray<RedisArgument>
): RuntimeEligibility {
  const result = resolver.resolveEligibility(redisArgs);

  if (!result.ok) {
    return { eligible: false, slot: BINHDR.SLOT_NO_SLOT, reason: 'unknown_command' };
  }

  const info = result.value;

  if (!info.binhdrFlag) {
    if (info.name === 'BINDHR') {
      return { eligible: false, slot: BINHDR.SLOT_NO_SLOT, reason: 'binhdr_command' };
    }
    return { eligible: false, slot: BINHDR.SLOT_NO_SLOT, reason: 'no_binhdr_flag' };
  }

  if (isBlockingAtRuntime(info, redisArgs)) {
    return { eligible: false, slot: BINHDR.SLOT_NO_SLOT, reason: 'blocking' };
  }

  const slotResult = calculateSlotForKeys(keys);
  if (slotResult === null) {
    return { eligible: false, slot: BINHDR.SLOT_NO_SLOT, reason: 'cross_slot' };
  }

  return { eligible: true, slot: slotResult };
}
