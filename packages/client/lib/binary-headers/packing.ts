import type { RedisArgument } from '../RESP/types';
import { RequestHeaderEncoder } from './generated/request-header-codec';
import type { SocketChunk } from '../client/commands-queue';
import type { Cancellable, Scheduler } from '../client/commands-queue';
import { FlushReason, disabledBinaryHeaderStatsCounter } from './stats';
import type { BinaryHeaderStatsCounter } from './stats';

// Re-export for convenience (canonical source is commands-queue.ts)
export type { Cancellable, Scheduler };

const NULL_SLOT = RequestHeaderEncoder.slotNullValue();

/**
 * Options for CommandPacker flush thresholds.
 */
export interface CommandPackerOptions {
  /**
   * Maximum number of commands per batch before triggering a flush.
   * Must be >= 1 and <= RequestHeaderEncoder.commandCountMaxValue().
   * Defaults to RequestHeaderEncoder.commandCountMaxValue().
   */
  maxCommandCount?: number;

  /**
   * Maximum payload length in bytes before triggering a flush.
   * Must be >= 1 and <= RequestHeaderEncoder.lengthMaxValue().
   * Defaults to RequestHeaderEncoder.lengthMaxValue().
   */
  maxPayloadLength?: number;

  /**
   * Initial clientIdx value for request headers.
   * Must be between 0 and RequestHeaderEncoder.clientIdxMaxValue().
   * Defaults to 0.
   */
  initialClientIdx?: number;
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
  if (slotA === NULL_SLOT || slotB === NULL_SLOT) return true;
  return slotA === slotB;
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
  readonly #statsCounter: BinaryHeaderStatsCounter;
  readonly #maxCommandCount: number;
  readonly #maxPayloadLength: number;
  // Pre-allocate array to avoid reallocations - use index instead of push/length=0
  readonly #resps: Array<SocketChunk | undefined>;
  #respCount: number = 0;

  #resolvedSlot: number = NULL_SLOT;
  #totalPayloadLength: number = 0;
  #nextClientIdx: number;

  constructor(
    statsCounter?: BinaryHeaderStatsCounter,
    options?: CommandPackerOptions
  ) {
    this.#statsCounter = statsCounter ?? disabledBinaryHeaderStatsCounter();

    const codecMaxCommandCount = RequestHeaderEncoder.commandCountMaxValue();
    const codecMaxPayloadLength = RequestHeaderEncoder.lengthMaxValue();

    this.#maxCommandCount = options?.maxCommandCount ?? codecMaxCommandCount;
    this.#maxPayloadLength = options?.maxPayloadLength ?? codecMaxPayloadLength;

    // Validate bounds
    if (this.#maxCommandCount < 1 || this.#maxCommandCount > codecMaxCommandCount) {
      throw new Error(`maxCommandCount must be between 1 and ${codecMaxCommandCount}, got ${this.#maxCommandCount}`);
    }
    if (this.#maxPayloadLength < 1 || this.#maxPayloadLength > codecMaxPayloadLength) {
      throw new Error(`maxPayloadLength must be between 1 and ${codecMaxPayloadLength}, got ${this.#maxPayloadLength}`);
    }

    const initialClientIdx = options?.initialClientIdx ?? 0;
    const codecMaxClientIdx = RequestHeaderEncoder.clientIdxMaxValue();
    if (
      !Number.isInteger(initialClientIdx) ||
      initialClientIdx < 0 ||
      initialClientIdx > codecMaxClientIdx
    ) {
      throw new Error(`initialClientIdx must be an integer between 0 and ${codecMaxClientIdx}, got ${initialClientIdx}`);
    }
    this.#nextClientIdx = initialClientIdx;

    // Pre-allocate array to max size to avoid reallocations
    this.#resps = new Array(this.#maxCommandCount);
  }

  add(
    resp: SocketChunk,
    slot: number,
    payloadLength: number
  ): SocketChunk | null {
    const count = this.#respCount;

    if (count > 0) {
      const flushReason = this.#getFlushReason(count, slot, payloadLength);
      if (flushReason !== null) {
        const packed = this.#flush(flushReason);
        this.#pushFirst(resp, slot, payloadLength);
        return packed;
      }
    }

    if (count === 0) {
      this.#pushFirst(resp, slot, payloadLength);
    } else {
      this.#push(resp, slot, payloadLength);
    }
    return null;
  }

  drain(reason: FlushReason): SocketChunk | null {
    if (this.#respCount === 0) return null;
    return this.#flush(reason);
  }

  reset(): void {
    for (let i = 0; i < this.#respCount; i++) {
      this.#resps[i] = undefined;
    }
    this.#respCount = 0;
    this.#resolvedSlot = NULL_SLOT;
    this.#totalPayloadLength = 0;
  }

  get bufferSize(): number {
    return this.#respCount;
  }

  #getFlushReason(count: number, slot: number, payloadLength: number): FlushReason | null {
    if (count >= this.#maxCommandCount) {
      return FlushReason.MAX_COMMANDS;
    }
    if (!areSlotsCompatible(this.#resolvedSlot, slot)) {
      return FlushReason.SLOT_MISMATCH;
    }
    if (this.#totalPayloadLength + payloadLength > this.#maxPayloadLength) {
      return FlushReason.MAX_PAYLOAD;
    }
    return null;
  }

  #pushFirst(resp: SocketChunk, slot: number, payloadLength: number): void {
    this.#resps[0] = resp;
    this.#respCount = 1;
    this.#totalPayloadLength = payloadLength;
    this.#resolvedSlot = slot !== NULL_SLOT ? slot : NULL_SLOT;
  }

  #push(resp: SocketChunk, slot: number, payloadLength: number): void {
    this.#resps[this.#respCount++] = resp;
    this.#totalPayloadLength += payloadLength;
    if (slot !== NULL_SLOT) {
      this.#resolvedSlot = slot;
    }
  }

  #flush(reason: FlushReason): SocketChunk {
    const count = this.#respCount;
    this.#statsCounter.recordFlush(reason);
    const clientIdx = this.#nextClientIdx;
    this.#nextClientIdx = (this.#nextClientIdx + 1) & RequestHeaderEncoder.clientIdxMaxValue();

    const header = RequestHeaderEncoder.allocateAndEncode(
      this.#totalPayloadLength,
      count,
      this.#resolvedSlot,
      clientIdx
    );

    // Calculate total parts needed
    let totalParts = 1;
    for (let i = 0; i < count; i++) {
      totalParts += this.#resps[i]!.length;
    }

    // Build result array
    const result = new Array<RedisArgument>(totalParts);
    result[0] = header;

    let idx = 1;
    for (let i = 0; i < count; i++) {
      const resp = this.#resps[i]!;
      const respLen = resp.length;
      for (let j = 0; j < respLen; j++) {
        result[idx++] = resp[j];
      }
      // Drop references to flushed payload chunks so GC can reclaim buffers promptly.
      this.#resps[i] = undefined;
    }

    // Reset state without reallocating array
    this.#respCount = 0;
    this.#resolvedSlot = NULL_SLOT;
    this.#totalPayloadLength = 0;

    return result;
  }
}
