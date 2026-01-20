import { strict as assert } from 'node:assert';
import { describe, it, afterEach } from 'mocha';
import { createClient, RedisClientType } from '../..';

const testCases = [
  {
    name: 'standalone with binary headers enabled',
    host: 'redis-17951.binhdr-bobby-aws-cluster-87765.cto.redislabs.com',
    port: 17951,
    password: 'test123',
    binaryHeaders: true,
    expectedPing: 'PONG'
  },
  {
    name: 'standalone with binary headers disabled',
    host: 'redis-17951.binhdr-bobby-aws-cluster-87765.cto.redislabs.com',
    port: 17951,
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

      assert.equal(await client.ping(), expectedPing);
    });
  }
});
