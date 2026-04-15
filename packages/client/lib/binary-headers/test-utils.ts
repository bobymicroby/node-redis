import { strict as assert } from 'node:assert';
import { ResponseHeaderEncoder } from './generated/response-header-codec';
import { RequestHeaderDecoder } from './generated/request-header-codec';
import { Decoder } from '../RESP/decoder';
import type { RespVersions } from '../RESP/types';
import RedisCommandsQueue, { type SocketChunk, type CommandArguments, type CommandOptions } from '../client/commands-queue';
import MasterQueue from './master-queue';
import { BinaryHeadersInterceptor } from './codec';
import { STATIC_RESOLVER, NOOP_RESOLVER } from './eligibility';

import type { BinaryHeaderStatsCounter, BinaryHeaderStats } from './stats';
import { DefaultBinaryHeaderStatsCounter } from './stats';
import type { EligibilityResolver } from './eligibility';
import type { Scheduler } from './packing';
import { createTimeoutScheduler } from './packing';

// ============================================================================
// Async Utilities
// ============================================================================

/**
 * Returns a promise that resolves after the specified delay.
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Binary Header Frame Utilities
// ============================================================================

/**
 * Creates a complete binary header response buffer with RESP payload.
 */
export function createBinhdrResponse(respPayload: string): Buffer {
  const payload = Buffer.from(respPayload);
  return Buffer.concat([
    ResponseHeaderEncoder.allocateAndEncode(payload.length, 1, false, 0),
    payload
  ]);
}

/**
 * Creates a complete binary header response frame with a Buffer payload.
 * More flexible than createBinhdrResponse for testing chunked data and multiple commands.
 */
export function createBinhdrFrame(
  payload: Buffer,
  commandCount: number = 1,
  clientIdx: number = 0,
  protocolError: boolean = false
): Buffer {
  return Buffer.concat([
    ResponseHeaderEncoder.allocateAndEncode(payload.length, commandCount, protocolError, clientIdx),
    payload
  ]);
}

/**
 * Creates N response frames concatenated together.
 */
export function createMultipleFrames(count: number, respPayload: Buffer): Buffer {
  const frames: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    frames.push(createBinhdrFrame(respPayload));
  }
  return Buffer.concat(frames);
}

// ============================================================================
// RESP Parsing Utilities
// ============================================================================

/**
 * Parses RESP-encoded data back into command arrays using the existing Decoder.
 * Useful for testing - converts '*3\r\n$3\r\nSET\r\n$1\r\na\r\n$1\r\n1\r\n' back to ['SET', 'a', '1']
 */
export function parseRespCommands(data: string | Buffer): unknown[] {
  const replies: unknown[] = [];
  const decoder = new Decoder({
    onReply: (reply: unknown) => replies.push(reply),
    onErrorReply: () => {},
    onPush: () => {},
    getTypeMapping: () => ({}),
  });
  decoder.write(typeof data === 'string' ? Buffer.from(data) : data);
  return replies;
}

// ============================================================================
// Collection Helpers
// ============================================================================

/**
 * Collects all yielded values from commandsToWrite() generator.
 */
export function collectYielded(queue: { commandsToWrite(): Generator<ReadonlyArray<unknown>> }): ReadonlyArray<unknown>[] {
  const results: ReadonlyArray<unknown>[] = [];
  for (const encoded of queue.commandsToWrite()) {
    results.push(encoded);
  }
  return results;
}

/**
 * Collects yielded commands and parses them back to arrays.
 * Useful for verifying unpacked RESP commands.
 */
export function collectYieldedParsed(queue: { commandsToWrite(): Generator<ReadonlyArray<unknown>> }): unknown[][] {
  const results: unknown[][] = [];
  for (const encoded of queue.commandsToWrite()) {
    results.push(parseRespCommands((encoded as string[]).join('')));
  }
  return results;
}

// ============================================================================
// Assertion Helpers
// ============================================================================

/**
 * Asserts packed data has correct header fields.
 */
export function assertPackedHeader(
  packed: ReadonlyArray<unknown> | null,
  expected: { commandCount?: number; slot?: number }
): void {
  assert.ok(packed !== null, 'Expected packed data to be non-null');
  assert.ok(packed[0] instanceof Buffer, 'Expected first element to be a Buffer');

  const decoder = new RequestHeaderDecoder().wrap(packed[0] as Buffer, 0);
  assert.ok(decoder.isValid(), 'Expected valid header');

  if (expected.commandCount !== undefined) {
    assert.equal(decoder.commandCount(), expected.commandCount);
  }
  if (expected.slot !== undefined) {
    assert.equal(decoder.slot(), expected.slot);
  }
}

/**
 * Asserts packed data has correct header AND payload.
 * Verifies header fields and parses RESP payload to check command contents.
 */
export function assertPackedData(
  packed: ReadonlyArray<unknown> | null,
  expected: {
    commandCount: number;
    slot?: number;
    commands?: string[][]; // Expected commands, e.g. [['SET', 'key', 'value'], ['GET', 'key']]
  }
): void {
  assert.ok(packed !== null, 'Expected packed data to be non-null');
  assert.ok(packed.length > 1, 'Expected header + payload parts');
  assert.ok(packed[0] instanceof Buffer, 'Expected first element to be header Buffer');

  // Verify header
  const decoder = new RequestHeaderDecoder().wrap(packed[0] as Buffer, 0);
  assert.ok(decoder.isValid(), 'Expected valid header');
  assert.equal(decoder.commandCount(), expected.commandCount, 'commandCount mismatch');

  if (expected.slot !== undefined) {
    assert.equal(decoder.slot(), expected.slot, 'slot mismatch');
  }

  // Verify payload if commands specified
  if (expected.commands !== undefined) {
    // Concatenate all payload parts
    const payloadParts = packed.slice(1);
    const payloadBuffer = Buffer.concat(
      payloadParts.map(p => typeof p === 'string' ? Buffer.from(p) : p as Buffer)
    );

    // Parse RESP commands from payload
    const parsedCommands = parseRespCommands(payloadBuffer);
    assert.equal(parsedCommands.length, expected.commands.length, 'Number of commands mismatch');

    for (let i = 0; i < expected.commands.length; i++) {
      const expectedCmd: string[] = expected.commands[i];
      const actualCmd = parsedCommands[i] as unknown[];
      assert.deepEqual(
        actualCmd.map(v => v instanceof Buffer ? v.toString() : v),
        expectedCmd,
        `Command ${i} mismatch`
      );
    }
  }
}

// ============================================================================
// Chunking Utilities
// ============================================================================

/**
 * Splits a buffer into chunks of specified sizes.
 * Last chunk gets remaining bytes.
 */
export function splitBuffer(buf: Buffer, chunkSizes: number[]): Buffer[] {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const size of chunkSizes) {
    if (offset >= buf.length) break;
    chunks.push(buf.subarray(offset, offset + size));
    offset += size;
  }
  if (offset < buf.length) {
    chunks.push(buf.subarray(offset));
  }
  return chunks;
}

/**
 * Splits buffer into single-byte chunks.
 */
export function splitIntoBytes(buf: Buffer): Buffer[] {
  return splitBuffer(buf, Array(buf.length).fill(1));
}

/**
 * Splits buffer at specific byte positions.
 */
export function splitAt(buf: Buffer, ...positions: number[]): Buffer[] {
  const sorted = [0, ...positions.sort((a, b) => a - b), buf.length];
  const chunks: Buffer[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i] < sorted[i + 1]) {
      chunks.push(buf.subarray(sorted[i], sorted[i + 1]));
    }
  }
  return chunks;
}

// ============================================================================
// RESP Encoding Utilities
// ============================================================================

/**
 * Encodes a value as RESP simple string: +value\r\n
 */
export function respSimpleString(value: string): Buffer {
  return Buffer.from(`+${value}\r\n`);
}

/**
 * Encodes a value as RESP integer: :value\r\n
 */
export function respInteger(value: number): Buffer {
  return Buffer.from(`:${value}\r\n`);
}

/**
 * Encodes a value as RESP bulk string: $len\r\nvalue\r\n
 */
export function respBulkString(value: string | Buffer): Buffer {
  const buf = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([
    Buffer.from(`$${buf.length}\r\n`),
    buf,
    Buffer.from('\r\n')
  ]);
}

/**
 * Encodes null as RESP null bulk string: $-1\r\n
 */
export function respNull(): Buffer {
  return Buffer.from('$-1\r\n');
}

/**
 * Encodes an error as RESP error: -ERR message\r\n
 */
export function respError(message: string): Buffer {
  return Buffer.from(`-ERR ${message}\r\n`);
}

/**
 * Encodes an array as RESP array: *len\r\n...elements
 */
export function respArray(elements: Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from(`*${elements.length}\r\n`),
    ...elements
  ]);
}

// ============================================================================
// Stats Assertion Helpers
// ============================================================================

/**
 * Expected values for BinaryHeaderStats assertion.
 * All fields are optional - only specified fields will be checked.
 */
export interface ExpectedStats {
  totalCommandCount?: number;
  batchedCommandCount?: number;
  batchCount?: number;
  ineligibleCount?: number;
  slotMismatchFlushCount?: number;
  maxCommandsFlushCount?: number;
  maxPayloadFlushCount?: number;
  timerFlushCount?: number;
  drainFlushCount?: number;
  // Derived metrics
  batchRate?: number;
  averageBatchSize?: number;
  passthroughCount?: number;
  ineligibleRate?: number;
  totalFlushCount?: number;
}

/**
 * Asserts that BinaryHeaderStats matches expected values.
 * Only checks fields that are specified in expected.
 */
export function assertStats(stats: BinaryHeaderStats, expected: ExpectedStats, prefix = ''): void {
  const p = prefix ? `${prefix}: ` : '';

  // Core counters
  if (expected.totalCommandCount !== undefined) {
    assert.equal(stats.totalCommandCount, expected.totalCommandCount, `${p}totalCommandCount`);
  }
  if (expected.batchedCommandCount !== undefined) {
    assert.equal(stats.batchedCommandCount, expected.batchedCommandCount, `${p}batchedCommandCount`);
  }
  if (expected.batchCount !== undefined) {
    assert.equal(stats.batchCount, expected.batchCount, `${p}batchCount`);
  }
  if (expected.ineligibleCount !== undefined) {
    assert.equal(stats.ineligibleCount, expected.ineligibleCount, `${p}ineligibleCount`);
  }

  // Flush reason counters
  if (expected.slotMismatchFlushCount !== undefined) {
    assert.equal(stats.slotMismatchFlushCount, expected.slotMismatchFlushCount, `${p}slotMismatchFlushCount`);
  }
  if (expected.maxCommandsFlushCount !== undefined) {
    assert.equal(stats.maxCommandsFlushCount, expected.maxCommandsFlushCount, `${p}maxCommandsFlushCount`);
  }
  if (expected.maxPayloadFlushCount !== undefined) {
    assert.equal(stats.maxPayloadFlushCount, expected.maxPayloadFlushCount, `${p}maxPayloadFlushCount`);
  }
  if (expected.timerFlushCount !== undefined) {
    assert.equal(stats.timerFlushCount, expected.timerFlushCount, `${p}timerFlushCount`);
  }
  if (expected.drainFlushCount !== undefined) {
    assert.equal(stats.drainFlushCount, expected.drainFlushCount, `${p}drainFlushCount`);
  }

  // Derived metrics
  if (expected.batchRate !== undefined) {
    assert.equal(stats.batchRate(), expected.batchRate, `${p}batchRate`);
  }
  if (expected.averageBatchSize !== undefined) {
    assert.equal(stats.averageBatchSize(), expected.averageBatchSize, `${p}averageBatchSize`);
  }
  if (expected.passthroughCount !== undefined) {
    assert.equal(stats.passthroughCount(), expected.passthroughCount, `${p}passthroughCount`);
  }
  if (expected.ineligibleRate !== undefined) {
    assert.equal(stats.ineligibleRate(), expected.ineligibleRate, `${p}ineligibleRate`);
  }
  if (expected.totalFlushCount !== undefined) {
    assert.equal(stats.totalFlushCount(), expected.totalFlushCount, `${p}totalFlushCount`);
  }
}

// ============================================================================
// Stress Test Utilities
// ============================================================================

/**
 * Generates a large string of specified size.
 */
export function largeString(size: number, char = 'x'): string {
  return char.repeat(size);
}

/**
 * Generates a large buffer of specified size.
 */
export function largeBuffer(size: number, fill = 0x78): Buffer {
  return Buffer.alloc(size, fill);
}

// ============================================================================
// Queue Test Factories
// ============================================================================

/**
 * Minimal interface that the queue satisfies.
 * This allows tests to work with the queue implementation.
 */
export interface TestableQueue {
  addCommand<T = unknown>(args: CommandArguments, options?: CommandOptions): Promise<T>;
  commandsToWrite(): Generator<SocketChunk>;
  processIncomingData(chunk: Buffer): void;
  readonly decoder: Decoder;
}

/**
 * Extended interface for queues with timer support.
 */
export interface TestableQueueWithTimer extends TestableQueue {
  setReadyToWriteCallback(callback: (writes: ReadonlyArray<SocketChunk>) => void): void;
  setTimerFlushCallback(callback: (encoded: SocketChunk) => void): void;
  destroy(): void;
  readonly maxWaitMs: number;
  hasPendingOutbound(): boolean;
  drainPendingOutbound(): SocketChunk | null;
}

/**
 * Adapter that wraps MasterQueue to implement TestableQueue interface.
 * MasterQueue doesn't have processIncomingData, so we add it by writing directly to decoder.
 */
class MasterQueueAdapter implements TestableQueue {
  readonly #queue: MasterQueue;

  constructor(queue: MasterQueue) {
    this.#queue = queue;
  }

  addCommand<T = unknown>(args: CommandArguments, _options?: CommandOptions): Promise<T> {
    return this.#queue.addCommand(args);
  }

  *commandsToWrite(): Generator<SocketChunk> {
    yield* this.#queue.commandsToWrite();
  }

  processIncomingData(chunk: Buffer): void {
    this.#queue.decoder.write(chunk);
  }

  get decoder(): Decoder {
    return this.#queue.decoder;
  }
}

// ============================================================================
// Factory Options
// ============================================================================

export interface QueueFactoryOptions {
  respVersion?: RespVersions;
  maxLength?: number | null;
  onShardedChannelMoved?: () => void;
  resolver?: EligibilityResolver;
  onProtocolError?: (requestId: number) => void;
  timer?: {
    maxWaitMs: number;
    scheduler?: Scheduler;
  };
  statsCounter?: BinaryHeaderStatsCounter;
}

// ============================================================================
// Internal Factory Functions
// ============================================================================

function createCodecQueue(options: QueueFactoryOptions = {}): TestableQueue {
  const {
    respVersion = 2,
    maxLength = null,
    onShardedChannelMoved = () => {},
    resolver,
    onProtocolError,
    timer,
    statsCounter,
  } = options;

  const interceptor = (resolver || onProtocolError || statsCounter || timer)
    ? new BinaryHeadersInterceptor({
        outbound: resolver || timer
          ? {
              resolver,
              timer: timer
                ? { maxWaitMs: timer.maxWaitMs, scheduler: timer.scheduler ?? createTimeoutScheduler() }
                : undefined
            }
          : undefined,
        inbound: onProtocolError ? { onProtocolError: (header) => onProtocolError(header.clientIdx) } : undefined,
        statsCounter,
      })
    : undefined;

  return new RedisCommandsQueue(respVersion, maxLength, onShardedChannelMoved, interceptor);
}

function createCodecQueueWithTimer(options: QueueFactoryOptions = {}): TestableQueueWithTimer {
  return createCodecQueue(options) as RedisCommandsQueue as TestableQueueWithTimer;
}

// ============================================================================
// Exported Factory Functions
// ============================================================================

/**
 * Creates the original master queue (true baseline).
 * This wraps MasterQueue with an adapter to implement TestableQueue.
 */
export function createMasterQueue(options: Omit<QueueFactoryOptions, 'resolver' | 'onProtocolError' | 'timer'> = {}): TestableQueue {
  const queue = new MasterQueue(
    options.respVersion ?? 2,
    options.maxLength ?? null,
    options.onShardedChannelMoved ?? (() => {})
  );
  return new MasterQueueAdapter(queue);
}

/**
 * Creates a queue without codec (new implementation).
 * Should behave identically to createMasterQueue().
 */
export function createNoCodecQueue(options: Omit<QueueFactoryOptions, 'resolver' | 'onProtocolError' | 'timer'> = {}): TestableQueue {
  return new RedisCommandsQueue(
    options.respVersion ?? 2,
    options.maxLength ?? null,
    options.onShardedChannelMoved ?? (() => {})
  );
}

/**
 * Creates a queue with binary headers support.
 */
export function createBinhdrQueue(options: QueueFactoryOptions = {}): TestableQueue {
  return createCodecQueue({ ...options, resolver: options.resolver ?? STATIC_RESOLVER });
}

/**
 * Creates a queue with binary headers and timer support.
 */
export function createBinhdrQueueWithTimer(options: QueueFactoryOptions = {}): TestableQueueWithTimer {
  return createCodecQueueWithTimer({ ...options, resolver: options.resolver ?? STATIC_RESOLVER });
}

/**
 * Creates a queue with passthrough resolver (commands not batched).
 */
export function createPassthroughQueue(options: QueueFactoryOptions = {}): TestableQueue {
  return createCodecQueue({ ...options, resolver: NOOP_RESOLVER });
}

// ============================================================================
// Test Matrix Helpers
// ============================================================================

export type QueueName = 'master' | 'no-codec';

const QUEUE_FACTORIES: Record<QueueName, () => TestableQueue> = {
  'master': createMasterQueue,
  'no-codec': createNoCodecQueue,
};

/**
 * Registers a test for each specified queue implementation.
 * Queue is created automatically and passed to the test function.
 *
 * @example
 * forQueues(['master', 'no-codec'], 'yields commands', (queue) => {
 *   queue.addCommand(['PING']);
 *   assert.equal(collectYielded(queue).length, 1);
 * });
 */
export function forQueues(
  queues: QueueName[],
  name: string,
  fn: (queue: TestableQueue) => void | Promise<void>
): void {
  for (const q of queues) {
    it(`[${q}] ${name}`, function () {
      return fn(QUEUE_FACTORIES[q]());
    });
  }
}

// ============================================================================
// Re-exports
// ============================================================================

export { createTimeoutScheduler, createImmediateScheduler } from './packing';
export { ResponseHeaderEncoder } from './generated/response-header-codec';
export { STATIC_RESOLVER, NOOP_RESOLVER } from './eligibility';
export type { EligibilityResolver } from './eligibility';
export type { Scheduler } from './packing';
export { DefaultBinaryHeaderStatsCounter, disabledBinaryHeaderStatsCounter, FlushReason } from './stats';
export type { BinaryHeaderStatsCounter, BinaryHeaderStats } from './stats';

// ============================================================================
// Stats + Timer Integration Helpers
// ============================================================================

/**
 * Queue with stats tracking enabled.
 */
export interface TestableQueueWithStats extends TestableQueue {
  getStats(): BinaryHeaderStats;
}

/**
 * Queue with both stats and timer support.
 */
export interface TestableQueueWithTimerAndStats extends TestableQueueWithTimer {
  getStats(): BinaryHeaderStats;
}

/**
 * Creates a queue with binary headers and stats tracking.
 */
export function createBinhdrQueueWithStats(options: Omit<QueueFactoryOptions, 'statsCounter'> = {}): TestableQueueWithStats {
  const statsCounter = DefaultBinaryHeaderStatsCounter.create();
  const queue = createCodecQueue({
    ...options,
    resolver: options.resolver ?? STATIC_RESOLVER,
    statsCounter,
  });
  return Object.assign(queue, {
    getStats: () => statsCounter.snapshot(),
  });
}

/**
 * Creates a queue with binary headers, timer, and stats tracking.
 */
export function createBinhdrQueueWithTimerAndStats(options: Omit<QueueFactoryOptions, 'statsCounter'> = {}): TestableQueueWithTimerAndStats {
  const statsCounter = DefaultBinaryHeaderStatsCounter.create();
  const queue = createCodecQueueWithTimer({
    ...options,
    resolver: options.resolver ?? STATIC_RESOLVER,
    statsCounter,
  });
  return Object.assign(queue, {
    getStats: () => statsCounter.snapshot(),
  });
}

/**
 * Scheduler stats for tracking schedule/cancel calls.
 */
export interface SchedulerStats {
  scheduleCount: number;
  cancelCount: number;
  lastDelayMs: number | null;
}

/**
 * Creates a scheduler that tracks calls for testing.
 */
export function createTrackingScheduler(): { scheduler: Scheduler; stats: SchedulerStats } {
  const stats: SchedulerStats = {
    scheduleCount: 0,
    cancelCount: 0,
    lastDelayMs: null,
  };

  const scheduler: Scheduler = {
    schedule(delayMs: number, task: () => void) {
      stats.scheduleCount++;
      stats.lastDelayMs = delayMs;
      const id = setTimeout(task, delayMs);
      return {
        cancel: () => {
          stats.cancelCount++;
          clearTimeout(id);
        },
      };
    },
  };

  return { scheduler, stats };
}

/**
 * Creates a scheduler that throws on schedule (for error handling tests).
 */
export function createThrowingScheduler(errorMessage: string = 'Scheduler error'): Scheduler {
  return {
    schedule(_delayMs: number, _task: () => void) {
      throw new Error(errorMessage);
    },
  };
}

/**
 * Creates a scheduler that throws on cancel (for error handling tests).
 */
export function createThrowingCancelScheduler(errorMessage: string = 'Cancel error'): Scheduler {
  return {
    schedule(delayMs: number, task: () => void) {
      const id = setTimeout(task, delayMs);
      return {
        cancel: () => {
          clearTimeout(id);
          throw new Error(errorMessage);
        },
      };
    },
  };
}
