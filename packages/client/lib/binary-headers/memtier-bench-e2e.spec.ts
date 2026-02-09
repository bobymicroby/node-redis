import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { once } from 'node:events';
import net from 'node:net';
import { createClient, RedisClientType } from '../..';
import { createBinhdrResponse } from './test-utils';
import { RequestHeaderDecoder } from './generated/request-header-codec';
import type { BinaryHeaderStats } from './stats';

/**
 * End-to-end tests for binary headers stats alignment.
 * Uses a mock TCP server that speaks the binary headers protocol.
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

  it('single commands: client stats match server', async function () {
    await createConnectedClient();

    // 3 commands with different slots
    await client.sendCommand(['SET', 'key1', 'v'] as const);
    await client.sendCommand(['SET', 'key2', 'v'] as const);
    await client.sendCommand(['SET', 'key3', 'v'] as const);

    const stats = getClientStats();

    assert.equal(stats.totalCommandCount, 3);
    assert.equal(serverStats.totalCommands, 3);
  });

  it('same-slot commands batch together', async function () {
    await createConnectedClient();

    // 3 commands with same slot should batch
    await Promise.all([
      client.sendCommand(['SET', '{s}a', 'v'] as const),
      client.sendCommand(['SET', '{s}b', 'v'] as const),
      client.sendCommand(['SET', '{s}c', 'v'] as const),
    ]);

    const stats = getClientStats();
    assert.equal(stats.totalCommandCount, 3);
    assert.equal(stats.batchCount, 1);
    assert.equal(serverStats.totalRequests, 1);
    assert.equal(serverStats.batchSizes[0], 3);
  });

  it('execAsPipeline batches commands', async function () {
    await createConnectedClient();

    await client.multi()
      .addCommand(['SET', '{x}1', 'v'])
      .addCommand(['SET', '{x}2', 'v'])
      .addCommand(['SET', '{x}3', 'v'])
      .execAsPipeline();

    const stats = getClientStats();
    assert.equal(stats.totalCommandCount, 3);
    assert.equal(stats.batchCount, 1);
    assert.equal(serverStats.totalRequests, 1);
  });

  it('different slots create separate batches', async function () {
    await createConnectedClient();

    // Two sequential execAsPipeline with different slots
    await client.multi()
      .addCommand(['SET', '{a}1', 'v'])
      .addCommand(['SET', '{a}2', 'v'])
      .execAsPipeline();

    await client.multi()
      .addCommand(['SET', '{b}1', 'v'])
      .addCommand(['SET', '{b}2', 'v'])
      .execAsPipeline();

    const stats = getClientStats();
    assert.equal(stats.totalCommandCount, 4);
    assert.equal(stats.batchCount, 2);
    assert.equal(serverStats.totalRequests, 2);
  });

  it('slot mismatch triggers flush', async function () {
    await createConnectedClient();

    await Promise.all([
      client.sendCommand(['SET', '{a}1', 'v'] as const),
      client.sendCommand(['SET', '{b}1', 'v'] as const), // different slot
    ]);

    const stats = getClientStats();
    assert.equal(stats.totalCommandCount, 2);
    assert(stats.slotMismatchFlushCount >= 1, 'Should have slot mismatch flush');
  });

  it('alternating slots with Promise.all: all commands complete', async function () {
    await createConnectedClient();

    // 3 commands with alternating slots: A, B, A
    // This tests that timer is rescheduled correctly after each slot flush
    await Promise.all([
      client.sendCommand(['SET', '{slot1}key1', 'v'] as const),
      client.sendCommand(['SET', '{slot2}key2', 'v'] as const), // different slot - triggers flush
      client.sendCommand(['SET', '{slot1}key3', 'v'] as const), // different slot again - triggers flush
    ]);

    const stats = getClientStats();
    assert.equal(stats.totalCommandCount, 3);
    assert.equal(serverStats.totalCommands, 3);
    // Should have at least 2 slot mismatch flushes (A->B and B->A)
    assert(stats.slotMismatchFlushCount >= 2, 'Should have multiple slot mismatch flushes');
  });

  it('batch rate is 100% for eligible commands', async function () {
    await createConnectedClient();

    await Promise.all([
      client.sendCommand(['SET', '{z}1', 'v'] as const),
      client.sendCommand(['SET', '{z}2', 'v'] as const),
    ]);

    const stats = getClientStats();
    assert.equal(stats.batchRate(), 1.0);
    assert.equal(stats.batchedCommandCount, stats.totalCommandCount);
  });

  it('client and server command counts always match', async function () {
    await createConnectedClient();

    // Mix: some batched, some not
    await client.sendCommand(['SET', 'solo', 'v'] as const);
    await Promise.all([
      client.sendCommand(['SET', '{m}1', 'v'] as const),
      client.sendCommand(['SET', '{m}2', 'v'] as const),
    ]);

    const stats = getClientStats();
    assert.equal(stats.totalCommandCount, serverStats.totalCommands);
  });
});
