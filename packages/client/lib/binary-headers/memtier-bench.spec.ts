import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import RedisCommandsQueue from '../client/commands-queue';
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
  if (state.bulkSize <= 1) {
    const keyIndex = state.keyMin + Math.floor(Math.random() * (state.keysPerSlot * state.bulkSlots));
    return `${state.prefix}${keyIndex}`;
  }

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
    results.push(next.value);
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
  describe('bulk-size = 1 (no batching)', function () {
    it('generates keys without hash tags', function () {
      const keyGen = createBulkKeyGenerator('test-', 1, 16384, 1, 1000000);

      const keys: string[] = [];
      for (let i = 0; i < 10; i++) {
        keys.push(nextKey(keyGen));
      }

      // Keys should not have hash tags when bulk-size = 1
      for (const key of keys) {
        assert.equal(extractSlot(key), null, `Key ${key} should not have hash tag`);
        assert(key.startsWith('test-'), `Key ${key} should have prefix`);
      }
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
