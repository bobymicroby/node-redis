/**
 * Queue Test Factories
 *
 * Provides factory functions for creating RedisCommandsQueue instances for testing.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { createBaseQueue, createBinhdrQueue } from './queue-test-factories';
 *
 * // Queue without codec (baseline behavior)
 * const baseQueue = createBaseQueue();
 *
 * // Queue with binary headers codec
 * const binhdrQueue = createBinhdrQueue();
 * ```
 *
 * ## Factory Functions
 *
 * - `createBaseQueue()` - Queue without codec (baseline)
 * - `createBinhdrQueue()` - Queue with binary headers codec
 * - `createBinhdrQueueWithTimer()` - Queue with binary headers + timer support
 * - `createPassthroughQueue()` - Queue with codec but no batching (NOOP_RESOLVER)
 */

import type { RedisArgument, RespVersions } from '../RESP/types';
import type { Decoder } from '../RESP/decoder';

import RedisCommandsQueue from '../client/commands-queue';
import { BinaryHeadersCodec } from './codec';
import { STATIC_RESOLVER } from './eligibility-static-data';
import { NOOP_RESOLVER } from './eligibility-resolver';
import type { EligibilityResolver } from './eligibility-resolver';
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
 * Creates a queue without binary headers support.
 * This is equivalent to the base queue behavior.
 */
export function createBaseQueue(options: Omit<QueueFactoryOptions, 'resolver' | 'onProtocolError' | 'timer'> = {}): TestableQueue {
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
export type { EligibilityResolver } from './eligibility-resolver';
export type { Scheduler } from './packing';
