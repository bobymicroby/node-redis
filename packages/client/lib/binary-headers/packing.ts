import type { RedisArgument } from '../RESP/types';
import { RequestHeaderEncoder } from './generated/request-header-codec';
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

export function calculatePayloadLength(resp: ReadonlyArray<RedisArgument>): number {
  let length = 0;
  for (let i = 0; i < resp.length; i++) {
    const part = resp[i];
    length += typeof part === 'string' ? Buffer.byteLength(part) : part.length;
  }
  return length;
}

/**
 * Batches commands into binary header frames for efficient proxy communication.
 *
 * **Buffer Strategy:** We pre-allocate a single 16-byte header buffer and reuse it
 * across flushes, copying it into the result array. This is faster than allocating
 * a fresh buffer each time:
 *
 * - `allocateAndEncode()` = alloc + encode = ~14.6% overhead
 * - `encodeInto()` + `Buffer.from()` = encode + copy = ~8.9% overhead
 *
 * The copy is essential because callers may hold references to previous results
 * while we build the next batch (e.g., generator yielding multiple batches).
 */
export class CommandPacker {
  /** Pre-allocated header buffer, reused across flushes (contents copied on return) */
  readonly #headerBuffer: Buffer;
  readonly #maxWaitMs: number | null;
  readonly #resps: Array<ReadonlyArray<RedisArgument>> = [];

  #resolvedSlot: number = NULL_SLOT;
  #totalPayloadLength: number = 0;
  #bufferStartTime: number | null = null;

  constructor(maxWaitMs: number | null = null) {
    this.#headerBuffer = Buffer.allocUnsafe(RequestHeaderEncoder.ENCODED_LENGTH);
    this.#maxWaitMs = maxWaitMs;
  }

  add(
    resp: ReadonlyArray<RedisArgument>,
    slot: number,
    payloadLength: number
  ): ReadonlyArray<RedisArgument> | null {
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

  drain(): ReadonlyArray<RedisArgument> | null {
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

  #pushFirst(resp: ReadonlyArray<RedisArgument>, slot: number, payloadLength: number): void {
    this.#resps.push(resp);
    this.#totalPayloadLength = payloadLength;
    if (this.#maxWaitMs !== null) {
      this.#bufferStartTime = performance.now();
    }
    if (slot !== NULL_SLOT) {
      this.#resolvedSlot = slot;
    }
  }

  #push(resp: ReadonlyArray<RedisArgument>, slot: number, payloadLength: number): void {
    this.#resps.push(resp);
    this.#totalPayloadLength += payloadLength;
    if (slot !== NULL_SLOT) {
      this.#resolvedSlot = slot;
    }
  }

  #flush(): ReadonlyArray<RedisArgument> {
    const count = this.#resps.length;

    // Encode into pre-allocated buffer (reused across flushes)
    RequestHeaderEncoder.encodeInto(
      this.#headerBuffer,
      0,
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
    // IMPORTANT: Copy the header buffer! Caller may hold this reference while we
    // encode the next batch, which would corrupt their header. The 16-byte copy
    // is faster than allocating a fresh buffer each time (benchmarked).
    result[0] = Buffer.from(this.#headerBuffer);

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
