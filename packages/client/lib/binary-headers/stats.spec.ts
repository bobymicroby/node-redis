import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  BinaryHeaderStats,
  FlushReason,
  DefaultBinaryHeaderStatsCounter,
  disabledBinaryHeaderStatsCounter,
} from './stats';
import { BinaryHeadersCodec } from './codec';
import { STATIC_RESOLVER, NOOP_RESOLVER } from './eligibility';
import { assertStats, type ExpectedStats } from './test-utils';
import type { CommandToWrite } from '../client/commands-queue';

function fakeCommand(args: string[]): CommandToWrite {
  return {
    args,
    chainId: undefined,
    abort: undefined,
    timeout: undefined,
    resolve() {},
    reject() {},
    channelsCounter: undefined,
    typeMapping: undefined
  };
}

describe('Binary Headers Stats', function () {
  // ==========================================================================
  // BinaryHeaderStats (immutable snapshot)
  // ==========================================================================
  describe('BinaryHeaderStats', function () {
    describe('factory methods', function () {
      it('of() creates instance with specified values', function () {
        const stats = BinaryHeaderStats.of(100, 80, 10, 20, 3, 2, 1, 4, 5);

        assert.equal(stats.totalCommandCount, 100);
        assert.equal(stats.batchedCommandCount, 80);
        assert.equal(stats.batchCount, 10);
        assert.equal(stats.ineligibleCount, 20);
        assert.equal(stats.slotMismatchFlushCount, 3);
        assert.equal(stats.maxCommandsFlushCount, 2);
        assert.equal(stats.maxPayloadFlushCount, 1);
        assert.equal(stats.timerFlushCount, 4);
        assert.equal(stats.drainFlushCount, 5);
      });

      it('of() uses default values when not specified', function () {
        const stats = BinaryHeaderStats.of();

        assert.equal(stats.totalCommandCount, 0);
        assert.equal(stats.batchedCommandCount, 0);
        assert.equal(stats.batchCount, 0);
        assert.equal(stats.ineligibleCount, 0);
        assert.equal(stats.slotMismatchFlushCount, 0);
        assert.equal(stats.maxCommandsFlushCount, 0);
        assert.equal(stats.maxPayloadFlushCount, 0);
        assert.equal(stats.timerFlushCount, 0);
        assert.equal(stats.drainFlushCount, 0);
      });

      it('empty() returns all zeros', function () {
        const stats = BinaryHeaderStats.empty();

        assert.equal(stats.totalCommandCount, 0);
        assert.equal(stats.batchedCommandCount, 0);
        assert.equal(stats.batchCount, 0);
        assert.equal(stats.ineligibleCount, 0);
      });

      it('empty() returns same instance (singleton)', function () {
        assert.strictEqual(BinaryHeaderStats.empty(), BinaryHeaderStats.empty());
      });
    });

    describe('derived metrics (table-driven)', function () {
      const metricCases = [
        {
          name: 'batchRate: 100% when all batched',
          stats: BinaryHeaderStats.of(100, 100, 10),
          metric: 'batchRate' as const,
          expected: 1.0,
        },
        {
          name: 'batchRate: 50% when half batched',
          stats: BinaryHeaderStats.of(100, 50, 5),
          metric: 'batchRate' as const,
          expected: 0.5,
        },
        {
          name: 'batchRate: 0% when none batched',
          stats: BinaryHeaderStats.of(100, 0, 0),
          metric: 'batchRate' as const,
          expected: 0.0,
        },
        {
          name: 'batchRate: 1.0 when no commands (avoid division by zero)',
          stats: BinaryHeaderStats.of(0, 0, 0),
          metric: 'batchRate' as const,
          expected: 1.0,
        },
        {
          name: 'averageBatchSize: 10 commands per batch',
          stats: BinaryHeaderStats.of(100, 100, 10),
          metric: 'averageBatchSize' as const,
          expected: 10.0,
        },
        {
          name: 'averageBatchSize: 1 command per batch',
          stats: BinaryHeaderStats.of(100, 100, 100),
          metric: 'averageBatchSize' as const,
          expected: 1.0,
        },
        {
          name: 'averageBatchSize: 0 when no batches (avoid division by zero)',
          stats: BinaryHeaderStats.of(100, 0, 0),
          metric: 'averageBatchSize' as const,
          expected: 0.0,
        },
        {
          name: 'passthroughCount: 20 when 80 of 100 batched',
          stats: BinaryHeaderStats.of(100, 80, 8),
          metric: 'passthroughCount' as const,
          expected: 20,
        },
        {
          name: 'passthroughCount: 0 when all batched',
          stats: BinaryHeaderStats.of(100, 100, 10),
          metric: 'passthroughCount' as const,
          expected: 0,
        },
        {
          name: 'ineligibleRate: 20% ineligible',
          stats: BinaryHeaderStats.of(100, 80, 8, 20),
          metric: 'ineligibleRate' as const,
          expected: 0.2,
        },
        {
          name: 'ineligibleRate: 0 when no commands',
          stats: BinaryHeaderStats.of(0, 0, 0, 0),
          metric: 'ineligibleRate' as const,
          expected: 0.0,
        },
        {
          name: 'totalFlushCount: sum of all flush reasons',
          stats: BinaryHeaderStats.of(100, 80, 15, 20, 3, 2, 1, 4, 5),
          metric: 'totalFlushCount' as const,
          expected: 15, // 3 + 2 + 1 + 4 + 5 = 15
        },
      ];

      for (const { name, stats, metric, expected } of metricCases) {
        it(name, function () {
          const actual = stats[metric]();
          assert.equal(actual, expected);
        });
      }
    });

    describe('arithmetic operations', function () {
      it('plus() adds all counters', function () {
        const a = BinaryHeaderStats.of(100, 80, 10, 20, 3, 2, 1, 4, 5);
        const b = BinaryHeaderStats.of(50, 40, 5, 10, 1, 1, 1, 1, 1);
        const result = a.plus(b);

        assert.equal(result.totalCommandCount, 150);
        assert.equal(result.batchedCommandCount, 120);
        assert.equal(result.batchCount, 15);
        assert.equal(result.ineligibleCount, 30);
        assert.equal(result.slotMismatchFlushCount, 4);
        assert.equal(result.maxCommandsFlushCount, 3);
        assert.equal(result.maxPayloadFlushCount, 2);
        assert.equal(result.timerFlushCount, 5);
        assert.equal(result.drainFlushCount, 6);
      });

      it('minus() subtracts all counters', function () {
        const a = BinaryHeaderStats.of(100, 80, 10, 20, 3, 2, 1, 4, 5);
        const b = BinaryHeaderStats.of(50, 40, 5, 10, 1, 1, 1, 1, 1);
        const result = a.minus(b);

        assert.equal(result.totalCommandCount, 50);
        assert.equal(result.batchedCommandCount, 40);
        assert.equal(result.batchCount, 5);
        assert.equal(result.ineligibleCount, 10);
        assert.equal(result.slotMismatchFlushCount, 2);
        assert.equal(result.maxCommandsFlushCount, 1);
        assert.equal(result.maxPayloadFlushCount, 0);
        assert.equal(result.timerFlushCount, 3);
        assert.equal(result.drainFlushCount, 4);
      });

      it('minus() clamps negative values to zero', function () {
        const a = BinaryHeaderStats.of(10, 8, 1, 2, 0, 0, 0, 0, 1);
        const b = BinaryHeaderStats.of(100, 80, 10, 20, 3, 2, 1, 4, 5);
        const result = a.minus(b);

        assert.equal(result.totalCommandCount, 0);
        assert.equal(result.batchedCommandCount, 0);
        assert.equal(result.batchCount, 0);
        assert.equal(result.ineligibleCount, 0);
        assert.equal(result.slotMismatchFlushCount, 0);
        assert.equal(result.maxCommandsFlushCount, 0);
        assert.equal(result.maxPayloadFlushCount, 0);
        assert.equal(result.timerFlushCount, 0);
        assert.equal(result.drainFlushCount, 0);
      });

      it('plus() with empty() returns same values', function () {
        const stats = BinaryHeaderStats.of(100, 80, 10, 20, 3, 2, 1, 4, 5);
        const result = stats.plus(BinaryHeaderStats.empty());

        assert.equal(result.totalCommandCount, stats.totalCommandCount);
        assert.equal(result.batchedCommandCount, stats.batchedCommandCount);
        assert.equal(result.batchCount, stats.batchCount);
      });
    });
  });

  // ==========================================================================
  // DefaultBinaryHeaderStatsCounter
  // ==========================================================================
  describe('DefaultBinaryHeaderStatsCounter', function () {
    describe('recording methods', function () {
      it('recordCommand() increments totalCommandCount', function () {
        const counter = DefaultBinaryHeaderStatsCounter.create();

        counter.recordCommand();
        counter.recordCommand();
        counter.recordCommand();

        const stats = counter.snapshot();
        assert.equal(stats.totalCommandCount, 3);
      });

      it('recordBatchedCommand() increments batchedCommandCount', function () {
        const counter = DefaultBinaryHeaderStatsCounter.create();

        counter.recordBatchedCommand();
        counter.recordBatchedCommand();

        const stats = counter.snapshot();
        assert.equal(stats.batchedCommandCount, 2);
      });

      it('recordIneligible() increments ineligibleCount', function () {
        const counter = DefaultBinaryHeaderStatsCounter.create();

        counter.recordIneligible();

        const stats = counter.snapshot();
        assert.equal(stats.ineligibleCount, 1);
      });
    });

    describe('recordFlush() with different reasons (table-driven)', function () {
      const flushCases = [
        {
          name: 'SLOT_MISMATCH',
          reason: FlushReason.SLOT_MISMATCH,
          field: 'slotMismatchFlushCount' as const,
        },
        {
          name: 'MAX_COMMANDS',
          reason: FlushReason.MAX_COMMANDS,
          field: 'maxCommandsFlushCount' as const,
        },
        {
          name: 'MAX_PAYLOAD',
          reason: FlushReason.MAX_PAYLOAD,
          field: 'maxPayloadFlushCount' as const,
        },
        {
          name: 'TIMER_EXPIRED',
          reason: FlushReason.TIMER_EXPIRED,
          field: 'timerFlushCount' as const,
        },
        {
          name: 'DRAIN',
          reason: FlushReason.DRAIN,
          field: 'drainFlushCount' as const,
        },
      ];

      for (const { name, reason, field } of flushCases) {
        it(`FlushReason.${name} increments ${field} and batchCount`, function () {
          const counter = DefaultBinaryHeaderStatsCounter.create();

          counter.recordFlush(reason);
          counter.recordFlush(reason);

          const stats = counter.snapshot();
          assert.equal(stats.batchCount, 2);
          assert.equal(stats[field], 2);
        });
      }
    });

    describe('snapshot isolation', function () {
      it('snapshot returns current values without affecting counter', function () {
        const counter = DefaultBinaryHeaderStatsCounter.create();

        counter.recordCommand();
        counter.recordBatchedCommand();
        const snapshot1 = counter.snapshot();

        counter.recordCommand();
        counter.recordBatchedCommand();
        const snapshot2 = counter.snapshot();

        // First snapshot unchanged
        assert.equal(snapshot1.totalCommandCount, 1);
        assert.equal(snapshot1.batchedCommandCount, 1);

        // Second snapshot has accumulated values
        assert.equal(snapshot2.totalCommandCount, 2);
        assert.equal(snapshot2.batchedCommandCount, 2);
      });
    });

    describe('realistic usage scenario', function () {
      it('tracks mixed eligible and ineligible commands', function () {
        const counter = DefaultBinaryHeaderStatsCounter.create();

        // Simulate: 10 eligible commands batched into 2 batches, 5 ineligible
        for (let i = 0; i < 10; i++) {
          counter.recordCommand();
          counter.recordBatchedCommand();
        }
        for (let i = 0; i < 5; i++) {
          counter.recordCommand();
          counter.recordIneligible();
        }
        counter.recordFlush(FlushReason.SLOT_MISMATCH);
        counter.recordFlush(FlushReason.DRAIN);

        const stats = counter.snapshot();
        assert.equal(stats.totalCommandCount, 15);
        assert.equal(stats.batchedCommandCount, 10);
        assert.equal(stats.ineligibleCount, 5);
        assert.equal(stats.batchCount, 2);
        assert.equal(stats.slotMismatchFlushCount, 1);
        assert.equal(stats.drainFlushCount, 1);

        // Verify derived metrics
        assert.equal(stats.batchRate(), 10 / 15);
        assert.equal(stats.averageBatchSize(), 10 / 2);
        assert.equal(stats.passthroughCount(), 5);
        assert.equal(stats.ineligibleRate(), 5 / 15);
      });
    });
  });

  // ==========================================================================
  // DisabledBinaryHeaderStatsCounter
  // ==========================================================================
  describe('disabledBinaryHeaderStatsCounter', function () {
    it('returns singleton instance', function () {
      const a = disabledBinaryHeaderStatsCounter();
      const b = disabledBinaryHeaderStatsCounter();
      assert.strictEqual(a, b);
    });

    it('recording methods are no-ops', function () {
      const counter = disabledBinaryHeaderStatsCounter();

      // These should not throw
      counter.recordCommand();
      counter.recordBatchedCommand();
      counter.recordIneligible();
      counter.recordFlush(FlushReason.DRAIN);
    });

    it('snapshot() always returns empty stats', function () {
      const counter = disabledBinaryHeaderStatsCounter();

      counter.recordCommand();
      counter.recordBatchedCommand();
      counter.recordFlush(FlushReason.DRAIN);

      const stats = counter.snapshot();
      assert.equal(stats.totalCommandCount, 0);
      assert.equal(stats.batchedCommandCount, 0);
      assert.equal(stats.batchCount, 0);
    });
  });

  // ==========================================================================
  // Integration with BinaryHeadersCodec
  // ==========================================================================
  describe('BinaryHeadersCodec integration', function () {
    it('stats() returns empty when no statsCounter provided', function () {
      const interceptor = new BinaryHeadersCodec({
        outbound: { resolver: STATIC_RESOLVER },
      });

      const stats = interceptor.stats();
      assert.equal(stats.totalCommandCount, 0);
      assert.equal(stats.batchedCommandCount, 0);
    });

    it('stats() tracks commands through codec', function () {
      const statsCounter = DefaultBinaryHeaderStatsCounter.create();
      const interceptor = new BinaryHeadersCodec({
        outbound: { resolver: STATIC_RESOLVER },
        statsCounter,
      });

      // Simulate encoding eligible commands
      const encoded1 = ['*3\r\n$3\r\nSET\r\n$4\r\nkey1\r\n$5\r\nvalue\r\n'];
      const encoded2 = ['*2\r\n$3\r\nGET\r\n$4\r\nkey1\r\n'];

      interceptor.outbound.push(fakeCommand(['SET', 'key1', 'value']), encoded1, ['SET', 'key1', 'value']);
      interceptor.outbound.push(fakeCommand(['GET', 'key1']), encoded2, ['GET', 'key1']);

      const stats = interceptor.stats();
      assert.equal(stats.totalCommandCount, 2);
      assert.equal(stats.batchedCommandCount, 2);
      assert.equal(stats.ineligibleCount, 0);
    });

    it('stats() tracks ineligible commands', function () {
      const statsCounter = DefaultBinaryHeaderStatsCounter.create();
      const interceptor = new BinaryHeadersCodec({
        outbound: { resolver: NOOP_RESOLVER }, // All commands ineligible
        statsCounter,
      });

      const encoded = ['*1\r\n$4\r\nPING\r\n'];
      interceptor.outbound.push(fakeCommand(['PING']), encoded, ['PING']);

      const stats = interceptor.stats();
      assert.equal(stats.totalCommandCount, 1);
      assert.equal(stats.batchedCommandCount, 0);
      assert.equal(stats.ineligibleCount, 1);
      assert.equal(stats.ineligibleRate(), 1.0);
    });

    it('stats() tracks flush on drain', function () {
      const statsCounter = DefaultBinaryHeaderStatsCounter.create();
      const interceptor = new BinaryHeadersCodec({
        outbound: { resolver: STATIC_RESOLVER },
        statsCounter,
      });

      // Add a command (gets buffered)
      const encoded = ['*3\r\n$3\r\nSET\r\n$4\r\nkey1\r\n$5\r\nvalue\r\n'];
      interceptor.outbound.push(fakeCommand(['SET', 'key1', 'value']), encoded, ['SET', 'key1', 'value']);

      // Before drain
      let stats = interceptor.stats();
      assert.equal(stats.batchCount, 0);

      // Drain the buffer
      interceptor.outbound.drain(FlushReason.DRAIN);

      // After drain
      stats = interceptor.stats();
      assert.equal(stats.batchCount, 1);
      assert.equal(stats.drainFlushCount, 1);
    });

    it('stats() tracks slot mismatch flush', function () {
      const statsCounter = DefaultBinaryHeaderStatsCounter.create();
      const interceptor = new BinaryHeadersCodec({
        outbound: { resolver: STATIC_RESOLVER },
        statsCounter,
      });

      // Two commands with different slots (using hash tags)
      const encoded1 = ['*3\r\n$3\r\nSET\r\n$9\r\n{slot1}k1\r\n$1\r\nv\r\n'];
      const encoded2 = ['*3\r\n$3\r\nSET\r\n$9\r\n{slot2}k2\r\n$1\r\nv\r\n'];

      interceptor.outbound.push(fakeCommand(['SET', '{slot1}k1', 'v']), encoded1, ['SET', '{slot1}k1', 'v']);
      interceptor.outbound.push(fakeCommand(['SET', '{slot2}k2', 'v']), encoded2, ['SET', '{slot2}k2', 'v']); // Different slot triggers flush

      const stats = interceptor.stats();
      assert.equal(stats.totalCommandCount, 2);
      assert.equal(stats.batchedCommandCount, 2);
      assert.equal(stats.batchCount, 1); // First batch flushed due to slot mismatch
      assert.equal(stats.slotMismatchFlushCount, 1);
    });

    it('outbound.stats() and codec.stats() return same values', function () {
      const statsCounter = DefaultBinaryHeaderStatsCounter.create();
      const interceptor = new BinaryHeadersCodec({
        outbound: { resolver: STATIC_RESOLVER },
        statsCounter,
      });

      const encoded = ['*3\r\n$3\r\nSET\r\n$4\r\nkey1\r\n$5\r\nvalue\r\n'];
      interceptor.outbound.push(fakeCommand(['SET', 'key1', 'value']), encoded, ['SET', 'key1', 'value']);

      const interceptorStats = interceptor.stats();
      const outboundStats = interceptor.outbound.stats();

      assert.equal(interceptorStats.totalCommandCount, outboundStats.totalCommandCount);
      assert.equal(interceptorStats.batchedCommandCount, outboundStats.batchedCommandCount);
    });
  });

  // ==========================================================================
  // Edge cases
  // ==========================================================================
  describe('edge cases', function () {
    it('handles very large counts', function () {
      const stats = BinaryHeaderStats.of(
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER - 1,
        1000000,
        1,
        100,
        100,
        100,
        100,
        600
      );

      assert.equal(stats.totalCommandCount, Number.MAX_SAFE_INTEGER);
      assert.ok(stats.batchRate() > 0.99);
      assert.equal(stats.averageBatchSize(), (Number.MAX_SAFE_INTEGER - 1) / 1000000);
    });

    it('batchRate and ineligibleRate are bounded 0-1', function () {
      const stats = BinaryHeaderStats.of(100, 50, 10, 30);

      const batchRate = stats.batchRate();
      const ineligibleRate = stats.ineligibleRate();

      assert.ok(batchRate >= 0 && batchRate <= 1, `batchRate ${batchRate} out of bounds`);
      assert.ok(ineligibleRate >= 0 && ineligibleRate <= 1, `ineligibleRate ${ineligibleRate} out of bounds`);
    });
  });
});

// ============================================================================
// BinaryHeaderStats Immutability Tests
// ============================================================================

describe('BinaryHeaderStats Immutability (table-driven)', function () {
  interface ImmutabilityTestCase {
    name: string;
    createStats: () => BinaryHeaderStats;
    expectedValues: ExpectedStats;
  }

  const immutabilityCases: ImmutabilityTestCase[] = [
    {
      name: 'stats created via of() are immutable',
      createStats: () => BinaryHeaderStats.of(10, 8, 2, 1, 1, 0, 0, 1, 0),
      expectedValues: {
        totalCommandCount: 10,
        batchedCommandCount: 8,
        batchCount: 2,
        ineligibleCount: 1,
        slotMismatchFlushCount: 1,
        timerFlushCount: 1,
      },
    },
    {
      name: 'stats created via empty() are immutable',
      createStats: () => BinaryHeaderStats.empty(),
      expectedValues: {
        totalCommandCount: 0,
        batchedCommandCount: 0,
        batchCount: 0,
        ineligibleCount: 0,
      },
    },
    {
      name: 'stats created via plus() are immutable',
      createStats: () => {
        const a = BinaryHeaderStats.of(5, 4, 1, 1, 1, 0, 0, 0, 0);
        const b = BinaryHeaderStats.of(5, 4, 1, 0, 0, 0, 0, 1, 0);
        return a.plus(b);
      },
      expectedValues: {
        totalCommandCount: 10,
        batchedCommandCount: 8,
        batchCount: 2,
        ineligibleCount: 1,
        slotMismatchFlushCount: 1,
        timerFlushCount: 1,
      },
    },
    {
      name: 'stats created via minus() are immutable',
      createStats: () => {
        const a = BinaryHeaderStats.of(100, 80, 10, 20, 3, 2, 1, 4, 0);
        const b = BinaryHeaderStats.of(50, 40, 5, 10, 1, 1, 1, 2, 0);
        return a.minus(b);
      },
      expectedValues: {
        totalCommandCount: 50,
        batchedCommandCount: 40,
        batchCount: 5,
        ineligibleCount: 10,
        slotMismatchFlushCount: 2,
        timerFlushCount: 2,
      },
    },
  ];

  for (const tc of immutabilityCases) {
    it(tc.name, function () {
      const stats = tc.createStats();

      // Verify expected values
      assertStats(stats, tc.expectedValues);

      // Attempt operations that might mutate (if object were mutable)
      // This verifies the object is truly immutable by checking values don't change
      const originalTotal = stats.totalCommandCount;
      const originalBatched = stats.batchedCommandCount;

      // Perform arithmetic operations (should return new objects, not mutate)
      const plusResult = stats.plus(BinaryHeaderStats.of(100, 100, 10, 0, 0, 0, 0, 0, 0));
      const minusResult = stats.minus(BinaryHeaderStats.of(1, 1, 1, 0, 0, 0, 0, 0, 0));

      // Original should be unchanged
      assert.equal(stats.totalCommandCount, originalTotal, 'totalCommandCount mutated');
      assert.equal(stats.batchedCommandCount, originalBatched, 'batchedCommandCount mutated');

      // Results should be different objects
      assert.notStrictEqual(plusResult, stats, 'plus() should return new object');
      assert.notStrictEqual(minusResult, stats, 'minus() should return new object');
    });
  }

  it('empty() singleton is not affected by arithmetic operations', function () {
    const empty1 = BinaryHeaderStats.empty();
    const other = BinaryHeaderStats.of(10, 8, 2, 1, 1, 0, 0, 1, 0);

    // Perform operations
    empty1.plus(other);
    empty1.minus(other);

    // empty() should still be all zeros
    const empty2 = BinaryHeaderStats.empty();
    assert.strictEqual(empty1, empty2, 'empty() should return same singleton');
    assert.equal(empty1.totalCommandCount, 0);
    assert.equal(empty1.batchedCommandCount, 0);
  });
});

// ============================================================================
// DefaultBinaryHeaderStatsCounter Stress Tests (table-driven)
// ============================================================================

describe('DefaultBinaryHeaderStatsCounter Stress (table-driven)', function () {
  interface StressTestCase {
    name: string;
    operations: number;
    action: (counter: DefaultBinaryHeaderStatsCounter) => void;
    verify: (stats: BinaryHeaderStats) => void;
  }

  const stressCases: StressTestCase[] = [
    {
      name: 'high volume recordCommand()',
      operations: 10000,
      action: (counter) => {
        for (let i = 0; i < 10000; i++) {
          counter.recordCommand();
        }
      },
      verify: (stats) => {
        assert.equal(stats.totalCommandCount, 10000);
      },
    },
    {
      name: 'high volume mixed operations',
      operations: 5000,
      action: (counter) => {
        for (let i = 0; i < 1000; i++) {
          counter.recordCommand();
          counter.recordBatchedCommand();
          if (i % 10 === 0) counter.recordFlush(FlushReason.SLOT_MISMATCH);
          if (i % 50 === 0) counter.recordFlush(FlushReason.TIMER_EXPIRED);
          if (i % 100 === 0) counter.recordIneligible();
        }
      },
      verify: (stats) => {
        assert.equal(stats.totalCommandCount, 1000);
        assert.equal(stats.batchedCommandCount, 1000);
        assert.equal(stats.slotMismatchFlushCount, 100); // i % 10 === 0: 0,10,20...990
        assert.equal(stats.timerFlushCount, 20); // i % 50 === 0: 0,50,100...950
        assert.equal(stats.ineligibleCount, 10); // i % 100 === 0: 0,100,200...900
        assert.equal(stats.batchCount, 120); // 100 slot + 20 timer
      },
    },
    {
      name: 'rapid snapshot calls do not affect counter',
      operations: 1000,
      action: (counter) => {
        for (let i = 0; i < 100; i++) {
          counter.recordCommand();
          counter.snapshot(); // snapshot after each
          counter.recordBatchedCommand();
          counter.snapshot();
        }
      },
      verify: (stats) => {
        assert.equal(stats.totalCommandCount, 100);
        assert.equal(stats.batchedCommandCount, 100);
      },
    },
  ];

  for (const tc of stressCases) {
    it(tc.name, function () {
      const counter = DefaultBinaryHeaderStatsCounter.create();
      tc.action(counter);
      tc.verify(counter.snapshot());
    });
  }
});

// ============================================================================
// Flush Reason Consistency (table-driven)
// ============================================================================

describe('Flush Reason Consistency (table-driven)', function () {
  interface FlushConsistencyCase {
    name: string;
    flushReasons: FlushReason[];
    expectedTotalFlushCount: number;
  }

  const flushConsistencyCases: FlushConsistencyCase[] = [
    {
      name: 'all SLOT_MISMATCH',
      flushReasons: [FlushReason.SLOT_MISMATCH, FlushReason.SLOT_MISMATCH, FlushReason.SLOT_MISMATCH],
      expectedTotalFlushCount: 3,
    },
    {
      name: 'all TIMER_EXPIRED',
      flushReasons: [FlushReason.TIMER_EXPIRED, FlushReason.TIMER_EXPIRED],
      expectedTotalFlushCount: 2,
    },
    {
      name: 'mixed flush reasons',
      flushReasons: [
        FlushReason.SLOT_MISMATCH,
        FlushReason.MAX_COMMANDS,
        FlushReason.MAX_PAYLOAD,
        FlushReason.TIMER_EXPIRED,
        FlushReason.DRAIN,
      ],
      expectedTotalFlushCount: 5,
    },
    {
      name: 'repeated mixed pattern',
      flushReasons: [
        FlushReason.SLOT_MISMATCH,
        FlushReason.TIMER_EXPIRED,
        FlushReason.SLOT_MISMATCH,
        FlushReason.TIMER_EXPIRED,
        FlushReason.DRAIN,
        FlushReason.DRAIN,
      ],
      expectedTotalFlushCount: 6,
    },
  ];

  for (const tc of flushConsistencyCases) {
    it(tc.name, function () {
      const counter = DefaultBinaryHeaderStatsCounter.create();

      for (const reason of tc.flushReasons) {
        counter.recordFlush(reason);
      }

      const stats = counter.snapshot();

      // Verify totalFlushCount
      assert.equal(stats.totalFlushCount(), tc.expectedTotalFlushCount);

      // Verify sum of individual flush counts equals totalFlushCount
      const sumOfFlushCounts = stats.slotMismatchFlushCount +
                               stats.maxCommandsFlushCount +
                               stats.maxPayloadFlushCount +
                               stats.timerFlushCount +
                               stats.drainFlushCount;
      assert.equal(sumOfFlushCounts, tc.expectedTotalFlushCount, 'Sum of individual flush counts should equal totalFlushCount');

      // Verify batchCount equals totalFlushCount
      assert.equal(stats.batchCount, tc.expectedTotalFlushCount, 'batchCount should equal totalFlushCount');
    });
  }
});

// ============================================================================
// Stats Arithmetic Comprehensive Tests
// ============================================================================

describe('Stats Arithmetic Comprehensive (table-driven)', function () {
  interface ArithmeticTestCase {
    name: string;
    a: BinaryHeaderStats;
    b: BinaryHeaderStats;
    operation: 'plus' | 'minus';
    expected: ExpectedStats;
  }

  const arithmeticCases: ArithmeticTestCase[] = [
    {
      name: 'plus: basic addition',
      a: BinaryHeaderStats.of(10, 8, 2, 1, 1, 0, 0, 1, 0),
      b: BinaryHeaderStats.of(20, 16, 4, 2, 2, 1, 0, 1, 0),
      operation: 'plus',
      expected: {
        totalCommandCount: 30,
        batchedCommandCount: 24,
        batchCount: 6,
        ineligibleCount: 3,
        slotMismatchFlushCount: 3,
        maxCommandsFlushCount: 1,
        maxPayloadFlushCount: 0,
        timerFlushCount: 2,
        drainFlushCount: 0,
      },
    },
    {
      name: 'plus: with empty',
      a: BinaryHeaderStats.of(100, 80, 10, 20, 5, 3, 2, 0, 0),
      b: BinaryHeaderStats.empty(),
      operation: 'plus',
      expected: {
        totalCommandCount: 100,
        batchedCommandCount: 80,
        batchCount: 10,
        ineligibleCount: 20,
        slotMismatchFlushCount: 5,
      },
    },
    {
      name: 'minus: basic subtraction',
      a: BinaryHeaderStats.of(100, 80, 10, 20, 5, 3, 2, 0, 0),
      b: BinaryHeaderStats.of(30, 25, 3, 5, 1, 1, 1, 0, 0),
      operation: 'minus',
      expected: {
        totalCommandCount: 70,
        batchedCommandCount: 55,
        batchCount: 7,
        ineligibleCount: 15,
        slotMismatchFlushCount: 4,
        maxCommandsFlushCount: 2,
        maxPayloadFlushCount: 1,
      },
    },
    {
      name: 'minus: clamps to zero',
      a: BinaryHeaderStats.of(10, 8, 2, 1, 1, 0, 0, 0, 0),
      b: BinaryHeaderStats.of(100, 80, 10, 20, 5, 3, 2, 0, 0),
      operation: 'minus',
      expected: {
        totalCommandCount: 0,
        batchedCommandCount: 0,
        batchCount: 0,
        ineligibleCount: 0,
        slotMismatchFlushCount: 0,
        maxCommandsFlushCount: 0,
        maxPayloadFlushCount: 0,
      },
    },
    {
      name: 'minus: partial clamp',
      a: BinaryHeaderStats.of(50, 40, 5, 10, 3, 2, 0, 0, 0),
      b: BinaryHeaderStats.of(30, 60, 3, 5, 1, 1, 5, 0, 0),
      operation: 'minus',
      expected: {
        totalCommandCount: 20,
        batchedCommandCount: 0, // clamped: 40 - 60 = -20 -> 0
        batchCount: 2,
        ineligibleCount: 5,
        slotMismatchFlushCount: 2,
        maxCommandsFlushCount: 1,
        maxPayloadFlushCount: 0, // clamped: 0 - 5 = -5 -> 0
      },
    },
  ];

  for (const tc of arithmeticCases) {
    it(tc.name, function () {
      const result = tc.operation === 'plus' ? tc.a.plus(tc.b) : tc.a.minus(tc.b);
      assertStats(result, tc.expected);
    });
  }
});
