import type { RedisArgument } from '../RESP/types';
import { BINHDR } from './constants';
import { createRequestHeader, encodeRequestHeader } from './encoder';
import calculateSlot from 'cluster-key-slot';

/**
 * Result of packing a single command with binary header
 */
export type PackSingleCommandResult =
  | { readonly success: true; readonly packed: ReadonlyArray<RedisArgument> }
  | { readonly success: false; readonly error: string };

/**
 * Calculate the total byte length of RESP-encoded command parts
 */
export function calculatePayloadLength(
  respEncoded: ReadonlyArray<RedisArgument>
): number {
  let length = 0;
  for (const part of respEncoded) {
    if (typeof part === 'string') {
      length += Buffer.byteLength(part);
    } else {
      length += part.length;
    }
  }
  return length;
}

/**
 * Pack a single RESP-encoded command with a binary header.
 */
export function packSingleCommand(
  respEncoded: ReadonlyArray<RedisArgument>,
  slot: number,
  clientIdx: number = 0
): PackSingleCommandResult {
  const payloadLength = calculatePayloadLength(respEncoded);

  const headerResult = createRequestHeader(
    payloadLength,
    1,
    slot,
    clientIdx
  );

  if (!headerResult.success) {
    return { success: false, error: headerResult.error };
  }

  const headerBuffer = encodeRequestHeader(headerResult.header);
  const packed: RedisArgument[] = [headerBuffer, ...respEncoded];

  return { success: true, packed };
}

/**
 * Calculate slot from keys using cluster-key-slot package.
 * Returns SLOT_NO_SLOT if no keys provided.
 */
export function calculateSlotFromKeys(keys: ReadonlyArray<RedisArgument>): number {
  if (keys.length === 0) {
    return BINHDR.SLOT_NO_SLOT;
  }

  const firstKey = keys[0];
  const keyStr = typeof firstKey === 'string' ? firstKey : firstKey.toString();

  return calculateSlot(keyStr);
}
