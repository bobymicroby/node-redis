/**
 * Queue Test Factories
 *
 * Provides swappable constructor functions for testing both queue implementations:
 * - BinhdrCommandsQueue (subclass approach)
 * - CodecQueue with BinaryHeadersCodec (composition approach)
 *
 * ## Quick Start
 *
 * To switch which implementation your tests run against, change ACTIVE_IMPLEMENTATION:
 *
 * ```typescript
 * // In this file, toggle the active line:
 * export const ACTIVE_IMPLEMENTATION: QueueImplementation = 'codec-queue';
 * // export const ACTIVE_IMPLEMENTATION: QueueImplementation = 'binhdr-subclass';
 * ```
 *
 * ## Factory Functions
 *
 * - `createBaseQueue()` - Queue without codec (baseline, always uses CodecQueue)
 * - `createBinhdrQueue()` - Queue with binary headers (uses ACTIVE_IMPLEMENTATION)
 * - `createBinhdrQueueWithTimer()` - Queue with binary headers + timer support
 * - `createPassthroughQueue()` - Queue with codec but no batching (NOOP_RESOLVER)
 *
 * ## Running Tests Against Both Implementations
 *
 * Use `getBothImplementations()` to run the same test against both:
 *
 * ```typescript
 * const implementations = getBothImplementations();
 * for (const impl of implementations) {
 *   describe(`${impl.name}`, function () {
 *     it('my test', function () {
 *       const queue = impl.createQueue();
 *       // test code...
 *     });
 *   });
 * }
 * ```
 *
 * ## Explicit Factory Functions
 *
 * When you need a specific implementation regardless of ACTIVE_IMPLEMENTATION:
 * - `createExplicitCodecQueue()` - Always creates CodecQueue
 * - `createExplicitBinhdrSubclassQueue()` - Always creates BinhdrCommandsQueue
 */

import type { RedisArgument, RespVersions } from '../RESP/types';
import type { Decoder } from '../RESP/decoder';

// Import both queue implementations
import CodecQueue from './codec-queue';
import BinhdrCommandsQueue from './binhdr-commands-queue';
import { BinaryHeadersCodec } from './codec';
import { STATIC_RESOLVER } from './eligibility-static-data';
import { NOOP_RESOLVER } from './eligibility-resolver';
import type { EligibilityResolver } from './eligibility-resolver';
import type { Scheduler, Cancellable } from './packing';
import { createTimeoutScheduler, createImmediateScheduler } from './packing';

// ============================================================================
// Common Interface
// ============================================================================

/**
 * Minimal interface that both queue implementations satisfy.
 * This allows tests to work with either implementation.
 */
export interface TestableQueue {
  addCommand<T = unknown>(args: ReadonlyArray<RedisArgument>): Promise<T>;
  commandsToWrite(): Generator<ReadonlyArray<RedisArgument>>;
  processIncomingData(chunk: Buffer): void;
  readonly decoder: Decoder;
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
// Implementation Toggle
// ============================================================================

/**
 * Which implementation to use for tests.
 * Change this value or comment/uncomment to switch implementations.
 */
export type QueueImplementation = 'codec-queue' | 'binhdr-subclass';

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  TOGGLE: Change this to switch which implementation tests run against     ║
// ║                                                                           ║
// ║  To test with the subclass approach, comment the first line and           ║
// ║  uncomment the second line below:                                         ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
export const ACTIVE_IMPLEMENTATION: QueueImplementation = 'codec-queue';
// export const ACTIVE_IMPLEMENTATION: QueueImplementation = 'binhdr-subclass';

// ============================================================================
// Factory Functions - CodecQueue (Composition)
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

  return new CodecQueue(respVersion, maxLength, onShardedChannelMoved, codec, timerOptions);
}

function createCodecQueueWithTimer(options: QueueFactoryOptions = {}): TestableQueueWithTimer {
  const queue = createCodecQueue(options) as CodecQueue;
  return queue;
}

// ============================================================================
// Factory Functions - BinhdrCommandsQueue (Subclass)
// ============================================================================

function createBinhdrSubclassQueue(options: QueueFactoryOptions = {}): TestableQueue {
  const {
    respVersion = 2,
    maxLength = null,
    onShardedChannelMoved = () => {},
    resolver,
    onProtocolError,
    timer,
  } = options;

  return new BinhdrCommandsQueue(respVersion, maxLength, onShardedChannelMoved, {
    resolver,
    onProtocolError,
    timeBounded: timer
      ? { maxWaitMs: timer.maxWaitMs, scheduler: timer.scheduler ?? createTimeoutScheduler() }
      : undefined,
  });
}

function createBinhdrSubclassQueueWithTimer(options: QueueFactoryOptions = {}): TestableQueueWithTimer {
  const queue = createBinhdrSubclassQueue(options) as BinhdrCommandsQueue;
  return queue;
}

// ============================================================================
// Unified Factory Functions (Use ACTIVE_IMPLEMENTATION)
// ============================================================================

/**
 * Creates a queue without binary headers support.
 * Both implementations should behave identically to the base queue.
 */
export function createBaseQueue(options: Omit<QueueFactoryOptions, 'resolver' | 'onProtocolError' | 'timer'> = {}): TestableQueue {
  // For base queue (no codec), always use CodecQueue without codec
  // This is equivalent to the master queue behavior
  return new CodecQueue(
    options.respVersion ?? 2,
    options.maxLength ?? null,
    options.onShardedChannelMoved ?? (() => {})
  );
}

/**
 * Creates a queue with binary headers support using the active implementation.
 */
export function createBinhdrQueue(options: QueueFactoryOptions = {}): TestableQueue {
  const opts = { ...options, resolver: options.resolver ?? STATIC_RESOLVER };

  if (ACTIVE_IMPLEMENTATION === 'codec-queue') {
    return createCodecQueue(opts);
  }
  return createBinhdrSubclassQueue(opts);
}

/**
 * Creates a queue with binary headers and timer support using the active implementation.
 */
export function createBinhdrQueueWithTimer(options: QueueFactoryOptions = {}): TestableQueueWithTimer {
  const opts = { ...options, resolver: options.resolver ?? STATIC_RESOLVER };

  if (ACTIVE_IMPLEMENTATION === 'codec-queue') {
    return createCodecQueueWithTimer(opts);
  }
  return createBinhdrSubclassQueueWithTimer(opts);
}

/**
 * Creates a queue with passthrough resolver (commands not batched).
 */
export function createPassthroughQueue(options: QueueFactoryOptions = {}): TestableQueue {
  const opts = { ...options, resolver: NOOP_RESOLVER };

  if (ACTIVE_IMPLEMENTATION === 'codec-queue') {
    return createCodecQueue(opts);
  }
  return createBinhdrSubclassQueue(opts);
}

// ============================================================================
// Explicit Factory Functions (Specify Implementation Directly)
// ============================================================================

/**
 * Explicitly create a CodecQueue (composition approach).
 */
export function createExplicitCodecQueue(options: QueueFactoryOptions = {}): TestableQueue {
  return createCodecQueue({ ...options, resolver: options.resolver ?? STATIC_RESOLVER });
}

/**
 * Explicitly create a BinhdrCommandsQueue (subclass approach).
 */
export function createExplicitBinhdrSubclassQueue(options: QueueFactoryOptions = {}): TestableQueue {
  return createBinhdrSubclassQueue({ ...options, resolver: options.resolver ?? STATIC_RESOLVER });
}

// ============================================================================
// Test Case Helpers
// ============================================================================

/**
 * Returns both implementations for parameterized testing.
 * Use this when you want to run the same test against both implementations.
 */
export function getBothImplementations(): Array<{
  name: string;
  createQueue: (options?: QueueFactoryOptions) => TestableQueue;
  createQueueWithTimer: (options?: QueueFactoryOptions) => TestableQueueWithTimer;
}> {
  return [
    {
      name: 'CodecQueue (composition)',
      createQueue: (opts = {}) => createCodecQueue({ ...opts, resolver: opts.resolver ?? STATIC_RESOLVER }),
      createQueueWithTimer: (opts = {}) => createCodecQueueWithTimer({ ...opts, resolver: opts.resolver ?? STATIC_RESOLVER }),
    },
    {
      name: 'BinhdrCommandsQueue (subclass)',
      createQueue: (opts = {}) => createBinhdrSubclassQueue({ ...opts, resolver: opts.resolver ?? STATIC_RESOLVER }),
      createQueueWithTimer: (opts = {}) => createBinhdrSubclassQueueWithTimer({ ...opts, resolver: opts.resolver ?? STATIC_RESOLVER }),
    },
  ];
}

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
export type { EligibilityResolver } from './eligibility-resolver';
export type { Scheduler, Cancellable } from './packing';
