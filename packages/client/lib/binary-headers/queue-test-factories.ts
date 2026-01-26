/**
 * Queue Test Factories
 *
 * Provides factory functions for creating RedisCommandsQueue instances for testing.
 *
 * ## Terminology
 *
 * - **Master queue** (`master-queue.ts`) - The original, untouched implementation (true baseline)
 * - **No-codec queue** (`commands-queue.ts` without codec) - New implementation, should behave identically to master
 * - **With-codec queue** (`commands-queue.ts` with codec) - New implementation with binary headers support
 *
 * ## Quick Start
 *
 * ```typescript
 * import { createMasterQueue, createNoCodecQueue, createBinhdrQueue, noCodecFactories } from './queue-test-factories';
 *
 * // Original master queue (true baseline)
 * const masterQueue = createMasterQueue();
 *
 * // New implementation without codec (should match master behavior)
 * const noCodecQueue = createNoCodecQueue();
 *
 * // Queue with binary headers codec
 * const binhdrQueue = createBinhdrQueue();
 *
 * // Run tests against both master and no-codec to verify identical behavior
 * for (const { name, factory } of noCodecFactories) {
 *   describe(`[${name}]`, () => { ... });
 * }
 * ```
 *
 * ## Factory Functions
 *
 * - `createMasterQueue()` - Original master queue (true baseline)
 * - `createNoCodecQueue()` - New implementation without codec (should match master)
 * - `createBinhdrQueue()` - Queue with binary headers codec
 * - `createBinhdrQueueWithTimer()` - Queue with binary headers + timer support
 * - `createPassthroughQueue()` - Queue with codec but no batching (NOOP_RESOLVER)
 *
 * ## Testing Helpers
 *
 * - `noCodecFactories` - Array of { name, factory } for running tests against both master and no-codec
 */

import type { RedisArgument, RespVersions } from '../RESP/types';
import type { Decoder } from '../RESP/decoder';

import RedisCommandsQueue from '../client/commands-queue';
import MasterQueue from './master-queue';
import { BinaryHeadersCodec } from './codec';
import { STATIC_RESOLVER, NOOP_RESOLVER } from './eligibility';
import type { EligibilityResolver } from './eligibility';
import type { Scheduler } from './packing';
import { createTimeoutScheduler, createImmediateScheduler } from './packing';

// ============================================================================
// Common Interface
// ============================================================================

/**
 * Minimal interface that the queue satisfies.
 * This allows tests to work with the queue implementation.
 */
export interface TestableQueue {
  addCommand<T = unknown>(args: ReadonlyArray<RedisArgument>): Promise<T>;
  commandsToWrite(): Generator<ReadonlyArray<RedisArgument>>;
  processIncomingData(chunk: Buffer): void;
  readonly decoder: Decoder;
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

  addCommand<T = unknown>(args: ReadonlyArray<RedisArgument>): Promise<T> {
    return this.#queue.addCommand(args);
  }

  *commandsToWrite(): Generator<ReadonlyArray<RedisArgument>> {
    yield* this.#queue.commandsToWrite();
  }

  processIncomingData(chunk: Buffer): void {
    // MasterQueue expects caller to write directly to decoder
    this.#queue.decoder.write(chunk);
  }

  get decoder(): Decoder {
    return this.#queue.decoder;
  }
}

/**
 * Extended interface for queues with timer support.
 */
export interface TestableQueueWithTimer extends TestableQueue {
  setTimerFlushCallback(callback: (encoded: ReadonlyArray<RedisArgument>) => void): void;
  destroy(): void;
  readonly maxWaitMs: number;
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
  } = options;

  // Create codec only if we have resolver or protocol error handler
  const codec = (resolver || onProtocolError)
    ? new BinaryHeadersCodec({
        outbound: resolver ? { resolver } : undefined,
        inbound: onProtocolError ? { onProtocolError } : undefined,
      })
    : undefined;

  const timerOptions = timer
    ? { maxWaitMs: timer.maxWaitMs, scheduler: timer.scheduler ?? createTimeoutScheduler() }
    : undefined;

  return new RedisCommandsQueue(respVersion, maxLength, onShardedChannelMoved, codec, timerOptions);
}

function createCodecQueueWithTimer(options: QueueFactoryOptions = {}): TestableQueueWithTimer {
  const queue = createCodecQueue(options) as RedisCommandsQueue;
  return queue;
}

// ============================================================================
// Exported Factory Functions
// ============================================================================

/**
 * Creates the original master queue (true baseline).
 * This wraps MasterQueue with an adapter to implement TestableQueue.
 * Used to verify that createNoCodecQueue() behaves identically.
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
 * @deprecated Use createNoCodecQueue instead. Kept for backwards compatibility.
 */
export const createBaseQueue = createNoCodecQueue;

/**
 * Factory definitions for running tests against both master and no-codec queues.
 * Use this to verify the new implementation matches the original behavior.
 *
 * @example
 * for (const { name, factory } of noCodecFactories) {
 *   describe(`[${name}]`, () => {
 *     it('some test', () => {
 *       const queue = factory();
 *       // test...
 *     });
 *   });
 * }
 */
export const noCodecFactories: ReadonlyArray<{ name: string; factory: typeof createNoCodecQueue }> = [
  { name: 'master', factory: createMasterQueue },
  { name: 'no-codec', factory: createNoCodecQueue },
];

/**
 * Creates a queue with binary headers support.
 */
export function createBinhdrQueue(options: QueueFactoryOptions = {}): TestableQueue {
  const opts = { ...options, resolver: options.resolver ?? STATIC_RESOLVER };
  return createCodecQueue(opts);
}

/**
 * Creates a queue with binary headers and timer support.
 */
export function createBinhdrQueueWithTimer(options: QueueFactoryOptions = {}): TestableQueueWithTimer {
  const opts = { ...options, resolver: options.resolver ?? STATIC_RESOLVER };
  return createCodecQueueWithTimer(opts);
}

/**
 * Creates a queue with passthrough resolver (commands not batched).
 */
export function createPassthroughQueue(options: QueueFactoryOptions = {}): TestableQueue {
  const opts = { ...options, resolver: NOOP_RESOLVER };
  return createCodecQueue(opts);
}

// ============================================================================
// Test Case Helpers
// ============================================================================

/**
 * Helper to collect all yielded values from commandsToWrite()
 */
export function collectYielded(queue: TestableQueue): ReadonlyArray<RedisArgument>[] {
  const results: ReadonlyArray<RedisArgument>[] = [];
  for (const encoded of queue.commandsToWrite()) {
    results.push(encoded);
  }
  return results;
}

// Re-export commonly used utilities
export { createTimeoutScheduler, createImmediateScheduler };
export { STATIC_RESOLVER, NOOP_RESOLVER };

// Re-export types for convenience
export type { EligibilityResolver } from './eligibility';
export type { Scheduler } from './packing';
