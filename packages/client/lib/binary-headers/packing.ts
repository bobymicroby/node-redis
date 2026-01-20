import type { RedisArgument } from '../RESP/types';
import type { EligibilityResult } from './eligibility-types';
import { BINHDR } from './constants';
import { createRequestHeader, encodeRequestHeader } from './encoder';

export interface BufferedCommand {
  readonly command: ReadonlyArray<RedisArgument>;
  readonly resp: ReadonlyArray<RedisArgument>;
  readonly slot: number;
  readonly payloadLength: number;
}

/**
 * Decides whether a command can be added to the current pack.
 * Called only when the buffer is non-empty (first command always buffers).
 * Returning false triggers a flush before adding the incoming command.
 */
export interface PackingStrategy {
  canAdd(
    count: number,
    slot: number,
    payloadLength: number,
    incoming: BufferedCommand
  ): boolean;
}

export function createDefaultPackingStrategy(): PackingStrategy {
  return {
    canAdd(count, slot, payloadLength, incoming) {
      if (count >= BINHDR.MAX_COMMANDS_PER_PACK) return false;
      if (!areSlotsCompatible(slot, incoming.slot)) return false;
      if (payloadLength + incoming.payloadLength > BINHDR.MAX_PAYLOAD_LENGTH) return false;
      return true;
    }
  };
}

export function calculatePayloadLength(resp: ReadonlyArray<RedisArgument>): number {
  let length = 0;
  for (let i = 0; i < resp.length; i++) {
    const part = resp[i];
    length += typeof part === 'string' ? Buffer.byteLength(part) : part.length;
  }
  return length;
}

function areSlotsCompatible(slotA: number, slotB: number): boolean {
  if (slotA === BINHDR.SLOT_NO_SLOT || slotB === BINHDR.SLOT_NO_SLOT) return true;
  return slotA === slotB;
}

export function createBufferedCommand(
  command: ReadonlyArray<RedisArgument>,
  resp: ReadonlyArray<RedisArgument>,
  eligibility: EligibilityResult & { eligible: true }
): BufferedCommand {
  return {
    command,
    resp,
    slot: eligibility.slot,
    payloadLength: calculatePayloadLength(resp),
  };
}

export function packCommands(
  buffer: ReadonlyArray<BufferedCommand>,
  slot: number,
  totalPayload: number,
  clientIdx: number = 0
): ReadonlyArray<RedisArgument> | null {
  if (buffer.length === 0) return null;

  const headerResult = createRequestHeader(totalPayload, buffer.length, slot, clientIdx);

  if (!headerResult.success) return null;

  const headerBuffer = encodeRequestHeader(headerResult.header);

  let totalParts = 1;
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
 * Buffers commands and packs them into binary header frames.
 *
 * Slot resolution: the pack's slot is the first non-NO_SLOT value seen.
 * Commands with incompatible slots trigger a flush before buffering.
 */
export class CommandPacker {
  readonly #strategy: PackingStrategy;
  readonly #buffer: BufferedCommand[] = [];
  #slot: number = BINHDR.SLOT_NO_SLOT;
  #payloadLength: number = 0;

  constructor(strategy: PackingStrategy = createDefaultPackingStrategy()) {
    this.#strategy = strategy;
  }

  add(command: BufferedCommand): ReadonlyArray<RedisArgument> | null {
    const count = this.#buffer.length;

    if (count > 0 && !this.#strategy.canAdd(count, this.#slot, this.#payloadLength, command)) {
      const packed = this.#flush();
      this.#push(command);
      return packed;
    }

    this.#push(command);
    return null;
  }

  /** Updates buffer and running state. First keyed command determines the pack's slot. */
  #push(command: BufferedCommand): void {
    this.#buffer.push(command);
    this.#payloadLength += command.payloadLength;
    if (command.slot !== BINHDR.SLOT_NO_SLOT) {
      this.#slot = command.slot;
    }
  }

  #flush(): ReadonlyArray<RedisArgument> | null {
    const packed = packCommands(this.#buffer, this.#slot, this.#payloadLength);
    this.#buffer.length = 0;
    this.#slot = BINHDR.SLOT_NO_SLOT;
    this.#payloadLength = 0;
    return packed;
  }

  drain(): ReadonlyArray<RedisArgument> | null {
    if (this.#buffer.length === 0) return null;
    return this.#flush();
  }

  get bufferSize(): number {
    return this.#buffer.length;
  }
}
