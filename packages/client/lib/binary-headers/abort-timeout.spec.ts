import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { once } from 'node:events';
import net from 'node:net';
import RedisClient, { BinaryHeadersOptions, RedisClientType } from '../client';
import RedisCommandsQueue from '../client/commands-queue';
import {
  createBinhdrFrame,
  parseRequestFrames,
  type ParsedRequestFrame,
} from './test-utils';
import { RequestHeaderEncoder } from './generated/request-header-codec';
import { calculateSlot } from './new-slot-calulator';

const createClient = RedisClient.create;

function responseForCommand(command: string[]): string {
  return command[0].toUpperCase() === 'PING' ? '+PONG\r\n' : '+OK\r\n';
}

function maybeKey(command: string[]): string | undefined {
  switch (command[0].toUpperCase()) {
    case 'SET':
    case 'GET':
    case 'INCR':
      return command[1];
    default:
      return undefined;
  }
}

function assertRequestFrameValid(request: ParsedRequestFrame): void {
  if (request.type === 'raw') {
    assert.equal(request.commands.length >= 1, true, 'raw request should contain at least one command');
    return;
  }

  assert.equal(request.payload.length, request.header.length, 'Payload length should match header');
  assert.equal(request.commands.length, request.header.commandCount, 'commandCount should match parsed RESP commands');

  let expectedSlot: number | undefined;
  for (const command of request.commands) {
    const key = maybeKey(command);
    if (key === undefined) {
      continue;
    }

    const slot = calculateSlot(key);
    if (expectedSlot === undefined) {
      expectedSlot = slot;
    } else {
      assert.equal(slot, expectedSlot, 'all keyed commands in one binary frame should share the same slot');
    }
  }

  assert.equal(
    request.header.slot,
    expectedSlot ?? RequestHeaderEncoder.slotNullValue(),
    'binary header slot should match parsed command keys'
  );
}

describe('Binary Headers Abort and Timeout', function () {
  this.timeout(10000);

  let server: net.Server | undefined;
  let port: number;
  let receivedRequests: ParsedRequestFrame[];
  let client: RedisClientType | undefined;

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

  type ResponseMode = 'smart' | 'ok-only' | 'pong-only';

  function createMockServer(mode: ResponseMode = 'smart'): net.Server {
    return net.createServer((socket) => {
      socket.on('data', (data) => {
        for (const request of parseRequestFrames(data)) {
          receivedRequests.push(request);
          assertRequestFrameValid(request);

          for (const command of request.commands) {
            const resp = mode === 'pong-only' ? '+PONG\r\n'
              : mode === 'ok-only' ? '+OK\r\n'
              : responseForCommand(command);
            socket.write(
              request.type === 'binary'
                ? createBinhdrFrame(Buffer.from(resp), 1, request.header.clientIdx)
                : resp
            );
          }
        }
      });
    });
  }

  async function createConnectedClient(
    binaryHeaders: boolean | BinaryHeadersOptions = { enabled: true }
  ): Promise<RedisClientType> {
    client = createClient({
      socket: { host: 'localhost', port },
      binaryHeaders,
      disableClientInfo: true,
    });
    client.on('error', () => {});
    await client.connect();
    return client;
  }

  function getAllPayloads(): string {
    return receivedRequests
      .flatMap(request => request.commands.map(command => command.join(' ')))
      .join('\n');
  }

  function assertAllRequestsValid(): void {
    for (const req of receivedRequests) {
      assertRequestFrameValid(req);
    }
  }

  beforeEach(async function () {
    port = await getFreePort();
    receivedRequests = [];
  });

  afterEach(function () {
    if (client?.isOpen) {
      client.destroy();
    }
    client = undefined;
    server?.close();
    server = undefined;
  });

  describe('Abort signal handling', function () {
    it('rejects pre-aborted commands immediately', async function () {
      server = createMockServer();
      await once(server.listen(port), 'listening');
      await createConnectedClient();

      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        client.sendCommand(['SET', 'key', 'value'], { abortSignal: controller.signal }),
        { message: 'The command was aborted' }
      );

      // Client should still work after abort
      assert.equal(await client.ping(), 'PONG');
    });

    it('removes abort listener after command completes', async function () {
      server = createMockServer('pong-only');
      await once(server.listen(port), 'listening');
      await createConnectedClient();

      const controller = new AbortController();
      assert.equal(await client.sendCommand(['PING'], { abortSignal: controller.signal }), 'PONG');

      // Abort after completion should have no effect
      controller.abort();
      assert.equal(await client.ping(), 'PONG');
    });

    it('flushes command with abortSignal without relying on timer callback', async function () {
      server = createMockServer('ok-only');
      await once(server.listen(port), 'listening');
      let scheduledCount = 0;
      await createConnectedClient({
        enabled: true,
        timer: {
          maxWaitTime: 100,
          scheduler: {
            schedule(_delayMs: number, _task: () => void) {
              scheduledCount++;
              return { cancel() {} };
            },
          },
        },
      });

      const controller = new AbortController();
      const promise = client.sendCommand(['SET', '{abort}key', 'value'], {
        abortSignal: controller.signal,
      });

      const result = await Promise.race([
        promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Command should not wait for timer flush')), 250)),
      ]);

      // Abort after command has completed - no effect.
      controller.abort();
      assert.equal(result, 'OK');

      assert.equal(scheduledCount, 0, 'Abort-enabled command should not rely on timer scheduling');
      const payloads = getAllPayloads();
      assert.equal(payloads.includes('{abort}key'), true, 'Command should be written immediately');
    });

    it('maintains header integrity when pre-aborted command mixed with valid commands', async function () {
      server = createMockServer('ok-only');
      await once(server.listen(port), 'listening');
      await createConnectedClient();

      const controller = new AbortController();
      controller.abort();

      const results = await Promise.allSettled([
        client.sendCommand(['SET', '{y}key1', 'value1']),
        client.sendCommand(['SET', '{y}key2', 'value2'], { abortSignal: controller.signal }),
        client.sendCommand(['SET', '{y}key3', 'value3']),
      ]);

      assert.equal(results[0].status, 'fulfilled');
      assert.equal(results[1].status, 'rejected');
      assert.equal(results[2].status, 'fulfilled');
      assertAllRequestsValid();
    });

    it('cleans up abort listeners for batch commands', async function () {
      server = net.createServer((socket) => {
      socket.on('data', (data) => {
        for (const request of parseRequestFrames(data)) {
          receivedRequests.push(request);
          assertRequestFrameValid(request);
          for (const _command of request.commands) {
            socket.write(
              request.type === 'binary'
                ? createBinhdrFrame(Buffer.from('+OK\r\n'), 1, request.header.clientIdx)
                : '+OK\r\n'
            );
          }
        }
      });
      });
      await once(server.listen(port), 'listening');
      await createConnectedClient();

      const controllers = [new AbortController(), new AbortController(), new AbortController()];
      const results = await Promise.all([
        client.sendCommand(['SET', '{w}a', '1'], { abortSignal: controllers[0].signal }),
        client.sendCommand(['SET', '{w}b', '2'], { abortSignal: controllers[1].signal }),
        client.sendCommand(['SET', '{w}c', '3'], { abortSignal: controllers[2].signal }),
      ]);

      results.forEach(r => assert.equal(r, 'OK'));

      // Abort after completion - should have no effect
      controllers.forEach(c => c.abort());

      assertAllRequestsValid();
      const payloads = getAllPayloads();
      assert(payloads.includes('{w}a'));
      assert(payloads.includes('{w}b'));
      assert(payloads.includes('{w}c'));
    });
  });

  describe('Timeout handling', function () {
    it('removes timeout listener after command completes', async function () {
      server = createMockServer('pong-only');
      await once(server.listen(port), 'listening');
      await createConnectedClient();

      assert.equal(await client.sendCommand(['PING'], { timeout: 5000 }), 'PONG');
      assert.equal(await client.ping(), 'PONG');
    });

    it('handles mixed timeout values correctly', async function () {
      server = createMockServer('ok-only');
      await once(server.listen(port), 'listening');
      await createConnectedClient();

      const results = await Promise.all([
        client.sendCommand(['SET', '{t}a', '1'], { timeout: 1000 }),
        client.sendCommand(['SET', '{t}b', '2'], { timeout: 2000 }),
        client.sendCommand(['SET', '{t}c', '3'], { timeout: 3000 }),
      ]);

      results.forEach(r => assert.equal(r, 'OK'));

      const payloads = getAllPayloads();
      assert(payloads.includes('{t}a'));
      assert(payloads.includes('{t}b'));
      assert(payloads.includes('{t}c'));
      assertAllRequestsValid();
    });
  });

  describe('Combined abort and timeout', function () {
    it('handles command with both abort and timeout that completes successfully', async function () {
      server = createMockServer();
      await once(server.listen(port), 'listening');
      await createConnectedClient();

      const controller = new AbortController();
      assert.equal(
        await client.sendCommand(['SET', 'dual-key', 'value'], {
          abortSignal: controller.signal,
          timeout: 5000,
        }),
        'OK'
      );

      // Abort after completion - no effect
      controller.abort();
      assert.equal(await client.ping(), 'PONG');
    });
  });

  describe('Binary headers option normalization', function () {
    function countWriteHandlerWiring(binaryHeaders: boolean | { enabled: true }): number {
      const original = RedisCommandsQueue.prototype.setWriteHandler;
      let calls = 0;

      try {
        (RedisCommandsQueue.prototype as unknown as { setWriteHandler: typeof original }).setWriteHandler =
          function (this: RedisCommandsQueue, callback: (writes: ReadonlyArray<ReadonlyArray<unknown>>) => void): void {
            calls++;
            original.call(this, callback as Parameters<typeof original>[0]);
          };

        createClient({
          binaryHeaders,
          disableClientInfo: true,
        }).on('error', () => {});
      } finally {
        (RedisCommandsQueue.prototype as unknown as { setWriteHandler: typeof original }).setWriteHandler = original;
      }

      return calls;
    }

    it('binaryHeaders object form wires write handler (control)', function () {
      assert.equal(
        countWriteHandlerWiring({ enabled: true }),
        1,
        'Expected write handler to be wired for binaryHeaders: { enabled: true }'
      );
    });

    it('binaryHeaders: true wires write handler', function () {
      assert.equal(
        countWriteHandlerWiring(true),
        1,
        'Expected write handler to be wired for binaryHeaders: true'
      );
    });
  });
});
