import type { RedisArgument } from '../RESP/types';
import { RequestHeaderEncoder } from './generated/request-header-codec';
import type { SocketChunk } from '../client/commands-queue';
import type { Cancellable, Scheduler } from '../client/commands-queue';

// Re-export for convenience (canonical source is commands-queue.ts)
export type { Cancellable, Scheduler };

const NULL_SLOT = RequestHeaderEncoder.slotNullValue();
const MAX_COMMAND_COUNT = RequestHeaderEncoder.commandCountMaxValue();
const MAX_PAYLOAD_LENGTH = RequestHeaderEncoder.lengthMaxValue();

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
  if (slotA === NULL_SLOT || slotB === NULL_SLOT) return true;
  return slotA === slotB;
}

function toWireSlot(slot: number): number {
  return slot === NULL_SLOT ? 0 : slot;
}

export function calculatePayloadLength(resp: SocketChunk): number {
  let length = 0;
  for (let i = 0; i < resp.length; i++) {
    const part = resp[i];
    length += typeof part === 'string' ? Buffer.byteLength(part) : part.length;
  }
  return length;
}

/**
 * Batches commands into binary header frames for efficient proxy communication.
 */
export class CommandPacker {
  readonly #maxWaitMs: number | null;
  readonly #resps: Array<SocketChunk> = [];

  #resolvedSlot: number = NULL_SLOT;
  #totalPayloadLength: number = 0;
  #bufferStartTime: number | null = null;

  constructor(maxWaitMs: number | null = null) {
    this.#maxWaitMs = maxWaitMs;
  }

  add(
    resp: SocketChunk,
    slot: number,
    payloadLength: number
  ): SocketChunk | null {
    const count = this.#resps.length;

    if (count > 0 && !this.#canAdd(count, slot, payloadLength)) {
      const packed = this.#flush();
      this.#pushFirst(resp, slot, payloadLength);
      return packed;
    }

    if (count === 0) {
      this.#pushFirst(resp, slot, payloadLength);
    } else {
      this.#push(resp, slot, payloadLength);
    }
    return null;
  }

  drain(): SocketChunk | null {
    if (this.#resps.length === 0) return null;
    return this.#flush();
  }

  get bufferSize(): number {
    return this.#resps.length;
  }

  #canAdd(count: number, slot: number, payloadLength: number): boolean {
    if (this.#maxWaitMs !== null && this.#bufferStartTime !== null) {
      if ((performance.now() - this.#bufferStartTime) >= this.#maxWaitMs) return false;
    }
    if (count >= MAX_COMMAND_COUNT) return false;
    if (!areSlotsCompatible(this.#resolvedSlot, slot)) return false;
    if (this.#totalPayloadLength + payloadLength > MAX_PAYLOAD_LENGTH) return false;
    return true;
  }

  #pushFirst(resp: SocketChunk, slot: number, payloadLength: number): void {
    this.#resps.push(resp);
    this.#totalPayloadLength = payloadLength;
    if (this.#maxWaitMs !== null) {
      this.#bufferStartTime = performance.now();
    }
    if (slot !== NULL_SLOT) {
      this.#resolvedSlot = slot;
    }
  }

  #push(resp: SocketChunk, slot: number, payloadLength: number): void {
    this.#resps.push(resp);
    this.#totalPayloadLength += payloadLength;
    if (slot !== NULL_SLOT) {
      this.#resolvedSlot = slot;
    }
  }

  #flush(): SocketChunk {
    const count = this.#resps.length;

    // Allocate and encode header in one step
    const header = RequestHeaderEncoder.allocateAndEncode(
      toWireSlot(this.#resolvedSlot),
      this.#totalPayloadLength,
      count,
      0
    );

    let totalParts = 1;
    for (let i = 0; i < count; i++) {
      totalParts += this.#resps[i].length;
    }

    const result = new Array<RedisArgument>(totalParts);
    result[0] = header;

    let idx = 1;
    for (let i = 0; i < count; i++) {
      const resp = this.#resps[i];
      for (let j = 0; j < resp.length; j++) {
        result[idx++] = resp[j];
      }
    }

    this.#reset();
    return result;
  }

  #reset(): void {
    this.#resps.length = 0;
    this.#resolvedSlot = NULL_SLOT;
    this.#totalPayloadLength = 0;
    this.#bufferStartTime = null;
  }
}
