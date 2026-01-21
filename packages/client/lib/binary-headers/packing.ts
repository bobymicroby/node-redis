import type { RedisArgument } from '../RESP/types';
import type { EligibilityResult } from './eligibility-types';
import { RequestHeaderEncoder } from './generated/request-header-codec';

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

export interface CommandPackerOptions {
  readonly strategy?: PackingStrategy;
  readonly maxWaitMs?: number;
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

function areSlotsCompatible(slotA: number, slotB: number): boolean {
  const nullSlot = RequestHeaderEncoder.slotNullValue();
  if (slotA === nullSlot || slotB === nullSlot) return true;
  return slotA === slotB;
}

function toWireSlot(slot: number): number {
  return slot === RequestHeaderEncoder.slotNullValue() ? 0 : slot;
}

export function calculatePayloadLength(resp: ReadonlyArray<RedisArgument>): number {
  let length = 0;
  for (let i = 0; i < resp.length; i++) {
    const part = resp[i];
    length += typeof part === 'string' ? Buffer.byteLength(part) : part.length;
  }
  return length;
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

export function createDefaultPackingStrategy(): PackingStrategy {
  return {
    canAdd(currentPack: PackState, incoming: BufferedCommand): boolean {
      if (currentPack.commandCount >= RequestHeaderEncoder.commandCountMaxValue()) return false;
      if (!areSlotsCompatible(currentPack.resolvedSlot, incoming.slot)) return false;
      if (currentPack.totalPayloadLength + incoming.payloadLength > RequestHeaderEncoder.lengthMaxValue()) return false;
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

      if (currentPack.commandCount >= RequestHeaderEncoder.commandCountMaxValue()) return false;
      if (!areSlotsCompatible(currentPack.resolvedSlot, incoming.slot)) return false;
      if (currentPack.totalPayloadLength + incoming.payloadLength > RequestHeaderEncoder.lengthMaxValue()) return false;
      return true;
    }
  };
}

function canAddInline(
  commandCount: number,
  resolvedSlot: number,
  totalPayloadLength: number,
  incomingSlot: number,
  incomingPayloadLength: number
): boolean {
  if (commandCount >= RequestHeaderEncoder.commandCountMaxValue()) return false;
  if (!areSlotsCompatible(resolvedSlot, incomingSlot)) return false;
  if (totalPayloadLength + incomingPayloadLength > RequestHeaderEncoder.lengthMaxValue()) return false;
  return true;
}

export class PackBufferPool {
  readonly #headerBuffer: Buffer;

  constructor() {
    this.#headerBuffer = Buffer.allocUnsafe(RequestHeaderEncoder.ENCODED_LENGTH);
  }

  pack(
    commands: ReadonlyArray<BufferedCommand>,
    slot: number,
    totalPayload: number,
    requestId: number
  ): ReadonlyArray<RedisArgument> | null {
    if (commands.length === 0) return null;

    RequestHeaderEncoder.encodeInto(
      this.#headerBuffer,
      0,
      toWireSlot(slot),
      totalPayload,
      commands.length,
      requestId
    );

    let totalParts = 1;
    for (let i = 0; i < commands.length; i++) {
      totalParts += commands[i].resp.length;
    }

    const result = new Array<RedisArgument>(totalParts);
    result[0] = this.#headerBuffer;

    let idx = 1;
    for (let i = 0; i < commands.length; i++) {
      const resp = commands[i].resp;
      for (let j = 0; j < resp.length; j++) {
        result[idx++] = resp[j];
      }
    }

    return result;
  }
}

export function packCommands(
  buffer: ReadonlyArray<BufferedCommand>,
  slot: number,
  totalPayload: number,
  requestId: number = 0
): ReadonlyArray<RedisArgument> | null {
  if (buffer.length === 0) return null;

  const headerBuffer = RequestHeaderEncoder.allocateAndEncode(
    toWireSlot(slot),
    totalPayload,
    buffer.length,
    requestId
  );

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
  readonly #strategy: PackingStrategy | null;
  readonly #maxWaitMs: number | null;
  readonly #pool: PackBufferPool;
  readonly #buffer: BufferedCommand[] = [];
  #resolvedSlot: number = RequestHeaderEncoder.slotNullValue();
  #totalPayloadLength: number = 0;
  #bufferStartTime: number | null = null;

  constructor(options: CommandPackerOptions = {}) {
    this.#strategy = options.strategy ?? null;
    this.#maxWaitMs = options.maxWaitMs ?? null;
    this.#pool = new PackBufferPool();
  }

  add(command: BufferedCommand): ReadonlyArray<RedisArgument> | null {
    const bufferLength = this.#buffer.length;

    if (bufferLength > 0) {
      const isStale = this.#maxWaitMs !== null && this.#isStale(performance.now());

      const canAdd = !isStale && (this.#strategy !== null
        ? this.#strategy.canAdd(this.#packState, command)
        : canAddInline(
            bufferLength,
            this.#resolvedSlot,
            this.#totalPayloadLength,
            command.slot,
            command.payloadLength
          ));

      if (!canAdd) {
        const packed = this.#flush();
        this.#pushFirst(command);
        return packed;
      }
      this.#push(command);
      return null;
    }

    this.#pushFirst(command);
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

  #pushFirst(command: BufferedCommand): void {
    this.#buffer.push(command);
    this.#totalPayloadLength = command.payloadLength;
    if (this.#maxWaitMs !== null) {
      this.#bufferStartTime = performance.now();
    }
    if (command.slot !== RequestHeaderEncoder.slotNullValue()) {
      this.#resolvedSlot = command.slot;
    }
  }

  #push(command: BufferedCommand): void {
    this.#buffer.push(command);
    this.#totalPayloadLength += command.payloadLength;
    if (command.slot !== RequestHeaderEncoder.slotNullValue()) {
      this.#resolvedSlot = command.slot;
    }
  }

  #flush(): ReadonlyArray<RedisArgument> | null {
    const packed = this.#pool.pack(
      this.#buffer,
      this.#resolvedSlot,
      this.#totalPayloadLength,
      0
    );
    this.#reset();
    return packed;
  }

  #reset(): void {
    this.#buffer.length = 0;
    this.#resolvedSlot = RequestHeaderEncoder.slotNullValue();
    this.#totalPayloadLength = 0;
    this.#bufferStartTime = null;
  }
}
