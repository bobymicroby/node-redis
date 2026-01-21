import type { RedisArgument } from '../RESP/types';
import type { EligibilityResult } from './eligibility-types';
import { BINHDR } from './generated/constants';
import { createRequestHeader, encodeRequestHeader } from './generated/encoder';

export interface BufferedCommand {
  readonly command: ReadonlyArray<RedisArgument>;
  readonly resp: ReadonlyArray<RedisArgument>;
  readonly slot: number;
  readonly payloadLength: number;
}

export interface PackState {
  readonly commandCount: number;
  readonly resolvedSlot: number;
  readonly totalPayloadLength: number;
  readonly bufferStartTime: number | null;
}

export interface PackingStrategy {
  canAdd(currentPack: PackState, incoming: BufferedCommand): boolean;
}

export interface Cancellable {
  cancel(): void;
}

export interface Scheduler {
  schedule(delayMs: number, task: () => void): Cancellable;
}

export function createTimeoutScheduler(): Scheduler {
  return {
    schedule(delayMs: number, task: () => void): Cancellable {
      const id = setTimeout(task, delayMs);
      return { cancel: () => clearTimeout(id) };
    }
  };
}

export function createImmediateScheduler(): Scheduler {
  return {
    schedule(_delayMs: number, task: () => void): Cancellable {
      const id = setImmediate(task);
      return { cancel: () => clearImmediate(id) };
    }
  };
}

export function createDefaultPackingStrategy(): PackingStrategy {
  return {
    canAdd(currentPack: PackState, incoming: BufferedCommand): boolean {
      if (currentPack.commandCount >= BINHDR.MAX_COMMANDS_PER_PACK) return false;
      if (!areSlotsCompatible(currentPack.resolvedSlot, incoming.slot)) return false;
      if (currentPack.totalPayloadLength + incoming.payloadLength > BINHDR.MAX_PAYLOAD_LENGTH) return false;
      return true;
    }
  };
}

export function createTimeBoundedPackingStrategy(maxWaitMs: number): PackingStrategy {
  return {
    canAdd(currentPack: PackState, incoming: BufferedCommand): boolean {
      if (currentPack.bufferStartTime !== null) {
        const elapsed = performance.now() - currentPack.bufferStartTime;
        if (elapsed >= maxWaitMs) return false;
      }

      if (currentPack.commandCount >= BINHDR.MAX_COMMANDS_PER_PACK) return false;
      if (!areSlotsCompatible(currentPack.resolvedSlot, incoming.slot)) return false;
      if (currentPack.totalPayloadLength + incoming.payloadLength > BINHDR.MAX_PAYLOAD_LENGTH) return false;
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

function toWireSlot(slot: number): number {
  return slot === BINHDR.SLOT_NO_SLOT ? 0 : slot;
}

export function packCommands(
  buffer: ReadonlyArray<BufferedCommand>,
  slot: number,
  totalPayload: number,
  requestId: number = 0
): ReadonlyArray<RedisArgument> | null {
  if (buffer.length === 0) return null;

  const headerResult = createRequestHeader(toWireSlot(slot), totalPayload, buffer.length, requestId);
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

export interface CommandPackerOptions {
  readonly strategy?: PackingStrategy;
  readonly maxWaitMs?: number;
}

export class CommandPacker {
  readonly #strategy: PackingStrategy;
  readonly #maxWaitMs: number | null;
  readonly #buffer: BufferedCommand[] = [];
  #resolvedSlot: number = BINHDR.SLOT_NO_SLOT;
  #totalPayloadLength: number = 0;
  #bufferStartTime: number | null = null;

  constructor(options: CommandPackerOptions = {}) {
    this.#strategy = options.strategy ?? createDefaultPackingStrategy();
    this.#maxWaitMs = options.maxWaitMs ?? null;
  }

  add(command: BufferedCommand): ReadonlyArray<RedisArgument> | null {
    const now = performance.now();

    if (this.#buffer.length > 0) {
      if (this.#isStale(now) || !this.#strategy.canAdd(this.#packState, command)) {
        const packed = this.#flush();
        this.#pushFirst(command, now);
        return packed;
      }
      this.#push(command);
      return null;
    }

    this.#pushFirst(command, now);
    return null;
  }

  flushIfStale(now: number = performance.now()): ReadonlyArray<RedisArgument> | null {
    if (this.#buffer.length === 0 || !this.#isStale(now)) return null;
    return this.#flush();
  }

  getStaleTime(): number | null {
    if (this.#maxWaitMs === null || this.#bufferStartTime === null) return null;
    return this.#bufferStartTime + this.#maxWaitMs;
  }

  drain(): ReadonlyArray<RedisArgument> | null {
    if (this.#buffer.length === 0) return null;
    return this.#flush();
  }

  get bufferSize(): number {
    return this.#buffer.length;
  }

  get bufferStartTime(): number | null {
    return this.#bufferStartTime;
  }

  get #packState(): PackState {
    return {
      commandCount: this.#buffer.length,
      resolvedSlot: this.#resolvedSlot,
      totalPayloadLength: this.#totalPayloadLength,
      bufferStartTime: this.#bufferStartTime,
    };
  }

  #isStale(now: number): boolean {
    if (this.#maxWaitMs === null || this.#bufferStartTime === null) return false;
    return (now - this.#bufferStartTime) >= this.#maxWaitMs;
  }

  #pushFirst(command: BufferedCommand, now: number): void {
    this.#buffer.push(command);
    this.#totalPayloadLength = command.payloadLength;
    this.#bufferStartTime = now;
    if (command.slot !== BINHDR.SLOT_NO_SLOT) {
      this.#resolvedSlot = command.slot;
    }
  }

  #push(command: BufferedCommand): void {
    this.#buffer.push(command);
    this.#totalPayloadLength += command.payloadLength;
    if (command.slot !== BINHDR.SLOT_NO_SLOT) {
      this.#resolvedSlot = command.slot;
    }
  }

  #flush(): ReadonlyArray<RedisArgument> | null {
    const packed = packCommands(this.#buffer, this.#resolvedSlot, this.#totalPayloadLength);
    this.#reset();
    return packed;
  }

  #reset(): void {
    this.#buffer.length = 0;
    this.#resolvedSlot = BINHDR.SLOT_NO_SLOT;
    this.#totalPayloadLength = 0;
    this.#bufferStartTime = null;
  }
}
