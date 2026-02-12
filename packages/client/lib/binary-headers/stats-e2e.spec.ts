import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { once } from 'node:events';
import net from 'node:net';
import { createClient, RedisClientType } from '../..';
import { createBinhdrResponse, assertStats, type ExpectedStats } from './test-utils';
import { RequestHeaderDecoder } from './generated/request-header-codec';
import type { BinaryHeaderStats } from './stats';

/**
 * End-to-end tests for binary headers statistics collection.
 *
 * These tests verify that stats are correctly tracked through the full client
 * stack (client -> queue -> codec -> packer) using a mock TCP server that
 * speaks the binary headers protocol.
 *
 * For unit tests of BinaryHeaderStats class and counters, see stats.spec.ts.
 */

interface ServerStats {
  totalRequests: number;
  totalCommands: number;
  batchSizes: number[];
}

function parseMultipleRequests(data: Buffer): Array<{ commandCount: number; length: number }> {
  const results: Array<{ commandCount: number; length: number }> = [];
  let offset = 0;

  while (offset < data.length) {
    const remaining = data.subarray(offset);
    if (remaining.length >= RequestHeaderDecoder.ENCODED_LENGTH &&
        remaining[0] === RequestHeaderDecoder.designatorConstantValue()) {
      const decoder = new RequestHeaderDecoder();
      decoder.wrap(remaining, 0);
      if (decoder.isValid()) {
        const payloadLen = decoder.length();
        results.push({ commandCount: decoder.commandCount(), length: payloadLen });
        offset += RequestHeaderDecoder.ENCODED_LENGTH + payloadLen;
        continue;
      }
    }
    break;
  }
  return results;
}

describe('Binary Headers Stats E2E', function () {
  this.timeout(5000);

  let server: net.Server;
  let port: number;
  let serverStats: ServerStats;
  let client: RedisClientType;

  async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          srv.close(() => resolve(addr.port));
        } else {
          reject(new Error('Could not get port'));
        }
      });
    });
  }

  function createMockServer(): net.Server {
    return net.createServer((socket) => {
      socket.on('data', (data) => {
        const requests = parseMultipleRequests(data);
        for (const req of requests) {
          serverStats.totalRequests++;
          serverStats.totalCommands += req.commandCount;
          serverStats.batchSizes.push(req.commandCount);
          for (let i = 0; i < req.commandCount; i++) {
            socket.write(createBinhdrResponse('+OK\r\n'));
          }
        }
      });
    });
  }

  async function createConnectedClient(): Promise<RedisClientType> {
    client = createClient({
      socket: { host: 'localhost', port },
      binaryHeaders: { enabled: true, 'stats-collector': 'enabled' },
      disableClientInfo: true,
    });
    client.on('error', () => {});
    await client.connect();
    return client;
  }

  function getClientStats(): BinaryHeaderStats {
    const stats = (client.options as any).binaryHeaders?.getStats?.();
    assert.ok(stats, 'Stats should be available when stats-collector is enabled');
    return stats;
  }

  beforeEach(async function () {
    port = await getFreePort();
    serverStats = { totalRequests: 0, totalCommands: 0, batchSizes: [] };
    server = createMockServer();
    await once(server.listen(port), 'listening');
  });

  afterEach(async function () {
    if (client) {
      client.destroy();
    }
    server?.close();
  });

  // ==========================================================================
  // Table-driven stats tests
  // ==========================================================================

  interface StatsTestCase {
    name: string;
    commands: () => Promise<void>;
    expectedStats: ExpectedStats;
    expectedServerStats?: {
      totalCommands?: number;
      totalRequests?: number;
      batchSizes?: number[];
    };
  }

  const statsTestCases: StatsTestCase[] = [
    {
      name: 'single sequential commands: each flushed by timer',
      commands: async () => {
        await client.sendCommand(['SET', 'key1', 'v'] as const);
        await client.sendCommand(['SET', 'key2', 'v'] as const);
        await client.sendCommand(['SET', 'key3', 'v'] as const);
      },
      expectedStats: {
        totalCommandCount: 3,
        batchedCommandCount: 3,
        batchCount: 3,
        ineligibleCount: 0,
        slotMismatchFlushCount: 0,
        maxCommandsFlushCount: 0,
        maxPayloadFlushCount: 0,
        timerFlushCount: 3,
        drainFlushCount: 0,
      },
      expectedServerStats: {
        totalCommands: 3,
        totalRequests: 3,
      },
    },
    {
      name: 'same-slot commands batch together',
      commands: async () => {
        await Promise.all([
          client.sendCommand(['SET', '{s}a', 'v'] as const),
          client.sendCommand(['SET', '{s}b', 'v'] as const),
          client.sendCommand(['SET', '{s}c', 'v'] as const),
        ]);
      },
      expectedStats: {
        totalCommandCount: 3,
        batchedCommandCount: 3,
        batchCount: 1,
        ineligibleCount: 0,
        slotMismatchFlushCount: 0,
        maxCommandsFlushCount: 0,
        maxPayloadFlushCount: 0,
        timerFlushCount: 1,
        drainFlushCount: 0,
        batchRate: 1.0,
        averageBatchSize: 3,
        passthroughCount: 0,
        ineligibleRate: 0,
        totalFlushCount: 1,
      },
      expectedServerStats: {
        totalCommands: 3,
        totalRequests: 1,
        batchSizes: [3],
      },
    },
    {
      name: 'execAsPipeline batches commands',
      commands: async () => {
        await client.multi()
          .addCommand(['SET', '{x}1', 'v'])
          .addCommand(['SET', '{x}2', 'v'])
          .addCommand(['SET', '{x}3', 'v'])
          .execAsPipeline();
      },
      expectedStats: {
        totalCommandCount: 3,
        batchedCommandCount: 3,
        batchCount: 1,
        ineligibleCount: 0,
        slotMismatchFlushCount: 0,
        maxCommandsFlushCount: 0,
        maxPayloadFlushCount: 0,
        totalFlushCount: 1,
      },
      expectedServerStats: {
        totalCommands: 3,
        totalRequests: 1,
      },
    },
    {
      name: 'sequential pipelines with different slots create separate batches',
      commands: async () => {
        await client.multi()
          .addCommand(['SET', '{a}1', 'v'])
          .addCommand(['SET', '{a}2', 'v'])
          .execAsPipeline();

        await client.multi()
          .addCommand(['SET', '{b}1', 'v'])
          .addCommand(['SET', '{b}2', 'v'])
          .execAsPipeline();
      },
      expectedStats: {
        totalCommandCount: 4,
        batchedCommandCount: 4,
        batchCount: 2,
        ineligibleCount: 0,
        slotMismatchFlushCount: 0,
        maxCommandsFlushCount: 0,
        maxPayloadFlushCount: 0,
        timerFlushCount: 0,
        drainFlushCount: 2,
        averageBatchSize: 2,
      },
      expectedServerStats: {
        totalCommands: 4,
        totalRequests: 2,
      },
    },
    {
      name: 'slot mismatch triggers flush',
      commands: async () => {
        await Promise.all([
          client.sendCommand(['SET', '{a}1', 'v'] as const),
          client.sendCommand(['SET', '{b}1', 'v'] as const),
        ]);
      },
      expectedStats: {
        totalCommandCount: 2,
        batchedCommandCount: 2,
        batchCount: 2,
        ineligibleCount: 0,
        slotMismatchFlushCount: 1,
        maxCommandsFlushCount: 0,
        maxPayloadFlushCount: 0,
        timerFlushCount: 1,
        drainFlushCount: 0,
        totalFlushCount: 2,
      },
    },
    {
      name: 'alternating slots with Promise.all: all commands complete',
      commands: async () => {
        await Promise.all([
          client.sendCommand(['SET', '{slot1}key1', 'v'] as const),
          client.sendCommand(['SET', '{slot2}key2', 'v'] as const),
          client.sendCommand(['SET', '{slot1}key3', 'v'] as const),
        ]);
      },
      expectedStats: {
        totalCommandCount: 3,
        batchedCommandCount: 3,
        batchCount: 3,
        ineligibleCount: 0,
        slotMismatchFlushCount: 2,
        maxCommandsFlushCount: 0,
        maxPayloadFlushCount: 0,
        timerFlushCount: 1,
        drainFlushCount: 0,
        totalFlushCount: 3,
        averageBatchSize: 1,
      },
      expectedServerStats: {
        totalCommands: 3,
      },
    },
    {
      name: 'batch rate is 100% for eligible same-slot commands',
      commands: async () => {
        await Promise.all([
          client.sendCommand(['SET', '{z}1', 'v'] as const),
          client.sendCommand(['SET', '{z}2', 'v'] as const),
        ]);
      },
      expectedStats: {
        batchRate: 1.0,
        ineligibleRate: 0,
        passthroughCount: 0,
      },
    },
    {
      name: 'mixed sequential and batched commands',
      commands: async () => {
        await client.sendCommand(['SET', 'solo', 'v'] as const);
        await Promise.all([
          client.sendCommand(['SET', '{m}1', 'v'] as const),
          client.sendCommand(['SET', '{m}2', 'v'] as const),
        ]);
      },
      expectedStats: {
        totalCommandCount: 3,
        batchedCommandCount: 3,
        batchCount: 2,
        timerFlushCount: 2,
      },
      expectedServerStats: {
        totalCommands: 3,
      },
    },
  ];

  for (const tc of statsTestCases) {
    it(tc.name, async function () {
      await createConnectedClient();
      await tc.commands();

      const stats = getClientStats();
      assertStats(stats, tc.expectedStats);

      if (tc.expectedServerStats) {
        if (tc.expectedServerStats.totalCommands !== undefined) {
          assert.equal(serverStats.totalCommands, tc.expectedServerStats.totalCommands, 'server totalCommands');
        }
        if (tc.expectedServerStats.totalRequests !== undefined) {
          assert.equal(serverStats.totalRequests, tc.expectedServerStats.totalRequests, 'server totalRequests');
        }
        if (tc.expectedServerStats.batchSizes !== undefined) {
          assert.deepEqual(serverStats.batchSizes, tc.expectedServerStats.batchSizes, 'server batchSizes');
        }
      }
    });
  }

  // ==========================================================================
  // Stats operations tests
  // ==========================================================================

  describe('stats operations', function () {
    it('plus and minus work correctly', async function () {
      await createConnectedClient();

      const initialStats = getClientStats();

      await Promise.all([
        client.sendCommand(['SET', '{p}1', 'v'] as const),
        client.sendCommand(['SET', '{p}2', 'v'] as const),
      ]);

      const afterFirstBatch = getClientStats();

      await Promise.all([
        client.sendCommand(['SET', '{q}1', 'v'] as const),
        client.sendCommand(['SET', '{q}2', 'v'] as const),
      ]);

      const afterSecondBatch = getClientStats();

      // Test minus: difference should show only the second batch
      const diff = afterSecondBatch.minus(afterFirstBatch);
      assertStats(diff, {
        totalCommandCount: 2,
        batchedCommandCount: 2,
        batchCount: 1,
      });

      // Test plus: adding diffs should give same as final
      const reconstructed = initialStats
        .plus(afterFirstBatch.minus(initialStats))
        .plus(diff);
      assert.equal(
        reconstructed.totalCommandCount,
        afterSecondBatch.totalCommandCount,
        'plus reconstruction'
      );
    });

    it('snapshot is isolated from further changes', async function () {
      await createConnectedClient();

      await client.sendCommand(['SET', 'snap1', 'v'] as const);
      const snapshot1 = getClientStats();

      await client.sendCommand(['SET', 'snap2', 'v'] as const);
      const snapshot2 = getClientStats();

      assert.equal(snapshot1.totalCommandCount, 1, 'snapshot1 unchanged');
      assert.equal(snapshot2.totalCommandCount, 2, 'snapshot2 has both');
    });

    it('client and server command counts always match', async function () {
      await createConnectedClient();

      await client.sendCommand(['SET', 'solo', 'v'] as const);
      await Promise.all([
        client.sendCommand(['SET', '{m}1', 'v'] as const),
        client.sendCommand(['SET', '{m}2', 'v'] as const),
      ]);

      const stats = getClientStats();
      assert.equal(stats.totalCommandCount, serverStats.totalCommands, 'client and server match');
    });
  });
});
