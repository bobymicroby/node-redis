import { strict as assert } from 'node:assert';
import { describe, it, afterEach } from 'mocha';
import RedisCommandsQueue, { type CommandCodec, type TimerFlushCallback } from '../client/commands-queue';
import { BinaryHeadersCodec, BinaryHeadersInboundCodec } from './codec';
import { createTimeoutScheduler, createImmediateScheduler } from './packing';
import { RequestHeaderDecoder } from './generated/request-header-codec';
import { ResponseHeaderEncoder } from './generated/response-header-codec';
import { createBinhdrFrame, parseRespCommands } from './test-utils';
import {
  createBaseQueue,
  createBinhdrQueue,
  createBinhdrQueueWithTimer,
  createPassthroughQueue,
  collectYielded,
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

/**
 * Asserts packed data has correct header AND payload.
 * Verifies header fields and parses RESP payload to check command contents.
 */
function assertPackedData(
  packed: ReadonlyArray<unknown> | null,
  expected: {
    commandCount: number;
    slot?: number;
    commands?: string[][]; // Expected commands, e.g. [['SET', 'key', 'value'], ['GET', 'key']]
  }
): void {
  assert.ok(packed !== null, 'Expected packed data to be non-null');
  assert.ok(packed.length > 1, 'Expected header + payload parts');
  assert.ok(packed[0] instanceof Buffer, 'Expected first element to be header Buffer');

  // Verify header
  const decoder = new RequestHeaderDecoder().wrap(packed[0] as Buffer, 0);
  assert.ok(decoder.isValid(), 'Expected valid header');
  assert.equal(decoder.commandCount(), expected.commandCount, 'commandCount mismatch');

  if (expected.slot !== undefined) {
    assert.equal(decoder.slot(), expected.slot, 'slot mismatch');
  }

  // Verify payload if commands specified
  if (expected.commands !== undefined) {
    // Concatenate all payload parts
    const payloadParts = packed.slice(1);
    const payloadBuffer = Buffer.concat(
      payloadParts.map(p => typeof p === 'string' ? Buffer.from(p) : p as Buffer)
    );

    // Parse RESP commands from payload
    const parsedCommands = parseRespCommands(payloadBuffer);
    assert.equal(parsedCommands.length, expected.commands.length, 'Number of commands mismatch');

    for (let i = 0; i < expected.commands.length; i++) {
      const expectedCmd = expected.commands[i];
      const actualCmd = parsedCommands[i] as unknown[];
      assert.deepEqual(
        actualCmd.map(v => v instanceof Buffer ? v.toString() : v),
        expectedCmd,
        `Command ${i} mismatch`
      );
    }
  }
}

// ============================================================================
// Tests for RedisCommandsQueue with codec support
// ============================================================================

describe('Codec Queue [codec-queue]', function () {
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

    // Timer-based flushing flow:
    //
    // 1. addCommand() adds to the queue's internal #toWrite list
    // 2. commandsToWrite() generator is consumed by the socket layer
    // 3. For each command: transform() may buffer (return null) and schedule timer
    // 4. Socket may stop consuming early (backpressure: writableNeedDrain)
    // 5. If scheduler is configured, generator does NOT drain at end - timer handles it
    // 6. Timer fires after maxWaitMs, calls timerFlushCallback with packed data
    //
    // Key insight: When scheduler is configured, the generator leaves buffered
    // commands for the timer to flush. Without scheduler, drain happens immediately.

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

    it('with scheduler: generator does not drain, leaves commands for timer', function () {
      const queue = createQueueWithTimer(100, false);

      // Add commands with same slot
      queue.addCommand(['SET', 'key', 'value1']);
      queue.addCommand(['GET', 'key']);

      // Consume generator - with scheduler, it should NOT drain at end
      const results = collectYielded(queue);

      // No yields because all commands buffered and not drained
      assert.equal(results.length, 0, 'Generator should not drain when scheduler configured');

      // Commands are still pending in codec buffer
      assert.equal((queue as RedisCommandsQueue).hasPendingOutbound(), true, 'Commands should be pending');
    });

    it('without scheduler: generator drains immediately at end', function () {
      // Create queue WITHOUT timer/scheduler
      const queue = createBinhdrQueue();

      queue.addCommand(['SET', 'key', 'value1']);
      queue.addCommand(['GET', 'key']);

      const results = collectYielded(queue);

      // Should yield because drain happens at end (no scheduler)
      assert.equal(results.length, 1, 'Generator should drain when no scheduler');
      assertPackedData(results[0], {
        commandCount: 2,
        commands: [['SET', 'key', 'value1'], ['GET', 'key']]
      });
    });

    it('timer fires and flushes buffered commands via callback', async function () {
      const queue = createQueueWithTimer(10, false);
      const flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((encoded) => {
        flushedData.push(encoded);
      });

      // Add command and consume generator (yields nothing due to scheduler)
      queue.addCommand(['SET', 'key', 'value']);
      const results = collectYielded(queue);
      assert.equal(results.length, 0, 'Command should be buffered, not yielded');

      // Wait for timer to fire
      await delay(20);

      // Timer should have invoked callback with packed data
      assert.equal(flushedData.length, 1, 'Timer callback should have been called once');
      assertPackedData(flushedData[0], {
        commandCount: 1,
        commands: [['SET', 'key', 'value']]
      });
    });

    it('timer is cancelled when slot incompatibility causes flush', async function () {
      const queue = createQueueWithTimer(50, false);
      let callbackCount = 0;
      queue.setTimerFlushCallback(() => { callbackCount++; });

      // Add first command - buffered, timer scheduled
      queue.addCommand(['SET', 'key1', 'value1']);
      collectYielded(queue);

      // Add second command with different slot - triggers flush via transform()
      queue.addCommand(['SET', 'key2', 'value2']);
      const results = collectYielded(queue);

      // Should yield the first command (flushed due to slot incompatibility)
      assert.equal(results.length, 1, 'Should yield flushed data from slot change');
      assertPackedHeader(results[0], { commandCount: 1 });

      // Wait past the original timer
      await delay(60);

      // Timer should have been cancelled - callback should not be called
      assert.equal(callbackCount, 0, 'Timer callback should not fire after slot-triggered flush');
    });

    it('multiple commands buffered, timer fires with all packed together', async function () {
      const queue = createQueueWithTimer(15, false);
      const flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((encoded) => {
        flushedData.push(encoded);
      });

      // Add multiple commands with same slot (all buffered)
      queue.addCommand(['SET', 'key', 'value1']);
      collectYielded(queue);
      queue.addCommand(['GET', 'key']);
      collectYielded(queue);
      queue.addCommand(['DEL', 'key']);
      collectYielded(queue);

      // Wait for timer
      await delay(25);

      // Should have received one callback with all 3 commands packed
      assert.equal(flushedData.length, 1, 'Should have one callback');
      assertPackedData(flushedData[0], {
        commandCount: 3,
        commands: [['SET', 'key', 'value1'], ['GET', 'key'], ['DEL', 'key']]
      });
    });

    it('destroy during active timer prevents callback', async function () {
      const queue = createQueueWithTimer(30, false);
      let called = false;
      queue.setTimerFlushCallback(() => { called = true; });

      // Add command to start timer
      queue.addCommand(['SET', 'key', 'value']);
      collectYielded(queue);

      // Small delay, then destroy while timer is pending
      await delay(5);
      queue.destroy();

      // Wait past original timer
      await delay(40);

      assert.equal(called, false, 'Callback should not fire after destroy');
    });

    it('uses immediate scheduler for synchronous flush', async function () {
      const queue = createQueueWithTimer(1000, true); // useImmediate = true
      const flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((encoded) => {
        flushedData.push(encoded);
      });

      queue.addCommand(['SET', 'key', 'value']);
      collectYielded(queue);

      // Immediate scheduler fires on next tick, not after 1000ms
      await new Promise(resolve => setImmediate(resolve));

      assert.equal(flushedData.length, 1, 'Immediate scheduler should fire on next tick');
    });

    it('hasPendingOutbound reflects codec buffer state', function () {
      const queue = createQueueWithTimer(100, false) as RedisCommandsQueue;

      assert.equal(queue.hasPendingOutbound(), false, 'No pending before adding');

      // Add command but don't consume generator yet - command is in toWrite, not codec buffer
      queue.addCommand(['SET', 'key', 'value']);
      assert.equal(queue.hasPendingOutbound(), false, 'Nothing in codec until generator runs');

      // Consume generator - command moves to codec buffer
      collectYielded(queue);
      assert.equal(queue.hasPendingOutbound(), true, 'Command now in codec buffer');
    });

    it('drainPendingOutbound manually drains buffered commands', function () {
      const queue = createQueueWithTimer(100, false) as RedisCommandsQueue;

      queue.addCommand(['SET', 'key', 'value']);
      collectYielded(queue); // Moves to codec buffer, not drained due to scheduler

      assert.equal(queue.hasPendingOutbound(), true, 'Command should be pending');

      const drained = queue.drainPendingOutbound();
      assert.ok(drained !== null, 'Should have drained data');
      assertPackedData(drained, {
        commandCount: 1,
        commands: [['SET', 'key', 'value']]
      });

      assert.equal(queue.hasPendingOutbound(), false, 'No longer pending after drain');
    });

    it('slot incompatibility causes flush mid-generator', function () {
      const queue = createQueueWithTimer(100, false);

      // Add commands with different slots
      queue.addCommand(['SET', 'key1', 'value1']); // slot A
      queue.addCommand(['SET', 'key2', 'value2']); // slot B (different)
      queue.addCommand(['SET', 'key1', 'value3']); // slot A again

      const results = collectYielded(queue);

      // Should have yields due to slot changes (transform returns data)
      // Last batch stays buffered (scheduler configured, no drain at end)
      assert.ok(results.length >= 1, 'Slot incompatibility causes yields');
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

  describe('inbound codec chunked data handling', function () {
    const chunkingCases = [
      { name: 'header split at byte 4', splitAt: 4 },
      { name: 'split at header boundary', splitAt: 16 },
      { name: 'payload split mid-stream', splitAt: 20 },
    ];

    for (const { name, splitAt } of chunkingCases) {
      it(`handles ${name}`, async function () {
        const queue = createBinhdrQueue();
        const promise = queue.addCommand<string>(['PING']);
        for (const _ of queue.commandsToWrite()) {}

        const frame = createBinhdrFrame(Buffer.from('+PONG\r\n'));

        queue.processIncomingData(frame.subarray(0, splitAt));
        queue.processIncomingData(frame.subarray(splitAt));

        const result = await promise;
        assert.equal(result, 'PONG');
      });
    }

    it('handles single byte chunks', async function () {
      const queue = createBinhdrQueue();
      const promise = queue.addCommand<string>(['PING']);
      for (const _ of queue.commandsToWrite()) {}

      const frame = createBinhdrFrame(Buffer.from('+PONG\r\n'));

      for (let i = 0; i < frame.length; i++) {
        queue.processIncomingData(frame.subarray(i, i + 1));
      }

      const result = await promise;
      assert.equal(result, 'PONG');
    });

    it('handles multiple complete frames in one chunk', async function () {
      const queue = createBinhdrQueue();
      const promise1 = queue.addCommand<string>(['PING']);
      const promise2 = queue.addCommand<number>(['INCR', 'counter']);
      for (const _ of queue.commandsToWrite()) {}

      const payload1 = Buffer.from('+PONG\r\n');
      const payload2 = Buffer.from(':123\r\n');
      const combined = Buffer.concat([createBinhdrFrame(payload1), createBinhdrFrame(payload2)]);

      queue.processIncomingData(combined);

      const [result1, result2] = await Promise.all([promise1, promise2]);
      assert.equal(result1, 'PONG');
      assert.equal(result2, 123);
    });

    it('handles frame boundary across chunks', async function () {
      const queue = createBinhdrQueue();
      const promise1 = queue.addCommand<string>(['PING']);
      const promise2 = queue.addCommand<number>(['INCR', 'x']);
      for (const _ of queue.commandsToWrite()) {}

      const frame1 = createBinhdrFrame(Buffer.from('+PONG\r\n'));
      const frame2 = createBinhdrFrame(Buffer.from(':456\r\n'));
      const combined = Buffer.concat([frame1, frame2]);
      const splitPoint = frame1.length + 3; // Split in middle of second frame's header

      queue.processIncomingData(combined.subarray(0, splitPoint));
      queue.processIncomingData(combined.subarray(splitPoint));

      const [result1, result2] = await Promise.all([promise1, promise2]);
      assert.equal(result1, 'PONG');
      assert.equal(result2, 456);
    });

    it('handles empty payload frame', async function () {
      const queue = createBinhdrQueue();
      const promise = queue.addCommand<null>(['PING']);
      for (const _ of queue.commandsToWrite()) {}

      // Create frame with empty payload followed by actual response
      const emptyFrame = ResponseHeaderEncoder.allocateAndEncode(0, 1, false, 0);
      const responseFrame = createBinhdrFrame(Buffer.from('$-1\r\n')); // null bulk string

      queue.processIncomingData(Buffer.concat([emptyFrame, responseFrame]));

      const result = await promise;
      assert.equal(result, null);
    });

    it('handles large payload', async function () {
      const queue = createBinhdrQueue();
      const promise = queue.addCommand<Buffer>(['GET', 'bigkey']);
      for (const _ of queue.commandsToWrite()) {}

      const largeData = Buffer.alloc(10000, 'x');
      const respPayload = Buffer.from(`$${largeData.length}\r\n${largeData.toString()}\r\n`);
      const frame = createBinhdrFrame(respPayload);

      queue.processIncomingData(frame);

      const result = await promise;
      assert.equal(result.length, 10000);
    });

    it('switches from binary header frame to regular RESP passthrough', async function () {
      // This tests when non-binhdr data comes through (passthrough behavior)
      const queue = createBaseQueue(); // No codec - baseline
      const promise = queue.addCommand<number>(['INCR', 'x']);
      for (const _ of queue.commandsToWrite()) {}

      // Regular RESP (not binary header wrapped)
      queue.processIncomingData(Buffer.from(':999\r\n'));

      const result = await promise;
      assert.equal(result, 999);
    });
  });

  describe('inbound codec callbacks', function () {
    it('calls onProtocolError when flag is set', async function () {
      const errors: number[] = [];
      const codec = new BinaryHeadersCodec({
        outbound: { resolver: STATIC_RESOLVER },
        inbound: { onProtocolError: (requestId) => errors.push(requestId) }
      });
      const queue = new RedisCommandsQueue(2, null, () => {}, codec);

      const promise = queue.addCommand<string>(['PING']);
      for (const _ of queue.commandsToWrite()) {}

      // Frame with protocolError flag set
      queue.processIncomingData(createBinhdrFrame(Buffer.from('+OK\r\n'), 1, 99, true));

      await promise;
      assert.equal(errors.length, 1);
      assert.equal(errors[0], 99);
    });

    it('does not call onProtocolError when flag is not set', async function () {
      let called = false;
      const codec = new BinaryHeadersCodec({
        outbound: { resolver: STATIC_RESOLVER },
        inbound: { onProtocolError: () => { called = true; } }
      });
      const queue = new RedisCommandsQueue(2, null, () => {}, codec);

      const promise = queue.addCommand<string>(['PING']);
      for (const _ of queue.commandsToWrite()) {}

      queue.processIncomingData(createBinhdrFrame(Buffer.from('+PONG\r\n')));

      await promise;
      assert.equal(called, false);
    });
  });

  describe('inbound codec state isolation', function () {
    it('maintains separate state per queue instance', async function () {
      const queue1 = createBinhdrQueue();
      const queue2 = createBinhdrQueue();

      const promise1 = queue1.addCommand<string>(['PING']);
      const promise2 = queue2.addCommand<string>(['PING']);
      for (const _ of queue1.commandsToWrite()) {}
      for (const _ of queue2.commandsToWrite()) {}

      const frame = createBinhdrFrame(Buffer.from('+PONG\r\n'));

      // Send partial to queue1
      queue1.processIncomingData(frame.subarray(0, 4));

      // Send complete to queue2
      queue2.processIncomingData(frame);
      const result2 = await promise2;
      assert.equal(result2, 'PONG');

      // Complete queue1
      queue1.processIncomingData(frame.subarray(4));
      const result1 = await promise1;
      assert.equal(result1, 'PONG');
    });
  });
});

// ============================================================================
// Tests specific to CodecQueue interface (not swappable)
// These test the codec interface itself, independent of implementation
// ============================================================================

describe('Codec Queue Interface (CodecQueue specific)', function () {
  describe('without codec (baseline behavior)', function () {
    function createQueue(): RedisCommandsQueue {
      return new RedisCommandsQueue(2, null, () => {});
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
    function createQueueWithCodec(): RedisCommandsQueue {
      const codec = new BinaryHeadersCodec({
        outbound: { resolver: STATIC_RESOLVER }
      });
      return new RedisCommandsQueue(2, null, () => {}, codec);
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

      const queue = new RedisCommandsQueue(2, null, () => {}, mockCodec);
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

      const queue = new RedisCommandsQueue(2, null, () => {}, mockCodec);
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

      const queue = new RedisCommandsQueue(2, null, () => {}, mockCodec);
      queue.addCommand(['PING']);
      for (const _ of queue.commandsToWrite()) {}

      const testChunk = Buffer.from('+OK\r\n');
      queue.processIncomingData(testChunk);

      assert.deepEqual(receivedChunk, testChunk);
      assert.ok(receivedDecoder !== null);
    });
  });
});
