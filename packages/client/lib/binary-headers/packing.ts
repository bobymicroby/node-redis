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

export interface PackingStrategy {
  shouldFlush(
    buffer: ReadonlyArray<BufferedCommand>,
    incoming: BufferedCommand
  ): boolean;
}

export function createDefaultPackingStrategy(): PackingStrategy {
  return {
    shouldFlush(
      buffer: ReadonlyArray<BufferedCommand>,
      incoming: BufferedCommand
    ): boolean {
      if (buffer.length === 0) return false;
      if (buffer.length >= BINHDR.MAX_COMMANDS_PER_PACK) return true;

      const bufferSlot = resolveBufferSlot(buffer);
      if (!areSlotsCompatible(bufferSlot, incoming.slot)) return true;

      const totalPayload = sumPayloadLength(buffer) + incoming.payloadLength;
      if (totalPayload > BINHDR.MAX_PAYLOAD_LENGTH) return true;

      return false;
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

function resolveBufferSlot(buffer: ReadonlyArray<BufferedCommand>): number {
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i].slot !== BINHDR.SLOT_NO_SLOT) {
      return buffer[i].slot;
    }
  }
  return BINHDR.SLOT_NO_SLOT;
}

function areSlotsCompatible(slotA: number, slotB: number): boolean {
  if (slotA === BINHDR.SLOT_NO_SLOT || slotB === BINHDR.SLOT_NO_SLOT) return true;
  return slotA === slotB;
}

function sumPayloadLength(buffer: ReadonlyArray<BufferedCommand>): number {
  let total = 0;
  for (let i = 0; i < buffer.length; i++) {
    total += buffer[i].payloadLength;
  }
  return total;
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
  clientIdx: number = 0
): ReadonlyArray<RedisArgument> | null {
  if (buffer.length === 0) return null;

  const slot = resolveBufferSlot(buffer);
  const totalPayload = sumPayloadLength(buffer);
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

export class CommandPacker {
  readonly #strategy: PackingStrategy;
  readonly #buffer: BufferedCommand[] = [];

  constructor(strategy: PackingStrategy = createDefaultPackingStrategy()) {
    this.#strategy = strategy;
  }

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

  drain(): ReadonlyArray<RedisArgument> | null {
    if (this.#buffer.length === 0) return null;
    const packed = packCommands(this.#buffer);
    this.#buffer.length = 0;
    return packed;
  }

  get bufferSize(): number {
    return this.#buffer.length;
  }
}
