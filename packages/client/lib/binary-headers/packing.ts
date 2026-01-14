import type { RedisArgument } from '../RESP/types';
import type { EligibilityResult } from './eligibility-types';
import { BINHDR } from './constants';
import { createRequestHeader, encodeRequestHeader } from './encoder';
import calculateSlot from 'cluster-key-slot';

/**
 * A command buffered for potential packing.
 */
export interface BufferedCommand {
  readonly command: ReadonlyArray<RedisArgument>;
  readonly resp: ReadonlyArray<RedisArgument>;
  readonly slot: number;
  readonly payloadLength: number;
}

/**
 * Strategy for deciding when to flush the packing buffer.
 */
export interface PackingStrategy {
  /**
   * Determine if buffer should be flushed before adding incoming command.
   * @param buffer - Currently buffered commands
   * @param incoming - New command to potentially add
   * @returns true if buffer should be flushed first
   */
  shouldFlush(
    buffer: ReadonlyArray<BufferedCommand>,
    incoming: BufferedCommand
  ): boolean;
}

/**
 * Default packing strategy: flush on incompatible slot.
 *
 * Rules:
 * - Max 127 commands per pack
 * - Commands must have compatible slots (same slot, or one is SLOT_NO_SLOT)
 * - Respects max payload length
 */
export function createDefaultPackingStrategy(): PackingStrategy {
  return {
    shouldFlush(
      buffer: ReadonlyArray<BufferedCommand>,
      incoming: BufferedCommand
    ): boolean {
      if (buffer.length === 0) {
        return false;
      }

      // Max commands per pack
      if (buffer.length >= BINHDR.MAX_COMMANDS_PER_PACK) {
        return true;
      }

      // Check slot compatibility
      const bufferSlot = resolveBufferSlot(buffer);
      if (!areSlotsCompatible(bufferSlot, incoming.slot)) {
        return true;
      }

      // Check payload length limit
      const totalPayload = sumPayloadLength(buffer) + incoming.payloadLength;
      if (totalPayload > BINHDR.MAX_PAYLOAD_LENGTH) {
        return true;
      }

      return false;
    }
  };
}

/**
 * Calculate slot from first key argument.
 * @param command - Raw command arguments
 * @param firstKeyIndex - Index of first key (null if keyless)
 * @returns Slot number or SLOT_NO_SLOT
 */
export function calculateCommandSlot(
  command: ReadonlyArray<RedisArgument>,
  firstKeyIndex: number | null
): number {
  if (firstKeyIndex === null || firstKeyIndex >= command.length) {
    return BINHDR.SLOT_NO_SLOT;
  }

  const key = command[firstKeyIndex];
  const keyStr = typeof key === 'string' ? key : key.toString();

  return calculateSlot(keyStr);
}

/**
 * Calculate total payload length of RESP-encoded parts.
 */
export function calculatePayloadLength(
  resp: ReadonlyArray<RedisArgument>
): number {
  let length = 0;
  for (let i = 0; i < resp.length; i++) {
    const part = resp[i];
    length += typeof part === 'string' ? Buffer.byteLength(part) : part.length;
  }
  return length;
}

/**
 * Resolve the effective slot for a buffer of commands.
 * Returns a known slot if any command has one, otherwise SLOT_NO_SLOT.
 */
function resolveBufferSlot(buffer: ReadonlyArray<BufferedCommand>): number {
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i].slot !== BINHDR.SLOT_NO_SLOT) {
      return buffer[i].slot;
    }
  }
  return BINHDR.SLOT_NO_SLOT;
}

/**
 * Check if two slots are compatible for packing.
 * Compatible if: same slot, or one/both are SLOT_NO_SLOT.
 */
function areSlotsCompatible(slotA: number, slotB: number): boolean {
  if (slotA === BINHDR.SLOT_NO_SLOT || slotB === BINHDR.SLOT_NO_SLOT) {
    return true;
  }
  return slotA === slotB;
}

/**
 * Sum payload lengths of buffered commands.
 */
function sumPayloadLength(buffer: ReadonlyArray<BufferedCommand>): number {
  let total = 0;
  for (let i = 0; i < buffer.length; i++) {
    total += buffer[i].payloadLength;
  }
  return total;
}

/**
 * Create a BufferedCommand from eligibility result and encoded data.
 */
export function createBufferedCommand(
  command: ReadonlyArray<RedisArgument>,
  resp: ReadonlyArray<RedisArgument>,
  eligibility: EligibilityResult
): BufferedCommand {
  const slot = eligibility.eligible
    ? calculateCommandSlot(command, eligibility.firstKeyIndex)
    : BINHDR.SLOT_NO_SLOT;

  return {
    command,
    resp,
    slot,
    payloadLength: calculatePayloadLength(resp),
  };
}

/**
 * Pack buffered commands into a single binary header frame.
 * @param buffer - Commands to pack
 * @param clientIdx - Client correlation ID
 * @returns Packed frame as array of RedisArgument, or null on failure
 */
export function packCommands(
  buffer: ReadonlyArray<BufferedCommand>,
  clientIdx: number = 0
): ReadonlyArray<RedisArgument> | null {
  if (buffer.length === 0) {
    return null;
  }

  const slot = resolveBufferSlot(buffer);
  const totalPayload = sumPayloadLength(buffer);

  const headerResult = createRequestHeader(
    totalPayload,
    buffer.length,
    slot,
    clientIdx
  );

  if (!headerResult.success) {
    return null;
  }

  const headerBuffer = encodeRequestHeader(headerResult.header);

  // Build result array: header + all RESP payloads concatenated
  let totalParts = 1; // header
  for (let i = 0; i < buffer.length; i++) {
    totalParts += buffer[i].resp.length;
  }

  const result = new Array<RedisArgument>(totalParts);
  result[0] = headerBuffer;

  let idx = 1;
  for (let i = 0; i < buffer.length; i++) {
    const resp = buffer[i].resp;
    for (let j = 0; j < resp.length; j++) {
      result[idx++] = resp[j];
    }
  }

  return result;
}

/**
 * CommandPacker accumulates eligible commands and packs them according to strategy.
 */
export class CommandPacker {
  readonly #strategy: PackingStrategy;
  readonly #buffer: BufferedCommand[] = [];

  constructor(strategy: PackingStrategy = createDefaultPackingStrategy()) {
    this.#strategy = strategy;
  }

  /**
   * Try to add a command to the buffer.
   * @returns Packed frame if buffer was flushed, null if command was buffered
   */
  add(buffered: BufferedCommand): ReadonlyArray<RedisArgument> | null {
    if (this.#strategy.shouldFlush(this.#buffer, buffered)) {
      const packed = packCommands(this.#buffer);
      this.#buffer.length = 0;
      this.#buffer.push(buffered);
      return packed;
    }

    this.#buffer.push(buffered);
    return null;
  }

  /**
   * Flush any remaining buffered commands.
   * @returns Packed frame or null if buffer is empty
   */
  flush(): ReadonlyArray<RedisArgument> | null {
    if (this.#buffer.length === 0) {
      return null;
    }

    const packed = packCommands(this.#buffer);
    this.#buffer.length = 0;
    return packed;
  }

  /**
   * Get current buffer size.
   */
  get bufferSize(): number {
    return this.#buffer.length;
  }
}
