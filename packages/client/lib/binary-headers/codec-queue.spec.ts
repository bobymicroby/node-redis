import { strict as assert } from 'node:assert';
import { describe, it, afterEach } from 'mocha';
import CodecQueue, { type CommandCodec, type TimerFlushCallback } from './codec-queue';
import { BinaryHeadersCodec } from './codec';
import { createTimeoutScheduler, createImmediateScheduler } from './packing';
import { RequestHeaderDecoder } from './generated/request-header-codec';
import { createBinhdrFrame, parseRespCommands } from './test-utils';
import {
  createBaseQueue,
  createBinhdrQueue,
  createBinhdrQueueWithTimer,
  createPassthroughQueue,
  getBothImplementations,
  collectYielded,
  ACTIVE_IMPLEMENTATION,
  STATIC_RESOLVER,
  type TestableQueue,
  type TestableQueueWithTimer,
} from './queue-test-factories';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertPackedHeader(
  packed: ReadonlyArray<unknown> | null,
  expected: { commandCount?: number; slot?: number }
): void {
  assert.ok(packed !== null, 'Expected packed data to be non-null');
  assert.ok(packed[0] instanceof Buffer, 'Expected first element to be a Buffer');

  const decoder = new RequestHeaderDecoder().wrap(packed[0] as Buffer, 0);
  assert.ok(decoder.isValid(), 'Expected valid header');

  if (expected.commandCount !== undefined) {
    assert.equal(decoder.commandCount(), expected.commandCount);
  }
  if (expected.slot !== undefined) {
    assert.equal(decoder.slot(), expected.slot);
  }
}

// ============================================================================
// Tests using the ACTIVE_IMPLEMENTATION (swappable via queue-test-factories)
// ============================================================================

describe(`Codec Queue [${ACTIVE_IMPLEMENTATION}]`, function () {
  describe('without codec (baseline behavior)', function () {
    function collectYieldedParsed(queue: TestableQueue): unknown[][] {
      const results: unknown[][] = [];
      for (const encoded of queue.commandsToWrite()) {
        results.push(parseRespCommands((encoded as string[]).join('')));
      }
      return results;
    }

    it('yields each command separately', function () {
      const queue = createBaseQueue();
      queue.addCommand(['SET', 'a', '1']);
      queue.addCommand(['GET', 'a']);

      const results = collectYieldedParsed(queue);
      assert.deepEqual(results, [[['SET', 'a', '1']], [['GET', 'a']]]);
    });

    it('yields nothing for empty queue', function () {
      const queue = createBaseQueue();
      const results = collectYieldedParsed(queue);
      assert.deepEqual(results, []);
    });

    it('processIncomingData writes directly to decoder', async function () {
      const queue = createBaseQueue();
      const promise = queue.addCommand<string>(['PING']);
      for (const _ of queue.commandsToWrite()) {}

      queue.processIncomingData(Buffer.from('+PONG\r\n'));
      const result = await promise;
      assert.equal(result, 'PONG');
    });
  });

  describe('with BinaryHeadersCodec', function () {
    it('batches multiple commands into single yield', function () {
      const queue = createBinhdrQueue();
      queue.addCommand(['PING']);
      queue.addCommand(['PING']);
      queue.addCommand(['PING']);

      const results = collectYielded(queue);

      assert.equal(results.length, 1);
      assertPackedHeader(results[0], { commandCount: 3 });
    });

    it('single command is batched with header', function () {
      const queue = createBinhdrQueue();
      queue.addCommand(['PING']);

      const results = collectYielded(queue);

      assert.equal(results.length, 1);
      assertPackedHeader(results[0], { commandCount: 1 });
    });

    it('processes incoming data through inbound codec', async function () {
      const queue = createBinhdrQueue();
      const promise = queue.addCommand<string>(['PING']);
      for (const _ of queue.commandsToWrite()) {}

      // Binary header frame with PONG response
      queue.processIncomingData(createBinhdrFrame(Buffer.from('+PONG\r\n')));
      const result = await promise;
      assert.equal(result, 'PONG');
    });
  });

  describe('with passthrough resolver', function () {
    it('yields each command separately (no batching)', function () {
      const queue = createPassthroughQueue();
      queue.addCommand(['SET', 'a', '1']);
      queue.addCommand(['GET', 'a']);

      const results: unknown[][] = [];
      for (const encoded of queue.commandsToWrite()) {
        results.push(parseRespCommands((encoded as string[]).join('')));
      }

      assert.deepEqual(results, [[['SET', 'a', '1']], [['GET', 'a']]]);
    });
  });

  describe('timer-based flushing', function () {
    let activeQueues: TestableQueueWithTimer[] = [];

    afterEach(function () {
      for (const queue of activeQueues) {
        queue.destroy();
      }
      activeQueues = [];
    });

    function createQueueWithTimer(maxWaitMs: number, useImmediate: boolean = false): TestableQueueWithTimer {
      const queue = createBinhdrQueueWithTimer({
        timer: {
          maxWaitMs,
          scheduler: useImmediate ? createImmediateScheduler() : createTimeoutScheduler(),
        },
      });
      activeQueues.push(queue);
      return queue;
    }

    it('destroy cancels pending flush', function () {
      const queue = createQueueWithTimer(1000);
      let called = false;
      queue.setTimerFlushCallback(() => { called = true; });

      queue.destroy();
      // After destroy, callback should be reset to noop
      assert.equal(called, false);
    });

    it('exposes maxWaitMs', function () {
      const queue = createQueueWithTimer(42);
      assert.equal(queue.maxWaitMs, 42);
    });
  });

  describe('integration with existing components', function () {
    it('works with STATIC_RESOLVER for slot-based batching', function () {
      const queue = createBinhdrQueue();

      // Commands with same key hash to same slot
      queue.addCommand(['SET', 'key1', 'value1']);
      queue.addCommand(['GET', 'key1']);

      const results = collectYielded(queue);

      // Should be batched together (same slot)
      assert.equal(results.length, 1);
      assertPackedHeader(results[0], { commandCount: 2 });
    });

    it('handles inbound binary header frames correctly', async function () {
      const queue = createBinhdrQueue();

      // Send command
      const promise = queue.addCommand<string>(['SET', 'key', 'value']);
      for (const _ of queue.commandsToWrite()) {}

      // Simulate response with binary header
      const responseFrame = createBinhdrFrame(Buffer.from('+OK\r\n'));
      queue.processIncomingData(responseFrame);

      const result = await promise;
      assert.equal(result, 'OK');
    });

    it('handles chunked binary header responses', async function () {
      const queue = createBinhdrQueue();

      const promise = queue.addCommand<string>(['PING']);
      for (const _ of queue.commandsToWrite()) {}

      // Split frame into chunks - first chunk shouldn't resolve yet
      const frame = createBinhdrFrame(Buffer.from('+PONG\r\n'));
      queue.processIncomingData(frame.subarray(0, 10));

      // Promise should still be pending
      let resolved = false;
      const raceResult = await Promise.race([
        promise.then(() => { resolved = true; return 'resolved'; }),
        delay(5).then(() => 'timeout')
      ]);
      assert.equal(raceResult, 'timeout');
      assert.equal(resolved, false);

      // Send remaining chunk
      queue.processIncomingData(frame.subarray(10));

      const result = await promise;
      assert.equal(result, 'PONG');
    });
  });
});

// ============================================================================
// Tests specific to CodecQueue interface (not swappable)
// These test the codec interface itself, independent of implementation
// ============================================================================

describe('Codec Queue Interface (CodecQueue specific)', function () {
  describe('without codec (baseline behavior)', function () {
    function createQueue(): CodecQueue {
      return new CodecQueue(2, null, () => {});
    }

    it('hasPendingOutbound returns false', function () {
      const queue = createQueue();
      queue.addCommand(['PING']);
      assert.equal(queue.hasPendingOutbound(), false);
    });

    it('drainPendingOutbound returns null', function () {
      const queue = createQueue();
      queue.addCommand(['PING']);
      assert.equal(queue.drainPendingOutbound(), null);
    });
  });

  describe('with BinaryHeadersCodec', function () {
    function createQueueWithCodec(): CodecQueue {
      const codec = new BinaryHeadersCodec({
        outbound: { resolver: STATIC_RESOLVER }
      });
      return new CodecQueue(2, null, () => {}, codec);
    }

    it('hasPendingOutbound reflects buffered commands', function () {
      const queue = createQueueWithCodec();
      assert.equal(queue.hasPendingOutbound(), false);

      // Commands are buffered until commandsToWrite() is called
      queue.addCommand(['PING']);
      // Note: commands are in toWrite, not in codec buffer yet
      assert.equal(queue.hasPendingOutbound(), false);
    });
  });

  describe('codec interface compliance', function () {
    it('OutboundCodec transform can return null to buffer', function () {
      let transformCalls = 0;
      const mockCodec: CommandCodec = {
        outbound: {
          transform: () => { transformCalls++; return null; },
          drain: () => null,
          hasPending: () => false
        },
        inbound: {
          process: (chunk, decoder) => decoder.write(chunk)
        }
      };

      const queue = new CodecQueue(2, null, () => {}, mockCodec);
      queue.addCommand(['PING']);

      const results: unknown[] = [];
      for (const encoded of queue.commandsToWrite()) {
        results.push(encoded);
      }

      assert.equal(transformCalls, 1);
      assert.equal(results.length, 0); // Nothing yielded because transform returned null
    });

    it('OutboundCodec drain is called at end of iteration', function () {
      let drainCalls = 0;
      const drainResult = ['drained-data'];
      const mockCodec: CommandCodec = {
        outbound: {
          transform: () => null,
          drain: () => { drainCalls++; return drainResult; },
          hasPending: () => drainCalls === 0
        },
        inbound: {
          process: (chunk, decoder) => decoder.write(chunk)
        }
      };

      const queue = new CodecQueue(2, null, () => {}, mockCodec);
      queue.addCommand(['PING']);

      const results: unknown[] = [];
      for (const encoded of queue.commandsToWrite()) {
        results.push(encoded);
      }

      assert.equal(drainCalls, 1);
      assert.deepEqual(results, [drainResult]);
    });

    it('InboundCodec process receives chunk and decoder', function () {
      let receivedChunk: Buffer | null = null;
      let receivedDecoder: any = null;

      const mockCodec: CommandCodec = {
        outbound: {
          transform: (encoded) => encoded,
          drain: () => null,
          hasPending: () => false
        },
        inbound: {
          process: (chunk, decoder) => {
            receivedChunk = chunk;
            receivedDecoder = decoder;
            decoder.write(chunk);
          }
        }
      };

      const queue = new CodecQueue(2, null, () => {}, mockCodec);
      queue.addCommand(['PING']);
      for (const _ of queue.commandsToWrite()) {}

      const testChunk = Buffer.from('+OK\r\n');
      queue.processIncomingData(testChunk);

      assert.deepEqual(receivedChunk, testChunk);
      assert.ok(receivedDecoder !== null);
    });
  });
});

// ============================================================================
// Comparative Tests - Run same tests against BOTH implementations
// ============================================================================

describe('Codec Queue [BOTH IMPLEMENTATIONS]', function () {
  const implementations = getBothImplementations();

  for (const impl of implementations) {
    describe(`${impl.name}`, function () {

      describe('basic command flow', function () {
        const basicCases = [
          { name: 'single PING', commands: [['PING']], expectedYields: 1 },
          { name: 'multiple PINGs', commands: [['PING'], ['PING'], ['PING']], expectedYields: 1 },
          { name: 'SET and GET same key', commands: [['SET', 'k', 'v'], ['GET', 'k']], expectedYields: 1 },
        ];

        for (const tc of basicCases) {
          it(tc.name, function () {
            const queue = impl.createQueue();
            tc.commands.forEach(cmd => queue.addCommand(cmd));

            const results = collectYielded(queue);
            assert.equal(results.length, tc.expectedYields);
          });
        }
      });

      describe('header encoding', function () {
        const headerCases = [
          { name: 'single command has count 1', commands: [['PING']], expectedCount: 1 },
          { name: 'two commands have count 2', commands: [['PING'], ['PING']], expectedCount: 2 },
          { name: 'five commands have count 5', commands: [['PING'], ['PING'], ['PING'], ['PING'], ['PING']], expectedCount: 5 },
        ];

        for (const tc of headerCases) {
          it(tc.name, function () {
            const queue = impl.createQueue();
            tc.commands.forEach(cmd => queue.addCommand(cmd));

            const results = collectYielded(queue);
            assert.equal(results.length, 1);
            assertPackedHeader(results[0], { commandCount: tc.expectedCount });
          });
        }
      });

      describe('response processing', function () {
        it('resolves single command', async function () {
          const queue = impl.createQueue();
          const promise = queue.addCommand<string>(['PING']);

          for (const _ of queue.commandsToWrite()) {}

          queue.processIncomingData(createBinhdrFrame(Buffer.from('+PONG\r\n')));

          const result = await promise;
          assert.equal(result, 'PONG');
        });

        it('resolves multiple commands in sequence', async function () {
          const queue = impl.createQueue();
          const p1 = queue.addCommand<string>(['SET', '{test}k', 'v']);
          const p2 = queue.addCommand<string>(['GET', '{test}k']);

          for (const _ of queue.commandsToWrite()) {}

          queue.processIncomingData(createBinhdrFrame(Buffer.from('+OK\r\n')));
          queue.processIncomingData(createBinhdrFrame(Buffer.from('$1\r\nv\r\n')));

          const [r1, r2] = await Promise.all([p1, p2]);
          assert.equal(r1, 'OK');
          assert.equal(r2, 'v');
        });
      });

      describe('timer support', function () {
        let activeQueues: TestableQueueWithTimer[] = [];

        afterEach(function () {
          for (const q of activeQueues) {
            q.destroy();
          }
          activeQueues = [];
        });

        it('exposes maxWaitMs from options', function () {
          const queue = impl.createQueueWithTimer({ timer: { maxWaitMs: 100 } });
          activeQueues.push(queue);
          assert.equal(queue.maxWaitMs, 100);
        });

        it('destroy can be called safely', function () {
          const queue = impl.createQueueWithTimer({ timer: { maxWaitMs: 50 } });
          activeQueues.push(queue);
          // Should not throw
          queue.destroy();
        });
      });
    });
  }
});
