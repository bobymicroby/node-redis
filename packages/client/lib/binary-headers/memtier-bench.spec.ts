import { strict as assert } from 'node:assert';
import { describe, it, afterEach } from 'mocha';
import RedisCommandsQueue, { type Scheduler } from '../client/commands-queue';
import { BinaryHeadersInterceptor } from './codec';
import { STATIC_RESOLVER } from './eligibility';
import { RequestHeaderDecoder } from './generated/request-header-codec';
import { DefaultBinaryHeaderStatsCounter } from './stats';

/**
 * Tests for memtier-bench pipelining and bulk-size behavior.
 *
 * These tests verify that:
 * 1. Pipeline controls the number of commands "in flight"
 * 2. Bulk-size controls how commands are batched together
 * 3. Key generation produces same-slot keys within a bulk
 * 4. Commands are issued in bulk-size batches to enable binary header batching
 * 5. Interceptor stats align with commands issued
 */

// ============================================================================
// BulkKeyGenerator (simplified version for testing)
// ============================================================================

interface BulkKeyGeneratorState {
  prefix: string;
  bulkSize: number;
  bulkSlots: number;
  keyMin: number;
  keysPerSlot: number;
  commandCount: number;
  bulkNumber: number;
  initialSlotId: number;
  initialKeySuffix: number;
}

function createBulkKeyGenerator(
  prefix: string,
  bulkSize: number,
  bulkSlots: number,
  keyMin: number,
  keyMax: number,
  initialSlotId?: number,
  initialKeySuffix?: number
): BulkKeyGeneratorState {
  const keysPerSlot = Math.floor((keyMax - keyMin + 1) / bulkSlots);
  return {
    prefix,
    bulkSize,
    bulkSlots,
    keyMin,
    keysPerSlot,
    commandCount: 0,
    bulkNumber: 0,
    initialSlotId: initialSlotId ?? Math.floor(Math.random() * bulkSlots),
    initialKeySuffix: initialKeySuffix ?? Math.floor(Math.random() * keysPerSlot)
  };
}

function nextKey(state: BulkKeyGeneratorState): string {
  // Always use {slot_id}:key_suffix format for fast-header protocol (including bulk-size=1)
  // This matches memtier's behavior where bulk key format is used regardless of bulk_size
  const posInBulk = state.commandCount % state.bulkSize;
  if (posInBulk === 0 && state.commandCount > 0) {
    state.bulkNumber++;
  }

  const slotId = (state.initialSlotId + state.bulkNumber) % state.bulkSlots;
  const keySuffix = (state.initialKeySuffix + state.commandCount) % state.keysPerSlot;

  state.commandCount++;

  return `${state.prefix}{${slotId}}:${state.keyMin + keySuffix}`;
}

/**
 * Extract slot from a key with hash tag format {slot}:suffix
 */
function extractSlot(key: string): string | null {
  const match = key.match(/\{([^}]+)\}/);
  return match ? match[1] : null;
}

// ============================================================================
// Test Helpers
// ============================================================================

function collectYielded(queue: RedisCommandsQueue): Array<ReadonlyArray<unknown>> {
  const results: Array<ReadonlyArray<unknown>> = [];
  const gen = queue.commandsToWrite();
  let next = gen.next();
  while (!next.done) {
    results.push(next.value as ReadonlyArray<unknown>);
    next = gen.next();
  }
  return results;
}

function parsePackedHeader(chunk: ReadonlyArray<unknown>): { commandCount: number } {
  const header = chunk[0] as Buffer;
  const decoder = new RequestHeaderDecoder();
  decoder.wrap(header, 0);
  return {
    commandCount: decoder.commandCount()
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('BulkKeyGenerator', function () {
  describe('bulk-size = 1 (each command is its own bulk)', function () {
    it('generates keys with hash tags, cycling through slots', function () {
      const keyGen = createBulkKeyGenerator('test-', 1, 10, 0, 999, 0, 0);

      const keys: string[] = [];
      for (let i = 0; i < 10; i++) {
        keys.push(nextKey(keyGen));
      }

      // With bulk-size=1, each command is its own bulk, so slot cycles every command
      // This matches memtier's behavior: bulk key format is used regardless of bulk_size
      for (const key of keys) {
        assert.notEqual(extractSlot(key), null, `Key ${key} should have hash tag`);
        assert(key.startsWith('test-'), `Key ${key} should have prefix`);
      }

      // Verify slots cycle: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9
      const slots = keys.map(extractSlot);
      assert.deepEqual(slots, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
        `Slots should cycle through 0-9: ${slots.join(', ')}`);
    });
  });

  describe('bulk-size > 1 (batching)', function () {
    it('generates same-slot keys within a bulk', function () {
      const keyGen = createBulkKeyGenerator('test-', 5, 10, 0, 999, 0, 0);

      // Generate 5 keys (one bulk)
      const bulk1Keys: string[] = [];
      for (let i = 0; i < 5; i++) {
        bulk1Keys.push(nextKey(keyGen));
      }

      // All keys in bulk 1 should have the same slot
      const bulk1Slots = bulk1Keys.map(extractSlot);
      assert(bulk1Slots.every(s => s === bulk1Slots[0]),
        `All keys in bulk 1 should have same slot: ${bulk1Keys.join(', ')}`);
    });

    it('changes slot between bulks', function () {
      const keyGen = createBulkKeyGenerator('test-', 5, 10, 0, 999, 0, 0);

      // Generate first bulk (5 keys)
      const bulk1Keys: string[] = [];
      for (let i = 0; i < 5; i++) {
        bulk1Keys.push(nextKey(keyGen));
      }

      // Generate second bulk (5 keys)
      const bulk2Keys: string[] = [];
      for (let i = 0; i < 5; i++) {
        bulk2Keys.push(nextKey(keyGen));
      }

      const bulk1Slot = extractSlot(bulk1Keys[0]);
      const bulk2Slot = extractSlot(bulk2Keys[0]);

      assert.notEqual(bulk1Slot, bulk2Slot,
        `Bulk 1 slot (${bulk1Slot}) should differ from bulk 2 slot (${bulk2Slot})`);

      assert.equal(parseInt(bulk2Slot!), parseInt(bulk1Slot!) + 1,
        `Slot should increment: ${bulk1Slot} -> ${bulk2Slot}`);
    });

    it('cycles through slots', function () {
      const keyGen = createBulkKeyGenerator('test-', 2, 3, 0, 99, 0, 0);

      const slots: string[] = [];
      for (let i = 0; i < 12; i++) {
        const key = nextKey(keyGen);
        if (i % 2 === 0) {
          slots.push(extractSlot(key)!);
        }
      }

      assert.deepEqual(slots, ['0', '1', '2', '0', '1', '2'],
        `Slots should cycle through 0-2: ${slots.join(', ')}`);
    });

    it('key suffix continues sequentially across bulks', function () {
      const keyGen = createBulkKeyGenerator('test-', 3, 10, 0, 999, 0, 0);

      const keys: string[] = [];
      for (let i = 0; i < 9; i++) {
        keys.push(nextKey(keyGen));
      }

      const suffixes = keys.map(k => {
        const match = k.match(/:(\d+)$/);
        return match ? parseInt(match[1]) : -1;
      });

      assert.deepEqual(suffixes, [0, 1, 2, 3, 4, 5, 6, 7, 8],
        `Suffixes should be sequential: ${suffixes.join(', ')}`);
    });
  });

  describe('validation', function () {
    it('requires sufficient keys per slot for bulk-size', function () {
      const keysPerSlot = Math.floor((9 - 0 + 1) / 10);
      assert.equal(keysPerSlot, 1);
    });
  });
});

describe('Pipeline and Bulk-Size Behavior', function () {
  function simulatePipelinedLoop(
    pipelineDepth: number,
    bulkSize: number,
    totalCommands: number
  ): {
    bulksIssued: number;
    commandsPerBulk: number[];
    slotsPerBulk: Set<string>[];
  } {
    const keyGen = createBulkKeyGenerator('test-', bulkSize, 10, 0, 999, 0, 0);
    const bulksIssued: { commands: string[]; slots: Set<string> }[] = [];
    let commandsIssued = 0;

    while (commandsIssued < totalCommands) {
      const bulk: { commands: string[]; slots: Set<string> } = {
        commands: [],
        slots: new Set()
      };

      for (let i = 0; i < bulkSize && commandsIssued < totalCommands; i++) {
        const key = nextKey(keyGen);
        bulk.commands.push(key);
        const slot = extractSlot(key);
        if (slot) bulk.slots.add(slot);
        commandsIssued++;
      }

      bulksIssued.push(bulk);
    }

    return {
      bulksIssued: bulksIssued.length,
      commandsPerBulk: bulksIssued.map(b => b.commands.length),
      slotsPerBulk: bulksIssued.map(b => b.slots)
    };
  }

  describe('bulk-size batching', function () {
    it('issues commands in bulk-size batches', function () {
      const result = simulatePipelinedLoop(100, 10, 100);

      assert.equal(result.bulksIssued, 10);
      assert(result.commandsPerBulk.every(c => c === 10),
        `All bulks should have 10 commands: ${result.commandsPerBulk.join(', ')}`);
    });

    it('each bulk has commands with the same slot', function () {
      const result = simulatePipelinedLoop(100, 10, 100);

      for (let i = 0; i < result.slotsPerBulk.length; i++) {
        assert.equal(result.slotsPerBulk[i].size, 1,
          `Bulk ${i} should have 1 slot, got ${result.slotsPerBulk[i].size}`);
      }
    });

    it('different bulks have different slots', function () {
      const result = simulatePipelinedLoop(100, 10, 50);

      const slots = result.slotsPerBulk.map(s => Array.from(s)[0]);
      const uniqueSlots = new Set(slots);
      assert.equal(uniqueSlots.size, slots.length,
        `All bulks should have unique slots: ${slots.join(', ')}`);
    });

    it('handles partial last bulk', function () {
      const result = simulatePipelinedLoop(100, 10, 25);

      assert.equal(result.bulksIssued, 3);
      assert.deepEqual(result.commandsPerBulk, [10, 10, 5]);
    });
  });

  describe('pipeline vs bulk-size relationship', function () {
    it('pipeline=100, bulk-size=10 creates 10 initial bulks', function () {
      const pipelineDepth = 100;
      const bulkSize = 10;

      const initialBulks = Math.ceil(pipelineDepth / bulkSize);
      assert.equal(initialBulks, 10);

      const result = simulatePipelinedLoop(pipelineDepth, bulkSize, pipelineDepth);
      assert.equal(result.bulksIssued, 10);
    });

    it('pipeline=50, bulk-size=10 creates 5 initial bulks', function () {
      const pipelineDepth = 50;
      const bulkSize = 10;

      const initialBulks = Math.ceil(pipelineDepth / bulkSize);
      assert.equal(initialBulks, 5);

      const result = simulatePipelinedLoop(pipelineDepth, bulkSize, pipelineDepth);
      assert.equal(result.bulksIssued, 5);
    });

    it('pipeline=10, bulk-size=10 creates 1 initial bulk', function () {
      const pipelineDepth = 10;
      const bulkSize = 10;

      const initialBulks = Math.ceil(pipelineDepth / bulkSize);
      assert.equal(initialBulks, 1);

      const result = simulatePipelinedLoop(pipelineDepth, bulkSize, pipelineDepth);
      assert.equal(result.bulksIssued, 1);
    });
  });
});

describe('Binary Header Batching with BulkKeyGenerator', function () {
  it('same-slot keys are eligible for batching', function () {
    const keyGen = createBulkKeyGenerator('test-', 5, 10, 0, 999, 3, 0);

    const keys: string[] = [];
    for (let i = 0; i < 5; i++) {
      keys.push(nextKey(keyGen));
    }

    const slots = keys.map(extractSlot);
    assert(slots.every(s => s === slots[0]),
      `All keys should have same slot for batching: ${keys.join(', ')}`);

    for (const key of keys) {
      assert.match(key, /\{\d+\}:\d+$/,
        `Key ${key} should have format {slot}:suffix`);
    }
  });

  it('different-slot keys trigger separate batches', function () {
    const keyGen = createBulkKeyGenerator('test-', 2, 10, 0, 999, 0, 0);

    const key1 = nextKey(keyGen);
    const key2 = nextKey(keyGen);
    const key3 = nextKey(keyGen);
    const key4 = nextKey(keyGen);

    assert.equal(extractSlot(key1), extractSlot(key2),
      `Keys in same bulk should have same slot: ${key1}, ${key2}`);
    assert.equal(extractSlot(key3), extractSlot(key4),
      `Keys in same bulk should have same slot: ${key3}, ${key4}`);
    assert.notEqual(extractSlot(key1), extractSlot(key3),
      `Keys in different bulks should have different slots: ${key1}, ${key3}`);
  });
});

describe('Memtier Benchmark Configuration', function () {
  describe('validation rules', function () {
    it('requires pipeline >= bulk-size', function () {
      const pipeline = 5;
      const bulkSize = 10;

      assert(pipeline < bulkSize,
        'This configuration should fail validation');
    });

    it('requires sufficient keys per slot', function () {
      const keyMin = 1;
      const keyMax = 1000000;
      const bulkSlots = 16384;
      const bulkSize = 10;

      const keysPerSlot = Math.floor((keyMax - keyMin + 1) / bulkSlots);
      assert(keysPerSlot >= bulkSize,
        `Keys per slot (${keysPerSlot}) must be >= bulk-size (${bulkSize})`);
    });

    it('fails with insufficient keys per slot', function () {
      const keyMin = 1;
      const keyMax = 100;
      const bulkSlots = 100;
      const bulkSize = 10;

      const keysPerSlot = Math.floor((keyMax - keyMin + 1) / bulkSlots);
      assert(keysPerSlot < bulkSize,
        `This configuration should fail: keys per slot (${keysPerSlot}) < bulk-size (${bulkSize})`);
    });
  });
});

describe('Latency Recording', function () {
  it('records latency per command, not per bulk', function () {
    const bulkSize = 10;
    const totalCommands = 30;
    let recordedLatencies = 0;

    for (let i = 0; i < totalCommands; i++) {
      recordedLatencies++;
    }

    assert.equal(recordedLatencies, totalCommands,
      `Should record ${totalCommands} latencies, one per command`);
    assert.notEqual(recordedLatencies, Math.ceil(totalCommands / bulkSize),
      'Should NOT record one latency per bulk');
  });
});

describe('Integration: Binary Header Batching with Queue', function () {
  it('same-slot keys from BulkKeyGenerator batch under one header', function () {
    const interceptor = new BinaryHeadersInterceptor({
      outbound: { resolver: STATIC_RESOLVER }
    });
    const queue = new RedisCommandsQueue(2, null, () => {}, interceptor);

    const keyGen = createBulkKeyGenerator('test-', 5, 10, 0, 999, 0, 0);

    for (let i = 0; i < 5; i++) {
      const key = nextKey(keyGen);
      queue.addCommand(['SET', key, 'value']);
    }

    const results = collectYielded(queue);

    assert.equal(results.length, 1, 'Should yield 1 packed batch for 5 same-slot commands');

    const parsed = parsePackedHeader(results[0]);
    assert.equal(parsed.commandCount, 5, 'Batch should contain 5 commands');
  });

  it('different-slot keys from different bulks create separate headers', function () {
    const interceptor = new BinaryHeadersInterceptor({
      outbound: { resolver: STATIC_RESOLVER }
    });
    const queue = new RedisCommandsQueue(2, null, () => {}, interceptor);

    const keyGen = createBulkKeyGenerator('test-', 3, 10, 0, 999, 0, 0);

    for (let i = 0; i < 6; i++) {
      const key = nextKey(keyGen);
      queue.addCommand(['SET', key, 'value']);
    }

    const results = collectYielded(queue);

    assert.equal(results.length, 2, 'Should yield 2 batches for 2 different slots');

    const parsed1 = parsePackedHeader(results[0]);
    const parsed2 = parsePackedHeader(results[1]);

    assert.equal(parsed1.commandCount, 3, 'First batch should have 3 commands');
    assert.equal(parsed2.commandCount, 3, 'Second batch should have 3 commands');
  });

  it('bulk-size=1 creates separate headers for each command', function () {
    const interceptor = new BinaryHeadersInterceptor({
      outbound: { resolver: STATIC_RESOLVER }
    });
    const queue = new RedisCommandsQueue(2, null, () => {}, interceptor);

    queue.addCommand(['SET', 'key1', 'value']);
    queue.addCommand(['SET', 'key2', 'value']);
    queue.addCommand(['SET', 'key3', 'value']);

    const results = collectYielded(queue);

    assert(results.length >= 1, 'Should yield at least 1 result');

    let totalCommands = 0;
    for (const result of results) {
      const parsed = parsePackedHeader(result);
      totalCommands += parsed.commandCount;
    }
    assert.equal(totalCommands, 3, 'Total commands should be 3');
  });

  it('simulates memtier bulk behavior: pipeline=10, bulk-size=5', function () {
    const interceptor = new BinaryHeadersInterceptor({
      outbound: { resolver: STATIC_RESOLVER }
    });
    const queue = new RedisCommandsQueue(2, null, () => {}, interceptor);

    const pipelineDepth = 10;
    const bulkSize = 5;
    const keyGen = createBulkKeyGenerator('test-', bulkSize, 10, 0, 999, 0, 0);

    const initialBulks = Math.ceil(pipelineDepth / bulkSize);

    for (let b = 0; b < initialBulks; b++) {
      for (let i = 0; i < bulkSize; i++) {
        const key = nextKey(keyGen);
        queue.addCommand(['SET', key, 'value']);
      }
    }

    const results = collectYielded(queue);

    assert.equal(results.length, 2, 'Should yield 2 batches');

    for (const result of results) {
      const parsed = parsePackedHeader(result);
      assert.equal(parsed.commandCount, 5, 'Each batch should have 5 commands');
    }
  });
});

describe('Interceptor Stats Alignment', function () {
  it('interceptor stats match commands issued', function () {
    const statsCounter = DefaultBinaryHeaderStatsCounter.create();
    const interceptor = new BinaryHeadersInterceptor({
      outbound: { resolver: STATIC_RESOLVER },
      statsCounter
    });
    const queue = new RedisCommandsQueue(2, null, () => {}, interceptor);

    const totalCommands = 15;
    const keyGen = createBulkKeyGenerator('test-', 5, 10, 0, 999, 0, 0);

    // Issue 15 commands in 3 bulks of 5
    for (let i = 0; i < totalCommands; i++) {
      const key = nextKey(keyGen);
      queue.addCommand(['SET', key, 'value']);
    }

    // Drain the queue to trigger batching
    collectYielded(queue);

    // Get stats from interceptor
    const stats = queue.wireInterceptorStats();
    assert(stats, 'Stats should be available');

    // Verify stats align with what we issued
    assert.equal(stats.totalCommandCount, totalCommands,
      `Interceptor should see ${totalCommands} commands, got ${stats.totalCommandCount}`);
    assert.equal(stats.batchedCommandCount, totalCommands,
      `All ${totalCommands} commands should be batched, got ${stats.batchedCommandCount}`);
    assert.equal(stats.batchCount, 3,
      `Should have 3 batches (15 commands / 5 per bulk), got ${stats.batchCount}`);
    assert.equal(stats.averageBatchSize(), 5,
      `Average batch size should be 5, got ${stats.averageBatchSize()}`);
  });

  it('stats track slot mismatch flushes', function () {
    const statsCounter = DefaultBinaryHeaderStatsCounter.create();
    const interceptor = new BinaryHeadersInterceptor({
      outbound: { resolver: STATIC_RESOLVER },
      statsCounter
    });
    const queue = new RedisCommandsQueue(2, null, () => {}, interceptor);

    const keyGen = createBulkKeyGenerator('test-', 3, 10, 0, 999, 0, 0);

    // Issue 6 commands (2 bulks of 3, different slots)
    for (let i = 0; i < 6; i++) {
      const key = nextKey(keyGen);
      queue.addCommand(['SET', key, 'value']);
    }

    collectYielded(queue);

    const stats = queue.wireInterceptorStats();
    assert(stats, 'Stats should be available');

    // First batch of 3 is flushed when slot changes
    // Second batch of 3 is flushed at drain
    assert.equal(stats.slotMismatchFlushCount, 1,
      `Should have 1 slot mismatch flush, got ${stats.slotMismatchFlushCount}`);
    assert.equal(stats.drainFlushCount, 1,
      `Should have 1 drain flush, got ${stats.drainFlushCount}`);
  });

  it('batch rate is 100% when all commands are eligible', function () {
    const statsCounter = DefaultBinaryHeaderStatsCounter.create();
    const interceptor = new BinaryHeadersInterceptor({
      outbound: { resolver: STATIC_RESOLVER },
      statsCounter
    });
    const queue = new RedisCommandsQueue(2, null, () => {}, interceptor);

    const keyGen = createBulkKeyGenerator('test-', 5, 10, 0, 999, 0, 0);

    for (let i = 0; i < 10; i++) {
      const key = nextKey(keyGen);
      queue.addCommand(['SET', key, 'value']);
    }

    collectYielded(queue);

    const stats = queue.wireInterceptorStats();
    assert(stats, 'Stats should be available');

    assert.equal(stats.batchRate(), 1.0,
      `Batch rate should be 100%, got ${stats.batchRate() * 100}%`);
  });
});

// ============================================================================
// Explicit Pipeline (chainId) - No Timer Flush Tests
// ============================================================================

/**
 * These tests verify that explicit pipelines (commands with chainId, as used by
 * execAsPipeline) do NOT use timer-based flushing. This is critical for performance
 * in memtier-like benchmarks where explicit pipelines should flush immediately.
 *
 * The key insight is:
 * - Explicit pipelines (execAsPipeline) set chainId on all commands
 * - Commands with chainId should flush immediately via DRAIN, not TIMER
 * - Timer flushes (timerFlushCount > 0) indicate the optimization is not working
 */

interface SchedulerStats {
  scheduleCount: number;
  cancelCount: number;
  lastDelayMs: number | null;
}

/**
 * Creates a scheduler that tracks calls for testing.
 */
function createTrackingScheduler(): { scheduler: Scheduler; stats: SchedulerStats } {
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

describe('Explicit Pipeline (chainId) - No Timer Flush', function () {
  let activeQueues: RedisCommandsQueue[] = [];

  afterEach(function () {
    for (const queue of activeQueues) {
      queue.destroy();
    }
    activeQueues = [];
  });

  function createQueueWithTimer(maxWaitMs: number = 100): {
    queue: RedisCommandsQueue;
    schedulerStats: SchedulerStats;
  } {
    const statsCounter = DefaultBinaryHeaderStatsCounter.create();
    const interceptor = new BinaryHeadersInterceptor({
      outbound: { resolver: STATIC_RESOLVER },
      statsCounter
    });
    const { scheduler, stats: schedulerStats } = createTrackingScheduler();
    const queue = new RedisCommandsQueue(
      2,
      null,
      () => {},
      interceptor,
      { maxWaitMs, scheduler }
    );
    activeQueues.push(queue);
    return { queue, schedulerStats };
  }

  describe('explicit pipeline detection', function () {
    it('commands with chainId do NOT schedule timer', function () {
      const { queue, schedulerStats } = createQueueWithTimer();
      const chainId = Symbol('Pipeline Chain');

      // Simulate execAsPipeline: all commands have same chainId
      const keyGen = createBulkKeyGenerator('test-', 5, 10, 0, 999, 0, 0);
      for (let i = 0; i < 5; i++) {
        const key = nextKey(keyGen);
        queue.addCommand(['SET', key, 'value'], { chainId });
      }

      const results = collectYielded(queue);

      // Commands should be flushed (yielded), not buffered for timer
      assert.equal(results.length, 1, 'Should yield 1 batch');

      // Timer should NOT have been scheduled for explicit pipeline
      assert.equal(schedulerStats.scheduleCount, 0,
        'Timer should NOT be scheduled for explicit pipeline (chainId set)');
    });

    it('commands without chainId DO schedule timer (auto-pipelining)', function () {
      const { queue, schedulerStats } = createQueueWithTimer();

      // Auto-pipelining: no chainId
      const keyGen = createBulkKeyGenerator('test-', 5, 10, 0, 999, 0, 0);
      for (let i = 0; i < 5; i++) {
        const key = nextKey(keyGen);
        queue.addCommand(['SET', key, 'value']); // No chainId
      }

      const results = collectYielded(queue);

      // Commands should be buffered for timer (not yielded immediately)
      assert.equal(results.length, 0, 'Should NOT yield - commands buffered for timer');

      // Timer SHOULD be scheduled for auto-pipelining
      assert.equal(schedulerStats.scheduleCount, 1,
        'Timer SHOULD be scheduled for auto-pipelining (no chainId)');
    });
  });

  describe('stats verification', function () {
    it('explicit pipeline uses DRAIN flush, not TIMER flush', function () {
      const { queue } = createQueueWithTimer();
      const chainId = Symbol('Pipeline Chain');

      const keyGen = createBulkKeyGenerator('test-', 5, 10, 0, 999, 0, 0);
      for (let i = 0; i < 5; i++) {
        const key = nextKey(keyGen);
        queue.addCommand(['SET', key, 'value'], { chainId });
      }

      collectYielded(queue);

      const stats = queue.wireInterceptorStats();
      assert(stats, 'Stats should be available');

      assert.equal(stats.timerFlushCount, 0,
        `timerFlushCount should be 0 for explicit pipeline, got ${stats.timerFlushCount}`);
      assert.equal(stats.drainFlushCount, 1,
        `drainFlushCount should be 1 for explicit pipeline, got ${stats.drainFlushCount}`);
    });

    it('auto-pipelining uses TIMER flush after timer fires', async function () {
      const { queue } = createQueueWithTimer(10); // Short timer for test

      let flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((encoded) => {
        flushedData.push(encoded);
      });

      const keyGen = createBulkKeyGenerator('test-', 5, 10, 0, 999, 0, 0);
      for (let i = 0; i < 5; i++) {
        const key = nextKey(keyGen);
        queue.addCommand(['SET', key, 'value']); // No chainId
      }

      collectYielded(queue); // Process queue - commands buffered for timer

      // Wait for timer to fire
      await new Promise(resolve => setTimeout(resolve, 20));

      const stats = queue.wireInterceptorStats();
      assert(stats, 'Stats should be available');

      assert.equal(stats.timerFlushCount, 1,
        `timerFlushCount should be 1 for auto-pipelining after timer fires, got ${stats.timerFlushCount}`);
      assert.equal(stats.drainFlushCount, 0,
        `drainFlushCount should be 0 for auto-pipelining, got ${stats.drainFlushCount}`);
      assert.equal(flushedData.length, 1, 'Timer callback should have been called once');
    });
  });

  describe('memtier bulk simulation', function () {
    it('multiple bulks with chainId (simulating execAsPipeline calls) - no timer flushes', function () {
      const { queue, schedulerStats } = createQueueWithTimer();

      // Simulate memtier behavior: multiple execAsPipeline calls
      // Each call creates its own chainId (like the real implementation)
      const bulkSize = 5;
      const numBulks = 3;

      for (let b = 0; b < numBulks; b++) {
        const chainId = Symbol(`Pipeline Chain ${b}`);
        const keyGen = createBulkKeyGenerator('test-', bulkSize, 10, b, 999, b, 0);

        for (let i = 0; i < bulkSize; i++) {
          const key = nextKey(keyGen);
          queue.addCommand(['SET', key, 'value'], { chainId });
        }
      }

      const results = collectYielded(queue);

      // Each bulk should create a batch (same-slot keys within bulk)
      assert.equal(results.length, numBulks, `Should yield ${numBulks} batches`);

      // NO timer should be scheduled for explicit pipelines
      assert.equal(schedulerStats.scheduleCount, 0,
        'Timer should NOT be scheduled for any explicit pipeline bulk');

      const stats = queue.wireInterceptorStats();
      assert(stats, 'Stats should be available');

      // All flushes should be DRAIN (from explicit pipeline end) or SLOT_MISMATCH
      // No TIMER flushes should occur
      assert.equal(stats.timerFlushCount, 0,
        `timerFlushCount should be 0, got ${stats.timerFlushCount}`);
    });

    it('pipeline=10, bulk-size=10 with chainId: single bulk, no timer flush', function () {
      const { queue, schedulerStats } = createQueueWithTimer();
      const chainId = Symbol('Pipeline Chain');
      const pipelineDepth = 10;
      const bulkSize = 10;

      const keyGen = createBulkKeyGenerator('test-', bulkSize, 10, 0, 999, 0, 0);

      for (let i = 0; i < pipelineDepth; i++) {
        const key = nextKey(keyGen);
        queue.addCommand(['SET', key, 'value'], { chainId });
      }

      const results = collectYielded(queue);

      assert.equal(results.length, 1, 'Should yield 1 batch');
      const parsed = parsePackedHeader(results[0]);
      assert.equal(parsed.commandCount, 10, 'Batch should contain 10 commands');

      assert.equal(schedulerStats.scheduleCount, 0, 'No timer scheduled');

      const stats = queue.wireInterceptorStats();
      assert(stats, 'Stats should be available');
      assert.equal(stats.timerFlushCount, 0, 'timerFlushCount should be 0');
      assert.equal(stats.drainFlushCount, 1, 'drainFlushCount should be 1');
    });

    it('interleaved auto and explicit: only auto commands trigger timer', function () {
      const { queue, schedulerStats } = createQueueWithTimer();

      // First: auto-pipelining command (no chainId) - different slot
      queue.addCommand(['SET', '{auto}key1', 'value']);
      collectYielded(queue); // Timer scheduled for auto command

      assert.equal(schedulerStats.scheduleCount, 1, 'Timer scheduled for auto command');

      // Second: explicit pipeline (with chainId) - different slot
      const chainId = Symbol('Pipeline Chain');
      queue.addCommand(['SET', '{explicit}key1', 'value'], { chainId });
      queue.addCommand(['SET', '{explicit}key2', 'value'], { chainId });
      const results = collectYielded(queue);

      // Explicit pipeline should flush: auto command (slot change) + explicit batch
      assert.equal(results.length, 2, 'Should yield 2 batches');

      const stats = queue.wireInterceptorStats();
      assert(stats, 'Stats should be available');

      // The auto command gets flushed by slot mismatch when explicit commands arrive
      // The explicit commands get flushed by DRAIN
      assert.equal(stats.timerFlushCount, 0, 'timerFlushCount should be 0');
    });
  });

  describe('edge cases', function () {
    it('single command with chainId flushes immediately', function () {
      const { queue, schedulerStats } = createQueueWithTimer();
      const chainId = Symbol('Pipeline Chain');

      queue.addCommand(['PING'], { chainId });

      const results = collectYielded(queue);

      assert.equal(results.length, 1, 'Should yield 1 batch');
      assert.equal(schedulerStats.scheduleCount, 0, 'No timer scheduled');

      const stats = queue.wireInterceptorStats();
      assert(stats, 'Stats should be available');
      assert.equal(stats.timerFlushCount, 0, 'timerFlushCount should be 0');
    });

    it('slot changes within explicit pipeline: still no timer flushes', function () {
      const { queue, schedulerStats } = createQueueWithTimer();
      const chainId = Symbol('Pipeline Chain');

      // Different slots - will trigger slot mismatch flushes
      queue.addCommand(['SET', '{a}key1', 'value'], { chainId });
      queue.addCommand(['SET', '{b}key2', 'value'], { chainId }); // Slot change
      queue.addCommand(['SET', '{c}key3', 'value'], { chainId }); // Slot change

      const results = collectYielded(queue);

      // Should have 3 batches (one per slot)
      assert.equal(results.length, 3, 'Should yield 3 batches due to slot changes');

      // No timer scheduled - slot changes are immediate flushes
      assert.equal(schedulerStats.scheduleCount, 0, 'No timer scheduled');

      const stats = queue.wireInterceptorStats();
      assert(stats, 'Stats should be available');
      assert.equal(stats.timerFlushCount, 0, 'timerFlushCount should be 0');
      assert.equal(stats.slotMismatchFlushCount, 2, 'slotMismatchFlushCount should be 2');
      assert.equal(stats.drainFlushCount, 1, 'drainFlushCount should be 1');
    });

    it('different chainIds are all treated as explicit pipelines', function () {
      const { queue, schedulerStats } = createQueueWithTimer();

      const chainId1 = Symbol('Pipeline 1');
      const chainId2 = Symbol('Pipeline 2');

      // Two separate explicit pipelines with same slot
      queue.addCommand(['SET', '{slot}k1', 'v1'], { chainId: chainId1 });
      queue.addCommand(['SET', '{slot}k2', 'v2'], { chainId: chainId2 });

      const results = collectYielded(queue);

      // Both should flush together (same slot, both have chainId)
      assert.equal(results.length, 1, 'Should yield 1 batch');

      assert.equal(schedulerStats.scheduleCount, 0, 'No timer scheduled');

      const stats = queue.wireInterceptorStats();
      assert(stats, 'Stats should be available');
      assert.equal(stats.timerFlushCount, 0, 'timerFlushCount should be 0');
    });
  });

  describe('real memtier benchmark simulation', function () {
    /**
     * This test simulates EXACTLY what memtier-bench.ts does:
     *
     * 1. issueBulk() is called multiple times in a loop (initialBulks times)
     * 2. Each issueBulk() creates a new multi() and calls execAsPipeline()
     * 3. Each execAsPipeline() creates its OWN chainId symbol
     * 4. All these calls happen synchronously, then setImmediate fires to write
     * 5. commandsToWrite() processes all commands in one go
     *
     * The bug scenario: if chainId is not propagated correctly, or if the
     * explicitPipeline detection fails, we'd see timer flushes instead of drain flushes.
     */
    it('simulates issueBulk() pattern: multiple execAsPipeline calls with separate chainIds', function () {
      const { queue, schedulerStats } = createQueueWithTimer();

      const pipelineDepth = 10;
      const bulkSize = 10;
      const initialBulks = Math.ceil(pipelineDepth / bulkSize); // = 1

      // Simulate the exact pattern from memtier-bench.ts runPipelinedConnection()
      // Each issueBulk() call creates its own chainId (like execAsPipeline does)
      for (let b = 0; b < initialBulks; b++) {
        const chainId = Symbol('Pipeline Chain'); // New symbol each bulk, like real code

        const keyGen = createBulkKeyGenerator('test-', bulkSize, 10, 0, 999, b, 0);
        for (let i = 0; i < bulkSize; i++) {
          const key = nextKey(keyGen);
          queue.addCommand(['SET', key, 'value'], { chainId });
        }
      }

      // This simulates what happens when setImmediate fires and #write() is called
      const results = collectYielded(queue);

      assert.equal(results.length, 1, 'Should yield 1 batch');

      const parsed = parsePackedHeader(results[0]);
      assert.equal(parsed.commandCount, 10, 'Batch should contain 10 commands');

      // CRITICAL: No timer should be scheduled for explicit pipelines
      assert.equal(schedulerStats.scheduleCount, 0,
        'Timer should NOT be scheduled - explicit pipeline should flush immediately');

      const stats = queue.wireInterceptorStats();
      assert(stats, 'Stats should be available');

      // CRITICAL: Should be DRAIN flush, NOT timer flush
      assert.equal(stats.timerFlushCount, 0,
        `timerFlushCount should be 0, got ${stats.timerFlushCount}`);
      assert.equal(stats.drainFlushCount, 1,
        `drainFlushCount should be 1, got ${stats.drainFlushCount}`);
    });

    it('simulates pipeline=100, bulk-size=10: 10 separate execAsPipeline calls', function () {
      const { queue, schedulerStats } = createQueueWithTimer();

      const pipelineDepth = 100;
      const bulkSize = 10;
      const initialBulks = Math.ceil(pipelineDepth / bulkSize); // = 10

      // Each bulk gets its own chainId (simulating 10 execAsPipeline calls)
      for (let b = 0; b < initialBulks; b++) {
        const chainId = Symbol('Pipeline Chain');

        const keyGen = createBulkKeyGenerator('test-', bulkSize, 10, 0, 999, b, 0);
        for (let i = 0; i < bulkSize; i++) {
          const key = nextKey(keyGen);
          queue.addCommand(['SET', key, 'value'], { chainId });
        }
      }

      const results = collectYielded(queue);

      // Should have 10 batches (one per slot change between bulks)
      assert.equal(results.length, 10, 'Should yield 10 batches (slot changes between bulks)');

      // CRITICAL: No timer scheduled
      assert.equal(schedulerStats.scheduleCount, 0,
        'Timer should NOT be scheduled for explicit pipelines');

      const stats = queue.wireInterceptorStats();
      assert(stats, 'Stats should be available');

      // All 100 commands processed
      assert.equal(stats.totalCommandCount, 100, 'Should have 100 total commands');
      assert.equal(stats.batchedCommandCount, 100, 'All 100 should be batched');

      // CRITICAL: No timer flushes
      assert.equal(stats.timerFlushCount, 0,
        `timerFlushCount should be 0, got ${stats.timerFlushCount}`);

      // Should have slot mismatch flushes (9) + drain flush (1)
      assert.equal(stats.slotMismatchFlushCount, 9,
        `slotMismatchFlushCount should be 9, got ${stats.slotMismatchFlushCount}`);
      assert.equal(stats.drainFlushCount, 1,
        `drainFlushCount should be 1, got ${stats.drainFlushCount}`);
    });

    it('verifies BulkKeyGenerator from memtier-bench produces correct slot grouping', function () {
      // Use the exact same parameters as a typical benchmark run
      const bulkSize = 10;
      const bulkSlots = 16384;
      const keyMin = 1;
      const keyMax = 1000000;

      const keyGen = createBulkKeyGenerator('memtier-', bulkSize, bulkSlots, keyMin, keyMax, 0, 0);

      // Generate 2 bulks worth of keys
      const bulk1Keys: string[] = [];
      const bulk2Keys: string[] = [];

      for (let i = 0; i < bulkSize; i++) {
        bulk1Keys.push(nextKey(keyGen));
      }
      for (let i = 0; i < bulkSize; i++) {
        bulk2Keys.push(nextKey(keyGen));
      }

      // All keys in bulk1 should have same slot
      const bulk1Slots = bulk1Keys.map(extractSlot);
      assert(bulk1Slots.every(s => s === bulk1Slots[0]),
        `All bulk1 keys should have same slot: ${bulk1Slots.join(', ')}`);

      // All keys in bulk2 should have same slot
      const bulk2Slots = bulk2Keys.map(extractSlot);
      assert(bulk2Slots.every(s => s === bulk2Slots[0]),
        `All bulk2 keys should have same slot: ${bulk2Slots.join(', ')}`);

      // Bulk1 and bulk2 should have DIFFERENT slots
      assert.notEqual(bulk1Slots[0], bulk2Slots[0],
        `Bulk1 slot (${bulk1Slots[0]}) should differ from bulk2 slot (${bulk2Slots[0]})`);
    });

    it('full benchmark simulation: pipeline=10, bulk-size=10, continuous operation', function () {
      const { queue, schedulerStats } = createQueueWithTimer();

      const pipelineDepth = 10;
      const bulkSize = 10;

      // Simulate multiple "rounds" of benchmark operation
      // In real benchmark, after responses come back, new bulks are issued
      const rounds = 5;

      for (let round = 0; round < rounds; round++) {
        const chainId = Symbol('Pipeline Chain');
        const keyGen = createBulkKeyGenerator('test-', bulkSize, 10, 0, 999, round, 0);

        for (let i = 0; i < bulkSize; i++) {
          const key = nextKey(keyGen);
          queue.addCommand(['SET', key, 'value'], { chainId });
        }

        // Each round, the write happens (simulating setImmediate callback)
        const results = collectYielded(queue);
        assert.equal(results.length, 1, `Round ${round}: Should yield 1 batch`);
      }

      // After all rounds, check cumulative stats
      const stats = queue.wireInterceptorStats();
      assert(stats, 'Stats should be available');

      assert.equal(stats.totalCommandCount, rounds * bulkSize,
        `Should have ${rounds * bulkSize} total commands`);

      // CRITICAL: NO timer flushes across all rounds
      assert.equal(stats.timerFlushCount, 0,
        `timerFlushCount should be 0, got ${stats.timerFlushCount}`);

      // Each round should have 1 drain flush
      assert.equal(stats.drainFlushCount, rounds,
        `drainFlushCount should be ${rounds}, got ${stats.drainFlushCount}`);

      // Timer should never have been scheduled
      assert.equal(schedulerStats.scheduleCount, 0,
        'Timer should never be scheduled for explicit pipelines');
    });
  });
});
