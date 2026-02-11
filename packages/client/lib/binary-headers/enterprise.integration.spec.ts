import { strict as assert } from 'node:assert';
import { describe, it, afterEach } from 'mocha';
import { setTimeout } from 'node:timers/promises';
import { createClient, RedisClientType } from '../..';

const testCases = [
  {
    name: 'standalone with binary headers enabled',
    host: 'redis-15723.aws-cluster-25422.cto.redislabs.com',
    port: 15723,
    password: 'test123',
    binaryHeaders: true,
    expectedPing: 'PONG'
  },
  {
    name: 'standalone with binary headers disabled',
    host: 'redis-15723.aws-cluster-25422.cto.redislabs.com',
    port: 15723,
    password: 'test123',
    binaryHeaders: false,
    expectedPing: 'PONG'
  }
];

describe('Redis Enterprise Binary Headers Integration', function () {
  this.timeout(30000);

  let client: RedisClientType;

  afterEach(async function () {
    if (client) await client.destroy();
  });

  for (const { name, host, port, password, binaryHeaders, expectedPing } of testCases) {
    it(`PING: ${name}`, async function () {
      client = createClient({
        socket: { host, port },
        password,
        binaryHeaders
      });
      client.on('error', () => {});
      await client.connect();

      // Wait for binary headers resolver to load (it's async)
      if (binaryHeaders) {
        await setTimeout(100);
      }

      assert.equal(await client.ping(), expectedPing);
    });
  }
});
