/**
 * Binary Headers Statistics
 *
 * Provides statistics collection for binary headers batching,
 * following the same patterns as Caffeine cache.
 *
 * Key metrics:
 * - batchRate(): What percentage of commands are being batched?
 * - averageBatchSize(): How many commands per batch on average?
 * - Flush reason breakdown: Why are batches being flushed?
 */

export const FlushReason = {
  SLOT_MISMATCH: 0,
  MAX_COMMANDS: 1,
  MAX_PAYLOAD: 2,
  TIMER_EXPIRED: 3,
  DRAIN: 4,
} as const;

export type FlushReason = typeof FlushReason[keyof typeof FlushReason];

/**
 * Immutable snapshot of binary headers statistics.
 * Holds point-in-time statistics and provides derived metrics for analyzing batching efficiency.
 */
export class BinaryHeaderStats {
  private constructor(
    public readonly totalCommandCount: number,
    public readonly batchedCommandCount: number,
    public readonly batchCount: number,
    public readonly ineligibleCount: number,
    public readonly slotMismatchFlushCount: number,
    public readonly maxCommandsFlushCount: number,
    public readonly maxPayloadFlushCount: number,
    public readonly timerFlushCount: number,
    public readonly drainFlushCount: number
  ) {
    if (
      totalCommandCount < 0 ||
      batchedCommandCount < 0 ||
      batchCount < 0 ||
      ineligibleCount < 0 ||
      slotMismatchFlushCount < 0 ||
      maxCommandsFlushCount < 0 ||
      maxPayloadFlushCount < 0 ||
      timerFlushCount < 0 ||
      drainFlushCount < 0
    ) {
      throw new Error('All statistics values must be non-negative');
    }
  }

  static of(
    totalCommandCount = 0,
    batchedCommandCount = 0,
    batchCount = 0,
    ineligibleCount = 0,
    slotMismatchFlushCount = 0,
    maxCommandsFlushCount = 0,
    maxPayloadFlushCount = 0,
    timerFlushCount = 0,
    drainFlushCount = 0
  ): BinaryHeaderStats {
    return new BinaryHeaderStats(
      totalCommandCount,
      batchedCommandCount,
      batchCount,
      ineligibleCount,
      slotMismatchFlushCount,
      maxCommandsFlushCount,
      maxPayloadFlushCount,
      timerFlushCount,
      drainFlushCount
    );
  }

  static empty(): BinaryHeaderStats {
    return BinaryHeaderStats.EMPTY_STATS;
  }

  private static readonly EMPTY_STATS = new BinaryHeaderStats(0, 0, 0, 0, 0, 0, 0, 0, 0);

  /**
   * Ratio of commands that were batched (0.0-1.0). Primary efficiency metric.
   */
  batchRate(): number {
    return this.totalCommandCount === 0
      ? 1.0
      : this.batchedCommandCount / this.totalCommandCount;
  }

  /**
   * Average commands per batch. Higher values indicate better batching efficiency.
   */
  averageBatchSize(): number {
    return this.batchCount === 0
      ? 0.0
      : this.batchedCommandCount / this.batchCount;
  }

  passthroughCount(): number {
    return this.totalCommandCount - this.batchedCommandCount;
  }

  ineligibleRate(): number {
    return this.totalCommandCount === 0
      ? 0.0
      : this.ineligibleCount / this.totalCommandCount;
  }

  totalFlushCount(): number {
    return (
      this.slotMismatchFlushCount +
      this.maxCommandsFlushCount +
      this.maxPayloadFlushCount +
      this.timerFlushCount +
      this.drainFlushCount
    );
  }

  /**
   * Difference between this and other. Negative values clamped to zero.
   */
  minus(other: BinaryHeaderStats): BinaryHeaderStats {
    return BinaryHeaderStats.of(
      Math.max(0, this.totalCommandCount - other.totalCommandCount),
      Math.max(0, this.batchedCommandCount - other.batchedCommandCount),
      Math.max(0, this.batchCount - other.batchCount),
      Math.max(0, this.ineligibleCount - other.ineligibleCount),
      Math.max(0, this.slotMismatchFlushCount - other.slotMismatchFlushCount),
      Math.max(0, this.maxCommandsFlushCount - other.maxCommandsFlushCount),
      Math.max(0, this.maxPayloadFlushCount - other.maxPayloadFlushCount),
      Math.max(0, this.timerFlushCount - other.timerFlushCount),
      Math.max(0, this.drainFlushCount - other.drainFlushCount)
    );
  }

  plus(other: BinaryHeaderStats): BinaryHeaderStats {
    return BinaryHeaderStats.of(
      this.totalCommandCount + other.totalCommandCount,
      this.batchedCommandCount + other.batchedCommandCount,
      this.batchCount + other.batchCount,
      this.ineligibleCount + other.ineligibleCount,
      this.slotMismatchFlushCount + other.slotMismatchFlushCount,
      this.maxCommandsFlushCount + other.maxCommandsFlushCount,
      this.maxPayloadFlushCount + other.maxPayloadFlushCount,
      this.timerFlushCount + other.timerFlushCount,
      this.drainFlushCount + other.drainFlushCount
    );
  }
}

/**
 * Accumulator for binary headers statistics.
 * Call snapshot() to get an immutable point-in-time view.
 */
export interface BinaryHeaderStatsCounter {
  recordCommand(): void;
  recordBatchedCommand(): void;
  recordIneligible(): void;
  recordFlush(reason: FlushReason): void;
  snapshot(): BinaryHeaderStats;
}

/**
 * No-op stats counter. Used when statistics collection is disabled.
 */
class DisabledBinaryHeaderStatsCounter implements BinaryHeaderStatsCounter {
  static readonly INSTANCE = new DisabledBinaryHeaderStatsCounter();

  private constructor() {}

  recordCommand(): void {}
  recordBatchedCommand(): void {}
  recordIneligible(): void {}
  recordFlush(_reason: FlushReason): void {}
  snapshot(): BinaryHeaderStats {
    return BinaryHeaderStats.empty();
  }
}

export function disabledBinaryHeaderStatsCounter(): BinaryHeaderStatsCounter {
  return DisabledBinaryHeaderStatsCounter.INSTANCE;
}

/**
 * Active stats counter that records all batching events.
 */
export class DefaultBinaryHeaderStatsCounter implements BinaryHeaderStatsCounter {
  #totalCommandCount = 0;
  #batchedCommandCount = 0;
  #batchCount = 0;
  #ineligibleCount = 0;
  #slotMismatchFlushCount = 0;
  #maxCommandsFlushCount = 0;
  #maxPayloadFlushCount = 0;
  #timerFlushCount = 0;
  #drainFlushCount = 0;

  recordCommand(): void {
    this.#totalCommandCount++;
  }

  recordBatchedCommand(): void {
    this.#batchedCommandCount++;
  }

  recordIneligible(): void {
    this.#ineligibleCount++;
  }

  recordFlush(reason: FlushReason): void {
    this.#batchCount++;
    switch (reason) {
      case FlushReason.SLOT_MISMATCH:
        this.#slotMismatchFlushCount++;
        break;
      case FlushReason.MAX_COMMANDS:
        this.#maxCommandsFlushCount++;
        break;
      case FlushReason.MAX_PAYLOAD:
        this.#maxPayloadFlushCount++;
        break;
      case FlushReason.TIMER_EXPIRED:
        this.#timerFlushCount++;
        break;
      case FlushReason.DRAIN:
        this.#drainFlushCount++;
        break;
    }
  }

  snapshot(): BinaryHeaderStats {
    return BinaryHeaderStats.of(
      this.#totalCommandCount,
      this.#batchedCommandCount,
      this.#batchCount,
      this.#ineligibleCount,
      this.#slotMismatchFlushCount,
      this.#maxCommandsFlushCount,
      this.#maxPayloadFlushCount,
      this.#timerFlushCount,
      this.#drainFlushCount
    );
  }

  static create(): DefaultBinaryHeaderStatsCounter {
    return new DefaultBinaryHeaderStatsCounter();
  }
}
