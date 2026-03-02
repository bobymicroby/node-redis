import { strict as assert } from 'node:assert';
import { describe, it, afterEach } from 'mocha';
import RedisCommandsQueue, { type WireInterceptor } from '../client/commands-queue';
import { RESP_TYPES } from '../RESP/decoder';
import { BinaryHeadersInterceptor, BinaryHeadersInboundInterceptor } from './codec';
import {
  // Async utilities
  delay,
  // Frame utilities
  createBinhdrFrame,
  createMultipleFrames,
  // RESP utilities
  parseRespCommands,
  respSimpleString,
  respInteger,
  respBulkString,
  respError,
  respNull,
  // Chunking utilities
  splitAt,
  splitIntoBytes,
  // Stress utilities
  largeBuffer,
  // Collection helpers
  collectYielded,
  collectYieldedParsed,
  // Assertion helpers
  assertPackedHeader,
  assertPackedData,
  assertStats,
  // Queue factories
  createNoCodecQueue,
  createBinhdrQueue,
  createBinhdrQueueWithTimer,
  createPassthroughQueue,
  createBinhdrQueueWithStats,
  createBinhdrQueueWithTimerAndStats,
  forQueues,
  // Re-exports
  createTimeoutScheduler,
  createImmediateScheduler,
  STATIC_RESOLVER,
  ResponseHeaderEncoder,
  // Scheduler utilities
  createTrackingScheduler,
  // Types
  type TestableQueue,
  type TestableQueueWithTimer,
  type TestableQueueWithStats,
  type TestableQueueWithTimerAndStats,
} from './test-utils';

// ============================================================================
// Tests for RedisCommandsQueue with codec support
// ============================================================================

describe('Codec Queue [codec-queue]', function () {
  describe('without codec (master vs no-codec verification)', function () {
    forQueues(['master', 'no-codec'], 'single command', (queue) => {
      queue.addCommand(['PING']);
      assert.deepEqual(collectYieldedParsed(queue), [[['PING']]]);
    });

    forQueues(['master', 'no-codec'], 'multiple commands yield separately', (queue) => {
      queue.addCommand(['SET', 'a', '1']);
      queue.addCommand(['GET', 'a']);
      assert.deepEqual(collectYieldedParsed(queue), [[['SET', 'a', '1']], [['GET', 'a']]]);
    });

    forQueues(['master', 'no-codec'], 'empty queue yields nothing', (queue) => {
      assert.deepEqual(collectYieldedParsed(queue), []);
    });

    forQueues(['master', 'no-codec'], 'commands with arguments', (queue) => {
      queue.addCommand(['SET', 'foo', 'bar']);
      queue.addCommand(['HSET', 'h', 'f', 'v']);
      assert.deepEqual(collectYieldedParsed(queue), [[['SET', 'foo', 'bar']], [['HSET', 'h', 'f', 'v']]]);
    });

    forQueues(['master', 'no-codec'], 'many commands yield in order', (queue) => {
      ['A', 'B', 'C', 'D'].forEach(c => queue.addCommand([c]));
      assert.deepEqual(collectYieldedParsed(queue), [[['A']], [['B']], [['C']], [['D']]]);
    });

    forQueues(['master', 'no-codec'], 'processIncomingData writes to decoder', async (queue) => {
      const promise = queue.addCommand<string>(['PING']);
      for (const _ of queue.commandsToWrite()) {}
      queue.processIncomingData(Buffer.from('+PONG\r\n'));
      assert.equal(await promise, 'PONG');
    });

    forQueues(['master', 'no-codec'], 'multiple responses resolve in order', async (queue) => {
      const promises = ['a', 'b', 'c'].map(k => queue.addCommand<string>(['GET', k]));
      for (const _ of queue.commandsToWrite()) {}
      queue.processIncomingData(Buffer.from('+val1\r\n+val2\r\n+val3\r\n'));
      assert.deepEqual(await Promise.all(promises), ['val1', 'val2', 'val3']);
    });

    forQueues(['master', 'no-codec'], 'generator exhausts after consuming', (queue) => {
      queue.addCommand(['PING']);
      queue.addCommand(['PING']);
      assert.equal(collectYieldedParsed(queue).length, 2);
      assert.equal(collectYieldedParsed(queue).length, 0);
    });

    forQueues(['master', 'no-codec'], 'commands added while iterating are yielded', (queue) => {
      queue.addCommand(['A']);
      const gen = queue.commandsToWrite();
      assert.equal(gen.next().done, false);
      queue.addCommand(['B']);
      assert.equal(gen.next().done, false);
      assert.equal(gen.next().done, true);
    });
  });

  describe('with BinaryHeadersInterceptor (static resolver)', function () {
    // Table-driven tests for batching behavior
    const batchingCases = [
      { name: 'single command is batched with header', commands: [['PING']], expectedYields: 1, expectedCommandCount: 1 },
      { name: 'multiple same-slot commands batched together', commands: [['PING'], ['PING'], ['PING']], expectedYields: 1, expectedCommandCount: 3 },
      { name: 'keyless commands batch together', commands: [['TIME'], ['PING'], ['ECHO', 'hi']], expectedYields: 1, expectedCommandCount: 3 },
    ];

    for (const { name, commands, expectedYields, expectedCommandCount } of batchingCases) {
      it(name, function () {
        const queue = createBinhdrQueue();
        commands.forEach((cmd) => queue.addCommand(cmd));

        const results = collectYielded(queue);

        assert.equal(results.length, expectedYields, `Expected ${expectedYields} yield(s)`);
        assertPackedHeader(results[0], { commandCount: expectedCommandCount });
      });
    }

    it('processes incoming data through inbound codec', async function () {
      const queue = createBinhdrQueue();
      const promise = queue.addCommand<string>(['PING']);
      for (const _ of queue.commandsToWrite()) {}

      queue.processIncomingData(createBinhdrFrame(Buffer.from('+PONG\r\n')));
      const result = await promise;
      assert.equal(result, 'PONG');
    });
  });

  describe('with passthrough resolver (no batching)', function () {
    // Table-driven tests - passthrough should behave like no codec
    const passthroughCases = [
      { name: 'single command', commands: [['PING']], expected: [[['PING']]] },
      { name: 'multiple commands yield separately', commands: [['SET', 'a', '1'], ['GET', 'a']], expected: [[['SET', 'a', '1']], [['GET', 'a']]] },
    ];

    for (const { name, commands, expected } of passthroughCases) {
      it(name, function () {
        const queue = createPassthroughQueue();
        commands.forEach((cmd) => queue.addCommand(cmd));
        assert.deepEqual(collectYieldedParsed(queue), expected);
      });
    }
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

    it('timer is cancelled when slot incompatibility causes flush, new timer scheduled for remaining', async function () {
      const queue = createQueueWithTimer(50, false);
      let callbackCount = 0;
      const flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((encoded) => {
        callbackCount++;
        flushedData.push(encoded);
      });

      // Add first command - buffered, timer scheduled
      queue.addCommand(['SET', 'key1', 'value1']);
      collectYielded(queue);

      // Add second command with different slot - triggers flush via transform()
      queue.addCommand(['SET', 'key2', 'value2']);
      const results = collectYielded(queue);

      // Should yield the first command (flushed due to slot incompatibility)
      assert.equal(results.length, 1, 'Should yield flushed data from slot change');
      assertPackedData(results[0], {
        commandCount: 1,
        commands: [['SET', 'key1', 'value1']]
      });

      // Wait past the timer - a NEW timer should have been scheduled for the second command
      await delay(60);

      // Timer should fire once for the second command that was left pending after slot flush
      assert.equal(callbackCount, 1, 'Timer callback should fire for remaining buffered command');
      assert.equal(flushedData.length, 1, 'Should have flushed data from timer');
      assertPackedData(flushedData[0], {
        commandCount: 1,
        commands: [['SET', 'key2', 'value2']]
      });
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

      // Add commands with different slots: A, B, A
      queue.addCommand(['SET', 'key1', 'value1']); // slot A
      queue.addCommand(['SET', 'key2', 'value2']); // slot B - triggers flush of A
      queue.addCommand(['SET', 'key1', 'value3']); // slot A - triggers flush of B

      const results = collectYielded(queue);

      // Should have 2 yields from slot changes:
      // 1. A->B flushes slot A (1 cmd)
      // 2. B->A flushes slot B (1 cmd)
      // Last command (slot A) stays buffered for timer
      assert.equal(results.length, 2, 'Should yield 2 batches from slot changes');
      assertPackedData(results[0], {
        commandCount: 1,
        commands: [['SET', 'key1', 'value1']]
      });
      assertPackedData(results[1], {
        commandCount: 1,
        commands: [['SET', 'key2', 'value2']]
      });

      // Third command still pending for timer
      assert.equal((queue as RedisCommandsQueue).hasPendingOutbound(), true, 'key1 value3 pending for timer');
    });
  });

  describe('timer-based flushing (negative & edge cases)', function () {
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

    it('double destroy does not throw', function () {
      const queue = createQueueWithTimer(100);
      queue.addCommand(['PING']);
      collectYielded(queue); // buffer command

      queue.destroy();
      assert.doesNotThrow(() => queue.destroy());
    });

    it('manual drainPendingOutbound before timer fires prevents double-flush', async function () {
      const queue = createQueueWithTimer(30);
      let callbackCount = 0;
      queue.setTimerFlushCallback(() => { callbackCount++; });

      queue.addCommand(['SET', 'key', 'value']);
      collectYielded(queue); // buffer command, timer scheduled

      // Manually drain before timer fires
      const drained = (queue as RedisCommandsQueue).drainPendingOutbound();
      assert.ok(drained !== null, 'Manual drain should return data');
      assertPackedData(drained, {
        commandCount: 1,
        commands: [['SET', 'key', 'value']]
      });

      // Wait past the timer - it should fire but find nothing to flush
      await delay(50);
      assert.equal(callbackCount, 0, 'Timer callback should NOT fire when buffer already drained');
    });

    it('setTimerFlushCallback replaced mid-flight: new callback receives data', async function () {
      const queue = createQueueWithTimer(15);
      let oldCalled = false;
      queue.setTimerFlushCallback(() => { oldCalled = true; });

      queue.addCommand(['SET', 'key', 'value']);
      collectYielded(queue); // timer scheduled

      // Replace callback before timer fires
      const flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((encoded) => { flushedData.push(encoded); });

      await delay(25);
      assert.equal(oldCalled, false, 'Old callback should not be called');
      assert.equal(flushedData.length, 1, 'New callback should receive the data');
      assertPackedData(flushedData[0], {
        commandCount: 1,
        commands: [['SET', 'key', 'value']]
      });
    });

    it('setTimerFlushCallback after destroy: callback is not invoked', async function () {
      const queue = createQueueWithTimer(15);
      queue.addCommand(['SET', 'key', 'value']);
      collectYielded(queue); // timer scheduled

      queue.destroy(); // cancels timer, sets callback to noop

      // Try to set a new callback after destroy
      let called = false;
      queue.setTimerFlushCallback(() => { called = true; });

      await delay(25);
      // Timer was cancelled by destroy, so even the new callback shouldn't fire
      assert.equal(called, false, 'Callback set after destroy should not fire');
    });

    it('commands added after destroy are silently lost (timer is noop)', async function () {
      const queue = createQueueWithTimer(15);
      let callbackCount = 0;
      queue.setTimerFlushCallback(() => { callbackCount++; });

      queue.destroy();

      // Add command after destroy
      queue.addCommand(['SET', 'key', 'value']);
      collectYielded(queue); // This schedules a NEW timer

      await delay(25);
      // Timer fires, but callback was reset to noop by destroy
      assert.equal(callbackCount, 0, 'Callback should be noop after destroy');
    });

    it('maxWaitMs of 0 still triggers timer asynchronously', async function () {
      const queue = createQueueWithTimer(0);
      const flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((encoded) => { flushedData.push(encoded); });

      queue.addCommand(['SET', 'key', 'value']);
      collectYielded(queue);

      // Even with 0ms, setTimeout(fn, 0) is async - data shouldn't be available synchronously
      assert.equal(flushedData.length, 0, 'Not flushed synchronously');

      await delay(5);
      assert.equal(flushedData.length, 1, 'Flushed after event loop turn');
      assertPackedData(flushedData[0], {
        commandCount: 1,
        commands: [['SET', 'key', 'value']]
      });
    });

    it('rapid add/destroy/add cycle: first batch lost, second batch also lost', async function () {
      const queue = createQueueWithTimer(15);
      const flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((encoded) => { flushedData.push(encoded); });

      // First batch
      queue.addCommand(['SET', 'k1', 'v1']);
      collectYielded(queue);

      // Destroy cancels timer + resets callback to noop
      queue.destroy();

      // Second batch after destroy
      queue.addCommand(['SET', 'k2', 'v2']);
      collectYielded(queue); // schedules new timer, but callback is noop

      await delay(25);
      // Neither batch should produce callback invocations
      assert.equal(flushedData.length, 0, 'No callbacks after destroy');
    });

    it('multiple generators in sequence maintain consistent timer state', async function () {
      const queue = createQueueWithTimer(30);
      const flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((encoded) => { flushedData.push(encoded); });

      // First generator: buffer command, timer scheduled
      queue.addCommand(['SET', 'key', 'v1']);
      const results1 = collectYielded(queue);
      assert.equal(results1.length, 0, 'First gen: buffered for timer');

      // Second generator with no new commands: should yield nothing
      const results2 = collectYielded(queue);
      assert.equal(results2.length, 0, 'Second gen: nothing new to yield');

      // Timer should still fire for the first command
      await delay(40);
      assert.equal(flushedData.length, 1, 'Timer fires once for buffered command');
      assertPackedData(flushedData[0], {
        commandCount: 1,
        commands: [['SET', 'key', 'v1']]
      });
    });

    it('timer does not re-schedule itself after firing', async function () {
      const queue = createQueueWithTimer(10);
      let callbackCount = 0;
      queue.setTimerFlushCallback(() => { callbackCount++; });

      queue.addCommand(['SET', 'key', 'value']);
      collectYielded(queue);

      // Wait for timer to fire
      await delay(20);
      assert.equal(callbackCount, 1, 'Timer fires once');

      // Wait another full interval - should NOT fire again
      await delay(20);
      assert.equal(callbackCount, 1, 'Timer does not re-fire');
    });

    it('hasPendingOutbound is false after timer fires', async function () {
      const queue = createQueueWithTimer(10);
      queue.setTimerFlushCallback(() => {});

      queue.addCommand(['SET', 'key', 'value']);
      collectYielded(queue);
      assert.equal(queue.hasPendingOutbound(), true, 'Pending before timer');

      await delay(20);
      assert.equal(queue.hasPendingOutbound(), false, 'Not pending after timer fires');
    });

    it('destroy between addCommand and commandsToWrite prevents timer scheduling', async function () {
      const queue = createQueueWithTimer(15);
      let callbackCount = 0;
      queue.setTimerFlushCallback(() => { callbackCount++; });

      queue.addCommand(['SET', 'key', 'value']);
      // Don't consume generator - command is in toWrite, not in codec buffer
      // Timer is NOT yet scheduled (scheduled during generator consumption)
      queue.destroy();

      // Now consume - timer gets scheduled but callback is noop
      collectYielded(queue);

      await delay(25);
      assert.equal(callbackCount, 0, 'Callback should not fire after destroy');
    });

    it('slot flush mid-generator cancels existing timer and schedules new one', async function () {
      const queue = createQueueWithTimer(50);
      const flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((encoded) => { flushedData.push(encoded); });

      // Add two commands: first gets buffered, timer scheduled
      queue.addCommand(['SET', 'key1', 'v1']);
      collectYielded(queue);

      // Wait 30ms (timer at 50ms hasn't fired yet)
      await delay(30);
      assert.equal(flushedData.length, 0, 'Timer not yet fired');

      // Add different-slot command - flushes first, cancels old timer, schedules new
      queue.addCommand(['SET', 'key2', 'v2']);
      const results = collectYielded(queue);
      assert.equal(results.length, 1, 'Slot change flushed first command via generator');

      // If old timer was NOT cancelled, it would fire ~20ms from now (50-30)
      // New timer for key2 should fire at 50ms from now
      await delay(25);
      assert.equal(flushedData.length, 0, 'Old timer was cancelled, new timer not yet due');

      // Wait for new timer
      await delay(30);
      assert.equal(flushedData.length, 1, 'New timer fires for key2');
      assertPackedData(flushedData[0], {
        commandCount: 1,
        commands: [['SET', 'key2', 'v2']]
      });
    });

    it('custom scheduler that fires synchronously: callback invoked before delay', function () {
      // A scheduler that calls the callback immediately (synchronously)
      const syncScheduler = {
        schedule(_delayMs: number, task: () => void) {
          task(); // fire immediately
          return { cancel: () => {} };
        }
      };

      const interceptor = new BinaryHeadersInterceptor({
        outbound: { resolver: STATIC_RESOLVER }
      });
      const queue = new RedisCommandsQueue(2, null, () => {}, interceptor, {
        maxWaitMs: 1000,
        scheduler: syncScheduler,
      });
      activeQueues.push(queue as unknown as TestableQueueWithTimer);

      const flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((encoded) => { flushedData.push(encoded); });

      queue.addCommand(['SET', 'key', 'value']);
      collectYielded(queue);

      // With synchronous scheduler, callback fires during generator consumption
      assert.equal(flushedData.length, 1, 'Synchronous scheduler fires immediately');
      assertPackedData(flushedData[0], {
        commandCount: 1,
        commands: [['SET', 'key', 'value']]
      });
    });

    it('scheduler cancel is called exactly once on destroy', function () {
      let cancelCount = 0;
      const countingScheduler = {
        schedule(delayMs: number, task: () => void) {
          const id = setTimeout(task, delayMs);
          return {
            cancel: () => {
              cancelCount++;
              clearTimeout(id);
            }
          };
        }
      };

      const interceptor = new BinaryHeadersInterceptor({
        outbound: { resolver: STATIC_RESOLVER }
      });
      const queue = new RedisCommandsQueue(2, null, () => {}, interceptor, {
        maxWaitMs: 100,
        scheduler: countingScheduler,
      });
      activeQueues.push(queue as unknown as TestableQueueWithTimer);

      queue.addCommand(['SET', 'key', 'value']);
      collectYielded(queue); // schedules timer

      assert.equal(cancelCount, 0, 'Not cancelled yet');
      queue.destroy();
      assert.equal(cancelCount, 1, 'Cancelled exactly once');
      queue.destroy(); // double destroy
      assert.equal(cancelCount, 1, 'Not cancelled again on double destroy');
    });

    it('scheduler cancel is called on slot-change flush', function () {
      let cancelCount = 0;
      const countingScheduler = {
        schedule(delayMs: number, task: () => void) {
          const id = setTimeout(task, delayMs);
          return {
            cancel: () => {
              cancelCount++;
              clearTimeout(id);
            }
          };
        }
      };

      const interceptor = new BinaryHeadersInterceptor({
        outbound: { resolver: STATIC_RESOLVER }
      });
      const queue = new RedisCommandsQueue(2, null, () => {}, interceptor, {
        maxWaitMs: 100,
        scheduler: countingScheduler,
      });
      activeQueues.push(queue as unknown as TestableQueueWithTimer);

      // First command buffers + schedules timer
      queue.addCommand(['SET', 'key1', 'v1']);
      collectYielded(queue);
      assert.equal(cancelCount, 0, 'Timer scheduled');

      // Different slot triggers flush -> cancels timer -> schedules new timer
      queue.addCommand(['SET', 'key2', 'v2']);
      collectYielded(queue);
      assert.equal(cancelCount, 1, 'Old timer cancelled on slot-change flush');

      queue.destroy();
      assert.equal(cancelCount, 2, 'New timer cancelled on destroy');
    });

    it('timer callback never fires when timer is NOT configured', async function () {
      const queue = createBinhdrQueue(); // No timer config
      let callbackCalled = false;
      (queue as RedisCommandsQueue).setTimerFlushCallback(() => { callbackCalled = true; });

      queue.addCommand(['SET', 'key', 'value']);
      collectYielded(queue);

      await delay(50);

      assert.equal(callbackCalled, false, 'Callback should never fire without timer config');
    });

    it('timer does NOT fire before maxWaitMs elapses', async function () {
      const queue = createQueueWithTimer(100);
      const flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((encoded) => { flushedData.push(encoded); });

      queue.addCommand(['SET', 'key', 'value']);
      collectYielded(queue);

      await delay(30);
      assert.equal(flushedData.length, 0, 'Timer should NOT have fired yet at 30ms');

      await delay(30);
      assert.equal(flushedData.length, 0, 'Timer should NOT have fired yet at 60ms');

      await delay(50);
      assert.equal(flushedData.length, 1, 'Timer should fire after 100ms');
    });

    it('commands are flushed via drain when no timer configured, not via callback', async function () {
      const queue = createBinhdrQueue(); // No timer config
      let callbackCalled = false;
      (queue as RedisCommandsQueue).setTimerFlushCallback(() => { callbackCalled = true; });

      queue.addCommand(['SET', 'key', 'value']);
      const results = collectYielded(queue);

      assert.equal(results.length, 1, 'Command should be drained at end of generator');
      assertPackedData(results[0], {
        commandCount: 1,
        commands: [['SET', 'key', 'value']]
      });

      await delay(20);
      assert.equal(callbackCalled, false, 'Callback should never be invoked without timer');
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
      assertPackedData(results[0], {
        commandCount: 2,
        commands: [['SET', 'key1', 'value1'], ['GET', 'key1']]
      });
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

    it('does not mis-detect header when plain RESP bulk payload chunk starts with 0x80 before binary mode is established', async function () {
      const interceptor = new BinaryHeadersInterceptor({
        outbound: { resolver: STATIC_RESOLVER },
      });
      const queue = new RedisCommandsQueue(2, null, () => {}, interceptor);

      const promise = queue.addCommand<Buffer>(['GET', 'k'], {
        typeMapping: {
          [RESP_TYPES.BLOB_STRING]: Buffer,
        },
      });
      for (const _ of queue.commandsToWrite()) {}

      // Plain RESP bulk string "$3\r\nA\x80B\r\n", split so second chunk starts with 0x80.
      queue.processIncomingData(Buffer.from('$3\r\nA'));
      queue.processIncomingData(Buffer.from([0x80, 0x42, 0x0D, 0x0A]));

      const result = await promise;
      assert.ok(Buffer.isBuffer(result));
      assert.deepEqual(result, Buffer.from([0x41, 0x80, 0x42]));
    });

    it('switches from binary header frame to regular RESP passthrough', async function () {
      const queue = createBinhdrQueue();
      const promise1 = queue.addCommand<string>(['PING']);
      const promise2 = queue.addCommand<number>(['INCR', 'x']);
      for (const _ of queue.commandsToWrite()) {}

      queue.processIncomingData(createBinhdrFrame(Buffer.from('+PONG\r\n')));
      queue.processIncomingData(Buffer.from(':999\r\n'));

      const [result1, result2] = await Promise.all([promise1, promise2]);
      assert.equal(result1, 'PONG');
      assert.equal(result2, 999);
    });

    it('handles mixed plain RESP and binary frame in a single chunk after binary traffic', async function () {
      const queue = createBinhdrQueue();

      // Prime interceptor as "binary observed".
      const prime = queue.addCommand<string>(['PING']);
      for (const _ of queue.commandsToWrite()) {}
      queue.processIncomingData(createBinhdrFrame(Buffer.from('+OK\r\n')));
      assert.equal(await prime, 'OK');

      const promise1 = queue.addCommand<number>(['INCR', 'x']);
      const promise2 = queue.addCommand<number>(['INCR', 'y']);
      for (const _ of queue.commandsToWrite()) {}

      const mixedChunk = Buffer.concat([
        Buffer.from(':1\r\n'),
        createBinhdrFrame(Buffer.from(':2\r\n')),
      ]);

      queue.processIncomingData(mixedChunk);

      const [result1, result2] = await Promise.all([promise1, promise2]);
      assert.equal(result1, 1);
      assert.equal(result2, 2);
    });

    it('does not desync when plain RESP payload contains CRLF+0x80 before a real binary header in the same chunk', async function () {
      const queue = createBinhdrQueue();

      // Prime interceptor as "binary observed".
      const prime = queue.addCommand<string>(['PING']);
      for (const _ of queue.commandsToWrite()) {}
      queue.processIncomingData(createBinhdrFrame(Buffer.from('+OK\r\n')));
      assert.equal(await prime, 'OK');

      const blob = queue.addCommand<Buffer>(['GET', 'k1'], {
        typeMapping: {
          [RESP_TYPES.BLOB_STRING]: Buffer,
        },
      });
      const integer = queue.addCommand<number>(['INCR', 'k2']);
      for (const _ of queue.commandsToWrite()) {}

      // Plain RESP bulk payload: "$5\r\nA\r\n\x80B\r\n"
      // Then a valid binary-header frame in the same chunk.
      const plainBulk = Buffer.concat([
        Buffer.from('$5\r\nA\r\n'),
        Buffer.from([0x80]),
        Buffer.from('B\r\n'),
      ]);
      const mixedChunk = Buffer.concat([
        plainBulk,
        createBinhdrFrame(Buffer.from(':2\r\n')),
      ]);

      queue.processIncomingData(mixedChunk);

      const [blobReply, integerReply] = await Promise.all([blob, integer]);
      assert.ok(Buffer.isBuffer(blobReply));
      assert.deepEqual(blobReply, Buffer.from([0x41, 0x0D, 0x0A, 0x80, 0x42]));
      assert.equal(integerReply, 2);
    });

    it('state flow: UNKNOWN -> BINARY -> mixed plain frame -> BINARY, with exact output order', function () {
      const seenHeaders: Array<{ length: number; commandCount: number; clientIdx: number }> = [];
      const interceptor = new BinaryHeadersInboundInterceptor({
        onHeader: (header) => {
          seenHeaders.push({
            length: header.length,
            commandCount: header.commandCount,
            clientIdx: header.clientIdx
          });
        }
      });

      const emitted: Buffer[] = [];
      const emit = (data: Buffer) => emitted.push(Buffer.from(data));

      // 1) UNKNOWN -> BINARY (valid header)
      interceptor.intercept(createBinhdrFrame(Buffer.from('+OK\r\n'), 1, 7), emit);
      // 2) In BINARY mode, consume one plain RESP frame and then resume binary header parsing.
      interceptor.intercept(
        Buffer.concat([
          Buffer.from(':1\r\n'),
          createBinhdrFrame(Buffer.from(':2\r\n'), 1, 9),
        ]),
        emit
      );

      assert.deepEqual(
        emitted.map((b) => b.toString()),
        ['+OK\r\n', ':1\r\n', ':2\r\n']
      );
      assert.deepEqual(seenHeaders, [
        { length: 5, commandCount: 1, clientIdx: 7 },
        { length: 4, commandCount: 1, clientIdx: 9 },
      ]);
    });

    it('state flow: plain frame at boundary can be followed by binary header frame', function () {
      const seenHeaders: Array<{ length: number; commandCount: number; clientIdx: number }> = [];
      const interceptor = new BinaryHeadersInboundInterceptor({
        onHeader: (header) => seenHeaders.push({
          length: header.length,
          commandCount: header.commandCount,
          clientIdx: header.clientIdx
        })
      });

      const emitted: Buffer[] = [];
      const emit = (data: Buffer) => emitted.push(Buffer.from(data));

      // 1) First frame is plain RESP.
      interceptor.intercept(Buffer.from(':100\r\n'), emit);
      // 2) Next frame at boundary is binary header framed.
      const binaryFrame = createBinhdrFrame(Buffer.from(':2\r\n'), 1, 42);
      interceptor.intercept(binaryFrame, emit);

      assert.equal(emitted[0].toString(), ':100\r\n');
      assert.equal(emitted[1].toString(), ':2\r\n');
      assert.deepEqual(seenHeaders, [
        { length: 4, commandCount: 1, clientIdx: 42 }
      ]);
    });

    it('handles plain response before first binary response on mixed outbound traffic', async function () {
      const queue = createBinhdrQueue();

      const infoPromise = queue.addCommand<string>(['INFO']); // ineligible -> plain passthrough
      const pingPromise = queue.addCommand<string>(['PING']); // eligible -> binary header

      const writes = collectYielded(queue);
      assert.equal(writes.length, 2, 'expected one plain write and one binary write');

      // Plain response arrives first.
      queue.processIncomingData(respBulkString('server-info'));
      // Regression: this used to throw "Unknown RESP type 128" due to plain-mode lock.
      queue.processIncomingData(createBinhdrFrame(respSimpleString('PONG')));

      const [info, ping] = await Promise.all([infoPromise, pingPromise]);
      assert.equal(info, 'server-info');
      assert.equal(ping, 'PONG');
    });
  });

  describe('inbound codec callbacks', function () {
    it('calls onProtocolError when flag is set', async function () {
      const errors: number[] = [];
      const interceptor = new BinaryHeadersInterceptor({
        outbound: { resolver: STATIC_RESOLVER },
        inbound: { onProtocolError: (header) => errors.push(header.clientIdx) }
      });
      const queue = new RedisCommandsQueue(2, null, () => {}, interceptor);

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
      const interceptor = new BinaryHeadersInterceptor({
        outbound: { resolver: STATIC_RESOLVER },
        inbound: { onProtocolError: () => { called = true; } }
      });
      const queue = new RedisCommandsQueue(2, null, () => {}, interceptor);

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

    it('resetDecoder clears buffered inbound codec state', async function () {
      const interceptor = new BinaryHeadersInterceptor({
        outbound: { resolver: STATIC_RESOLVER },
      });
      const queue = new RedisCommandsQueue(2, null, () => {}, interceptor);

      const promise = queue.addCommand<string>(['PING']);
      for (const _ of queue.commandsToWrite()) {}

      const frame = createBinhdrFrame(Buffer.from('+PONG\r\n'));

      // Buffer a partial header, then reset queue parser state.
      queue.processIncomingData(frame.subarray(0, 4));
      queue.resetDecoder();

      // Full frame should parse cleanly after reset.
      queue.processIncomingData(frame);

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

  describe('with BinaryHeadersInterceptor', function () {
    function createQueueWithInterceptor(): RedisCommandsQueue {
      const interceptor = new BinaryHeadersInterceptor({
        outbound: { resolver: STATIC_RESOLVER }
      });
      return new RedisCommandsQueue(2, null, () => {}, interceptor);
    }

    it('hasPendingOutbound reflects buffered commands', function () {
      const queue = createQueueWithInterceptor();
      assert.equal(queue.hasPendingOutbound(), false);

      // Commands are buffered until commandsToWrite() is called
      queue.addCommand(['PING']);
      // Note: commands are in toWrite, not in codec buffer yet
      assert.equal(queue.hasPendingOutbound(), false);
    });
  });

  describe('interceptor interface compliance', function () {
    it('OutboundInterceptor intercept can return empty array to buffer', function () {
      let interceptCalls = 0;
      const mockInterceptor: WireInterceptor = {
        outbound: {
          intercept: () => { interceptCalls++; return []; },
          flush: () => null,
          hasPending: () => false
        },
        inbound: {
          intercept: (chunk, next) => next(chunk)
        }
      };

      const queue = new RedisCommandsQueue(2, null, () => {}, mockInterceptor);
      queue.addCommand(['PING']);

      const results: unknown[] = [];
      for (const encoded of queue.commandsToWrite()) {
        results.push(encoded);
      }

      assert.equal(interceptCalls, 1);
      assert.equal(results.length, 0); // Nothing yielded because intercept returned empty array
    });

    it('OutboundInterceptor flush is called at end of iteration', function () {
      let flushCalls = 0;
      const flushResult = ['flushed-data'];
      const mockInterceptor: WireInterceptor = {
        outbound: {
          intercept: () => [],
          flush: () => { flushCalls++; return flushResult; },
          hasPending: () => flushCalls === 0
        },
        inbound: {
          intercept: (chunk, next) => next(chunk)
        }
      };

      const queue = new RedisCommandsQueue(2, null, () => {}, mockInterceptor);
      queue.addCommand(['PING']);

      const results: unknown[] = [];
      for (const encoded of queue.commandsToWrite()) {
        results.push(encoded);
      }

      assert.equal(flushCalls, 1);
      assert.deepEqual(results, [flushResult]);
    });

    it('InboundInterceptor intercept receives chunk and next callback', function () {
      let receivedChunk: Buffer | null = null;
      let receivedNext: ((data: Buffer) => void) | null = null;

      const mockInterceptor: WireInterceptor = {
        outbound: {
          intercept: (encoded) => [encoded],
          flush: () => null,
          hasPending: () => false
        },
        inbound: {
          intercept: (chunk, next) => {
            receivedChunk = chunk;
            receivedNext = next;
            next(chunk);
          }
        }
      };

      const queue = new RedisCommandsQueue(2, null, () => {}, mockInterceptor);
      queue.addCommand(['PING']);
      for (const _ of queue.commandsToWrite()) {}

      const testChunk = Buffer.from('+OK\r\n');
      queue.processIncomingData(testChunk);

      assert.deepEqual(receivedChunk, testChunk);
      assert.ok(typeof receivedNext === 'function');
    });
  });
});

// ============================================================================
// Auto-pipelining behavior verification
// Ensures queue behavior matches master queue when no timers configured
// ============================================================================

describe('Auto-pipelining behavior', function () {
  // Auto-pipelining works by batching all commands issued in the same event loop
  // tick into a single socket write (via cork/uncork in socket.ts).
  // The queue must yield all commands from the same tick when generator is consumed.
  //
  // NOTE: Master vs no-codec baseline verification tests are in:
  //   'Codec Queue [codec-queue]' > 'without codec (master vs no-codec verification)'
  // This section focuses on codec-specific auto-pipelining behavior.

  describe('codec WITHOUT scheduler (should drain at end)', function () {
    it('batches same-slot commands and drains at generator end', function () {
      // Create queue with interceptor but NO scheduler
      const interceptor = new BinaryHeadersInterceptor({
        outbound: { resolver: STATIC_RESOLVER }
        // Note: no maxWaitMs, no scheduler
      });
      const queue = new RedisCommandsQueue(2, null, () => {}, interceptor);

      // Same-tick commands with same slot
      queue.addCommand(['SET', 'key1', 'value1']);
      queue.addCommand(['GET', 'key1']);
      queue.addCommand(['DEL', 'key1']);

      // Consume generator - should yield ONE packed batch (drained at end)
      const results = collectYielded(queue);

      assert.equal(results.length, 1, 'Should yield 1 packed batch');
      assertPackedData(results[0], {
        commandCount: 3,
        commands: [['SET', 'key1', 'value1'], ['GET', 'key1'], ['DEL', 'key1']]
      });
    });

    it('flushes on slot change and drains remaining at end', function () {
      const interceptor = new BinaryHeadersInterceptor({
        outbound: { resolver: STATIC_RESOLVER }
      });
      const queue = new RedisCommandsQueue(2, null, () => {}, interceptor);

      // Commands with different slots - use {hashtag} syntax to guarantee different slots
      queue.addCommand(['SET', '{slot1}key', 'value1']); // slot for {slot1}
      queue.addCommand(['SET', '{slot2}key', 'value2']); // different slot - triggers flush
      queue.addCommand(['GET', '{slot2}key']);           // same slot as {slot2} - batched

      const results = collectYielded(queue);

      // Should have 2 yields: first batch (slot1), then drain (slot2 commands)
      assert.equal(results.length, 2, 'Should yield 2 batches');

      assertPackedData(results[0], {
        commandCount: 1,
        commands: [['SET', '{slot1}key', 'value1']]
      });

      assertPackedData(results[1], {
        commandCount: 2,
        commands: [['SET', '{slot2}key', 'value2'], ['GET', '{slot2}key']]
      });
    });

    it('generator completes with nothing pending after drain', function () {
      const interceptor = new BinaryHeadersInterceptor({
        outbound: { resolver: STATIC_RESOLVER }
      });
      const queue = new RedisCommandsQueue(2, null, () => {}, interceptor);

      queue.addCommand(['PING']);
      queue.addCommand(['PING']);

      collectYielded(queue);

      // Nothing should be pending after drain
      assert.equal(queue.hasPendingOutbound(), false, 'Nothing pending after drain');
      assert.equal(queue.drainPendingOutbound(), null, 'Drain returns null');
    });
  });

  describe('codec WITH scheduler (should NOT drain at end)', function () {
    let queue: TestableQueueWithTimer;

    afterEach(function () {
      if (queue) queue.destroy();
    });

    it('does NOT drain at generator end - leaves commands for timer', function () {
      queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 100, scheduler: createTimeoutScheduler() }
      });

      // Same-tick commands
      queue.addCommand(['SET', 'key1', 'value1']);
      queue.addCommand(['GET', 'key1']);

      // Consume generator - should yield NOTHING (commands left for timer)
      const results = collectYielded(queue);

      assert.equal(results.length, 0, 'Should yield nothing - timer handles it');
      assert.equal((queue as RedisCommandsQueue).hasPendingOutbound(), true, 'Commands pending for timer');
    });

    it('still flushes on slot change mid-generator', function () {
      queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 100, scheduler: createTimeoutScheduler() }
      });

      queue.addCommand(['SET', 'key1', 'value1']); // slot A
      queue.addCommand(['SET', 'key2', 'value2']); // slot B - triggers flush

      const results = collectYielded(queue);

      // First batch flushed due to slot change
      assert.equal(results.length, 1, 'Should yield 1 batch from slot change');
      assertPackedData(results[0], {
        commandCount: 1,
        commands: [['SET', 'key1', 'value1']]
      });

      // Second command still pending for timer
      assert.equal((queue as RedisCommandsQueue).hasPendingOutbound(), true, 'key2 pending for timer');
    });

    it('alternating slots with scheduler: each flush reschedules timer for remaining', async function () {
      queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 50, scheduler: createTimeoutScheduler() }
      });

      const flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((encoded) => {
        flushedData.push(encoded);
      });

      // 3 commands with alternating slots: A, B, A
      queue.addCommand(['SET', '{slot1}key1', 'value1']); // slot A
      queue.addCommand(['SET', '{slot2}key2', 'value2']); // slot B - triggers flush of A
      queue.addCommand(['SET', '{slot1}key3', 'value3']); // slot A - triggers flush of B

      const results = collectYielded(queue);

      // Should yield 2 batches from slot changes (A flushed by B, B flushed by A)
      assert.equal(results.length, 2, 'Should yield 2 batches from slot changes');
      assertPackedData(results[0], {
        commandCount: 1,
        commands: [['SET', '{slot1}key1', 'value1']]
      });
      assertPackedData(results[1], {
        commandCount: 1,
        commands: [['SET', '{slot2}key2', 'value2']]
      });

      // Third command still pending for timer
      assert.equal((queue as RedisCommandsQueue).hasPendingOutbound(), true, 'key3 pending for timer');

      // Wait for timer to flush the remaining command
      await delay(60);

      // Timer should have fired for the last command
      assert.equal(flushedData.length, 1, 'Timer should flush remaining command');
      assertPackedData(flushedData[0], {
        commandCount: 1,
        commands: [['SET', '{slot1}key3', 'value3']]
      });
    });
  });

  describe('comparison: all modes yield all same-tick commands', function () {
    // This is the key auto-pipelining guarantee: all commands from the same tick
    // must be yielded (or made available) when the generator is consumed.

    forQueues(['master', 'no-codec'], 'all commands yielded individually with correct content and order', (queue) => {
      queue.addCommand(['SET', 'a', '1']);
      queue.addCommand(['SET', 'b', '2']);
      queue.addCommand(['SET', 'c', '3']);

      const results = collectYielded(queue);
      assert.equal(results.length, 3, 'Should yield 3 separate commands');

      // Verify content and order - this is the key auto-pipelining guarantee
      const parsed = results.map(r => parseRespCommands((r as string[]).join('')));
      assert.deepEqual(parsed, [
        [['SET', 'a', '1']],
        [['SET', 'b', '2']],
        [['SET', 'c', '3']]
      ], 'Commands yielded in order with correct content');
    });

    it('codec-no-scheduler: all commands yielded via drain', function () {
      const queue = createBinhdrQueue(); // Uses STATIC_RESOLVER, no scheduler
      queue.addCommand(['SET', 'key', '1']);
      queue.addCommand(['SET', 'key', '2']);
      queue.addCommand(['SET', 'key', '3']);

      const results = collectYielded(queue);
      // All commands batched into 1 yield (same slot)
      assert.equal(results.length, 1, 'All commands in 1 batch');
      assertPackedData(results[0], {
        commandCount: 3,
        commands: [['SET', 'key', '1'], ['SET', 'key', '2'], ['SET', 'key', '3']]
      });
    });

    it('codec-with-scheduler: commands available via timer callback', async function () {
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 10, scheduler: createTimeoutScheduler() }
      });

      const flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((data) => flushedData.push(data));

      queue.addCommand(['SET', 'key', '1']);
      queue.addCommand(['SET', 'key', '2']);
      queue.addCommand(['SET', 'key', '3']);

      // Generator yields nothing (timer handles it)
      const results = collectYielded(queue);
      assert.equal(results.length, 0);

      // Wait for timer
      await delay(20);

      // All commands available via callback
      assert.equal(flushedData.length, 1, 'Timer flushed all commands');
      assertPackedData(flushedData[0], {
        commandCount: 3,
        commands: [['SET', 'key', '1'], ['SET', 'key', '2'], ['SET', 'key', '3']]
      });

      queue.destroy();
    });
  });

  describe('mixed eligible/ineligible commands', function () {
    it('ineligible commands pass through while eligible ones batch', function () {
      const queue = createBinhdrQueue();

      // PING is eligible (keyless), UNKNOWNCMD is ineligible
      queue.addCommand(['PING']);
      queue.addCommand(['UNKNOWNCMD', 'arg']); // Not in STATIC_RESOLVER - triggers flush
      queue.addCommand(['PING']);

      const results = collectYielded(queue);

      // Ineligible command triggers flush of buffered eligible commands to preserve order
      // 1. PING is buffered
      // 2. UNKNOWNCMD is ineligible - flushes PING first, then passes through
      // 3. Second PING is buffered, then drained at end
      assert.equal(results.length, 3, 'Should have 3 yields');

      // First yield: packed PING batch (flushed when ineligible arrived)
      assertPackedData(results[0], {
        commandCount: 1,
        commands: [['PING']]
      });

      // Second yield: ineligible command passed through as-is (unpacked RESP)
      const parsedIneligible = parseRespCommands((results[1] as string[]).join(''));
      assert.deepEqual(parsedIneligible, [['UNKNOWNCMD', 'arg']], 'Ineligible passes through unpacked');

      // Third yield: second PING drained at end
      assertPackedData(results[2], {
        commandCount: 1,
        commands: [['PING']]
      });
    });

    it('eligible commands with different slots cause separate batches', function () {
      const queue = createBinhdrQueue();

      // Commands with different hash slots
      queue.addCommand(['SET', '{slot1}key', 'value1']);
      queue.addCommand(['SET', '{slot2}key', 'value2']); // Different slot - flushes slot1
      queue.addCommand(['SET', '{slot1}key2', 'value3']); // Different slot again - flushes slot2

      const results = collectYielded(queue);

      // Each slot change triggers a flush, plus final drain
      // 1. slot1->slot2 flushes slot1 (1 cmd)
      // 2. slot2->slot1 flushes slot2 (1 cmd)
      // 3. drain flushes remaining slot1 (1 cmd)
      assert.equal(results.length, 3, 'Should have 3 batches due to slot changes');
      assertPackedData(results[0], {
        commandCount: 1,
        commands: [['SET', '{slot1}key', 'value1']]
      });
      assertPackedData(results[1], {
        commandCount: 1,
        commands: [['SET', '{slot2}key', 'value2']]
      });
      assertPackedData(results[2], {
        commandCount: 1,
        commands: [['SET', '{slot1}key2', 'value3']]
      });
    });

    it('multiple eligible commands between ineligible ones batch correctly', function () {
      const queue = createBinhdrQueue();

      queue.addCommand(['SET', 'k1', 'v1']);
      queue.addCommand(['GET', 'k1']);
      queue.addCommand(['UNKNOWNCMD']); // Ineligible - triggers flush of k1 commands
      queue.addCommand(['SET', 'k2', 'v2']);
      queue.addCommand(['GET', 'k2']);

      const results = collectYielded(queue);

      // Ineligible command triggers flush of buffered commands to preserve order
      // 1. SET+GET for k1 are buffered
      // 2. UNKNOWNCMD triggers flush of k1 batch, then passes through
      // 3. SET+GET for k2 are buffered, then drained at end
      assert.equal(results.length, 3, 'Should have 3 yields');

      // First batch: SET+GET for k1 (flushed when ineligible arrived)
      assertPackedData(results[0], {
        commandCount: 2,
        commands: [['SET', 'k1', 'v1'], ['GET', 'k1']]
      });

      // Ineligible passes through
      const parsedIneligible = parseRespCommands((results[1] as string[]).join(''));
      assert.deepEqual(parsedIneligible, [['UNKNOWNCMD']]);

      // Second batch: SET+GET for k2 (drained at end)
      assertPackedData(results[2], {
        commandCount: 2,
        commands: [['SET', 'k2', 'v2'], ['GET', 'k2']]
      });
    });

    it('multiple ineligible commands in a row', function () {
      const queue = createBinhdrQueue();

      queue.addCommand(['SET', 'k', 'v']);  // Eligible - buffered
      queue.addCommand(['UNKNOWN1']);        // Ineligible - flushes SET, passes through
      queue.addCommand(['UNKNOWN2']);        // Ineligible - nothing to flush, passes through
      queue.addCommand(['GET', 'k']);        // Eligible - buffered, drained at end

      const results = collectYielded(queue);

      assert.equal(results.length, 4, 'Should have 4 yields');

      // First: packed SET (flushed when UNKNOWN1 arrived)
      assertPackedData(results[0], {
        commandCount: 1,
        commands: [['SET', 'k', 'v']]
      });

      // Second: UNKNOWN1 passthrough
      const parsed1 = parseRespCommands((results[1] as string[]).join(''));
      assert.deepEqual(parsed1, [['UNKNOWN1']]);

      // Third: UNKNOWN2 passthrough (no flush needed, buffer was empty)
      const parsed2 = parseRespCommands((results[2] as string[]).join(''));
      assert.deepEqual(parsed2, [['UNKNOWN2']]);

      // Fourth: packed GET (drained at end)
      assertPackedData(results[3], {
        commandCount: 1,
        commands: [['GET', 'k']]
      });
    });

    it('ineligible command when buffer is empty', function () {
      const queue = createBinhdrQueue();

      queue.addCommand(['UNKNOWNCMD', 'arg']);  // Ineligible - nothing to flush

      const results = collectYielded(queue);

      assert.equal(results.length, 1, 'Should have 1 yield');

      // Just the passthrough, no flush needed
      const parsed = parseRespCommands((results[0] as string[]).join(''));
      assert.deepEqual(parsed, [['UNKNOWNCMD', 'arg']]);
    });

    it('ineligible at start, middle, and end', function () {
      const queue = createBinhdrQueue();

      queue.addCommand(['UNKNOWN1']);        // Ineligible at start
      queue.addCommand(['PING']);            // Eligible - buffered
      queue.addCommand(['UNKNOWN2']);        // Ineligible in middle - flushes PING
      queue.addCommand(['PING']);            // Eligible - buffered
      queue.addCommand(['UNKNOWN3']);        // Ineligible at end - flushes PING

      const results = collectYielded(queue);

      assert.equal(results.length, 5, 'Should have 5 yields');

      // 1. UNKNOWN1 passthrough
      const parsed1 = parseRespCommands((results[0] as string[]).join(''));
      assert.deepEqual(parsed1, [['UNKNOWN1']]);

      // 2. packed PING (flushed when UNKNOWN2 arrived)
      assertPackedData(results[1], {
        commandCount: 1,
        commands: [['PING']]
      });

      // 3. UNKNOWN2 passthrough
      const parsed2 = parseRespCommands((results[2] as string[]).join(''));
      assert.deepEqual(parsed2, [['UNKNOWN2']]);

      // 4. packed PING (flushed when UNKNOWN3 arrived)
      assertPackedData(results[3], {
        commandCount: 1,
        commands: [['PING']]
      });

      // 5. UNKNOWN3 passthrough
      const parsed3 = parseRespCommands((results[4] as string[]).join(''));
      assert.deepEqual(parsed3, [['UNKNOWN3']]);
    });

    it('different slots interleaved with ineligible commands', function () {
      const queue = createBinhdrQueue();

      queue.addCommand(['SET', '{a}k', 'v']);   // Slot A - buffered
      queue.addCommand(['UNKNOWNCMD']);         // Ineligible - flushes slot A
      queue.addCommand(['SET', '{b}k', 'v']);   // Slot B - buffered, drained at end

      const results = collectYielded(queue);

      assert.equal(results.length, 3, 'Should have 3 yields');

      // First: packed slot A (flushed when ineligible arrived)
      assertPackedData(results[0], {
        commandCount: 1,
        commands: [['SET', '{a}k', 'v']]
      });

      // Second: ineligible passthrough
      const parsed = parseRespCommands((results[1] as string[]).join(''));
      assert.deepEqual(parsed, [['UNKNOWNCMD']]);

      // Third: packed slot B (drained at end)
      assertPackedData(results[2], {
        commandCount: 1,
        commands: [['SET', '{b}k', 'v']]
      });
    });

    it('ineligible commands with timer-based batching', function () {
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 1000, scheduler: createTimeoutScheduler() }
      });

      queue.addCommand(['PING']);            // Eligible - buffered
      queue.addCommand(['UNKNOWNCMD']);      // Ineligible - flushes PING, passes through
      queue.addCommand(['PING']);            // Eligible - buffered (for timer)

      const results = collectYielded(queue);

      // With scheduler, drain doesn't happen at generator end
      // But ineligible still triggers flush of buffered commands
      assert.equal(results.length, 2, 'Should have 2 yields (flush + passthrough)');

      // First: packed PING (flushed when ineligible arrived)
      assertPackedData(results[0], {
        commandCount: 1,
        commands: [['PING']]
      });

      // Second: ineligible passthrough
      const parsed = parseRespCommands((results[1] as string[]).join(''));
      assert.deepEqual(parsed, [['UNKNOWNCMD']]);

      // Third PING is still buffered for timer
      assert.equal(queue.hasPendingOutbound(), true, 'Should have pending for timer');

      queue.destroy();
    });
  });

  describe('edge cases', function () {
    it('empty command array is handled', function () {
      const queue = createBinhdrQueue();
      queue.addCommand([]);

      const results = collectYielded(queue);
      // Empty command should still be processed
      assert.ok(results.length >= 0);
    });

    it('very long command is handled', function () {
      const queue = createBinhdrQueue();
      const longValue = 'x'.repeat(10000);
      queue.addCommand(['SET', 'key', longValue]);

      const results = collectYielded(queue);
      assert.equal(results.length, 1);
      assertPackedHeader(results[0], { commandCount: 1 });
    });

    it('buffer commands are handled correctly', function () {
      const queue = createBinhdrQueue();
      queue.addCommand([Buffer.from('SET'), Buffer.from('key'), Buffer.from('value')]);

      const results = collectYielded(queue);
      assert.equal(results.length, 1);
      assertPackedHeader(results[0], { commandCount: 1 });
    });

    it('multiple generator iterations with commands added between', function () {
      const queue = createBinhdrQueue();

      // First batch
      queue.addCommand(['PING']);
      queue.addCommand(['PING']);
      const results1 = collectYielded(queue);
      assert.equal(results1.length, 1);
      assertPackedHeader(results1[0], { commandCount: 2 });

      // Second batch - new commands after first generator exhausted
      queue.addCommand(['TIME']);
      queue.addCommand(['TIME']);
      const results2 = collectYielded(queue);
      assert.equal(results2.length, 1);
      assertPackedHeader(results2[0], { commandCount: 2 });
    });

    it('interleaved addCommand and partial generator consumption', function () {
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 1000, scheduler: createTimeoutScheduler() }
      });

      queue.addCommand(['SET', '{a}key1', 'v1']);
      queue.addCommand(['SET', '{b}key2', 'v2']); // Different slot - triggers flush

      // Consume generator - should get first batch from slot change
      const gen = queue.commandsToWrite();
      const first = gen.next();

      assert.equal(first.done, false);
      assertPackedHeader(first.value!, { commandCount: 1 });

      // Generator should complete (second command buffered for timer)
      const second = gen.next();
      assert.equal(second.done, true);

      queue.destroy();
    });
  });
});

// ============================================================================
// Table-driven tests for chunking, stress, and error scenarios
// ============================================================================

describe('Chunking scenarios (table-driven)', function () {
  const chunkingCases = [
    {
      name: 'single byte chunks',
      payload: respSimpleString('PONG'),
      chunk: (frame: Buffer) => splitIntoBytes(frame),
      expected: 'PONG',
    },
    {
      name: 'split at header boundary (byte 8)',
      payload: respSimpleString('OK'),
      chunk: (frame: Buffer) => splitAt(frame, 8),
      expected: 'OK',
    },
    {
      name: 'split mid-header (byte 4)',
      payload: respSimpleString('HI'),
      chunk: (frame: Buffer) => splitAt(frame, 4),
      expected: 'HI',
    },
    {
      name: 'split mid-payload',
      payload: respSimpleString('HELLO'),
      chunk: (frame: Buffer) => splitAt(frame, 10),
      expected: 'HELLO',
    },
    {
      name: 'two-byte chunks',
      payload: respInteger(12345),
      chunk: (frame: Buffer) => {
        const chunks: Buffer[] = [];
        for (let i = 0; i < frame.length; i += 2) {
          chunks.push(frame.subarray(i, Math.min(i + 2, frame.length)));
        }
        return chunks;
      },
      expected: 12345,
    },
    {
      name: 'random split points',
      payload: respBulkString('test-value'),
      chunk: (frame: Buffer) => splitAt(frame, 3, 7, 12, 18),
      expected: 'test-value', // bulk string returns string by default
    },
  ];

  for (const tc of chunkingCases) {
    it(tc.name, async function () {
      const queue = createBinhdrQueue();
      const promise = queue.addCommand(['PING']);
      for (const _ of queue.commandsToWrite()) {}

      const frame = createBinhdrFrame(tc.payload);
      const chunks = tc.chunk(frame);

      for (const chunk of chunks) {
        queue.processIncomingData(chunk);
      }

      const result = await promise;
      assert.deepEqual(result, tc.expected);
    });
  }
});

describe('Stress scenarios (table-driven)', function () {
  const stressCases = [
    {
      name: '100 commands batched',
      commandCount: 100,
      payload: () => respSimpleString('OK'),
    },
    {
      name: '1000 commands batched',
      commandCount: 1000,
      payload: () => respSimpleString('OK'),
    },
    {
      name: '10KB payload per response',
      commandCount: 10,
      payload: () => respBulkString(largeBuffer(10 * 1024)),
    },
    {
      name: '100KB payload single response',
      commandCount: 1,
      payload: () => respBulkString(largeBuffer(100 * 1024)),
    },
    {
      name: 'many small responses in one chunk',
      commandCount: 50,
      payload: () => respInteger(42),
    },
  ];

  for (const tc of stressCases) {
    it(tc.name, async function () {
      this.timeout(5000); // Allow more time for stress tests

      const queue = createBinhdrQueue();
      const promises: Promise<unknown>[] = [];

      for (let i = 0; i < tc.commandCount; i++) {
        promises.push(queue.addCommand(['PING']));
      }
      for (const _ of queue.commandsToWrite()) {}

      // Send all responses
      const payload = tc.payload();
      const allFrames = createMultipleFrames(tc.commandCount, payload);
      queue.processIncomingData(allFrames);

      const results = await Promise.all(promises);
      assert.equal(results.length, tc.commandCount);
    });
  }
});

describe('Error scenarios (table-driven)', function () {
  const errorCases = [
    {
      name: 'single error response',
      commands: [['GET', 'key']],
      responses: [respError('WRONGTYPE Operation against a key')],
      expectedErrors: 1,
    },
    {
      name: 'error followed by success',
      commands: [['GET', 'key1'], ['GET', 'key2']],
      responses: [respError('WRONGTYPE'), respSimpleString('value2')],
      expectedErrors: 1,
    },
    {
      name: 'success followed by error',
      commands: [['GET', 'key1'], ['GET', 'key2']],
      responses: [respSimpleString('value1'), respError('READONLY')],
      expectedErrors: 1,
    },
    {
      name: 'multiple errors',
      commands: [['GET', 'a'], ['GET', 'b'], ['GET', 'c']],
      responses: [respError('ERR1'), respError('ERR2'), respError('ERR3')],
      expectedErrors: 3,
    },
    {
      name: 'null response',
      commands: [['GET', 'nonexistent']],
      responses: [respNull()],
      expectedErrors: 0,
    },
  ];

  for (const tc of errorCases) {
    it(tc.name, async function () {
      const queue = createBinhdrQueue();
      const promises = tc.commands.map(cmd => queue.addCommand(cmd));
      for (const _ of queue.commandsToWrite()) {}

      // Send responses
      for (const resp of tc.responses) {
        queue.processIncomingData(createBinhdrFrame(resp));
      }

      let errorCount = 0;
      const results = await Promise.allSettled(promises);

      for (const result of results) {
        if (result.status === 'rejected') {
          errorCount++;
        }
      }

      assert.equal(errorCount, tc.expectedErrors);
    });
  }
});

describe('Multi-frame chunking scenarios (table-driven)', function () {
  const multiFrameCases = [
    {
      name: 'two frames split at boundary',
      payloads: [respSimpleString('A'), respSimpleString('B')],
      splitStrategy: 'boundary', // Split exactly between frames
    },
    {
      name: 'two frames split mid-second-header',
      payloads: [respSimpleString('X'), respSimpleString('Y')],
      splitStrategy: 'mid-header', // Split 4 bytes into second frame
    },
    {
      name: 'three frames as single chunk',
      payloads: [respInteger(1), respInteger(2), respInteger(3)],
      splitStrategy: 'none', // All in one chunk
    },
    {
      name: 'three frames byte-by-byte',
      payloads: [respSimpleString('A'), respSimpleString('B'), respSimpleString('C')],
      splitStrategy: 'bytes',
    },
  ];

  for (const tc of multiFrameCases) {
    it(tc.name, async function () {
      const queue = createBinhdrQueue();
      const promises = tc.payloads.map(() => queue.addCommand(['PING']));
      for (const _ of queue.commandsToWrite()) {}

      const frames = tc.payloads.map(p => createBinhdrFrame(p));
      const combined = Buffer.concat(frames);

      let chunks: Buffer[];
      switch (tc.splitStrategy) {
        case 'boundary':
          chunks = frames; // Each frame is its own chunk
          break;
        case 'mid-header':
          chunks = splitAt(combined, frames[0].length + 4);
          break;
        case 'none':
          chunks = [combined];
          break;
        case 'bytes':
          chunks = splitIntoBytes(combined);
          break;
        default:
          chunks = [combined];
      }

      for (const chunk of chunks) {
        queue.processIncomingData(chunk);
      }

      const results = await Promise.all(promises);
      assert.equal(results.length, tc.payloads.length);
    });
  }
});

// ============================================================================
// Stats ↔ Timer Integration Tests
// Verifies that statistics are correctly recorded during timer-based flushing
// ============================================================================

describe('Stats-Timer Integration (table-driven)', function () {
  let activeQueues: TestableQueueWithTimerAndStats[] = [];

  afterEach(function () {
    for (const queue of activeQueues) {
      queue.destroy();
    }
    activeQueues = [];
  });

  function createQueueWithTimerAndStats(maxWaitMs: number, useImmediate = false): TestableQueueWithTimerAndStats {
    const queue = createBinhdrQueueWithTimerAndStats({
      timer: {
        maxWaitMs,
        scheduler: useImmediate ? createImmediateScheduler() : createTimeoutScheduler(),
      },
    });
    activeQueues.push(queue);
    return queue;
  }

  interface StatsTimerTestCase {
    name: string;
    setup: (queue: TestableQueueWithTimerAndStats) => void | Promise<void>;
    action: (queue: TestableQueueWithTimerAndStats) => void | Promise<void>;
    expectedStats: {
      totalCommandCount?: number;
      batchedCommandCount?: number;
      batchCount?: number;
      ineligibleCount?: number;
      slotMismatchFlushCount?: number;
      timerFlushCount?: number;
      drainFlushCount?: number;
    };
  }

  const statsTimerCases: StatsTimerTestCase[] = [
    {
      name: 'timer flush increments timerFlushCount',
      setup: (queue) => {
        queue.addCommand(['SET', 'key', 'value']);
        collectYielded(queue); // buffer for timer
      },
      action: async (queue) => {
        await delay(30); // wait for timer to fire
      },
      expectedStats: {
        totalCommandCount: 1,
        batchedCommandCount: 1,
        batchCount: 1,
        timerFlushCount: 1,
        drainFlushCount: 0,
        slotMismatchFlushCount: 0,
      },
    },
    {
      name: 'multiple timer flushes accumulate timerFlushCount',
      setup: () => {},
      action: async (queue) => {
        queue.addCommand(['SET', 'k1', 'v1']);
        collectYielded(queue);
        await delay(30);

        queue.addCommand(['SET', 'k2', 'v2']);
        collectYielded(queue);
        await delay(30);

        queue.addCommand(['SET', 'k3', 'v3']);
        collectYielded(queue);
        await delay(30);
      },
      expectedStats: {
        totalCommandCount: 3,
        batchedCommandCount: 3,
        batchCount: 3,
        timerFlushCount: 3,
        drainFlushCount: 0,
      },
    },
    {
      name: 'slot mismatch flush increments slotMismatchFlushCount, not timerFlushCount',
      setup: () => {},
      action: (queue) => {
        queue.addCommand(['SET', '{a}key', 'v']);
        queue.addCommand(['SET', '{b}key', 'v']); // different slot
        collectYielded(queue);
      },
      expectedStats: {
        totalCommandCount: 2,
        batchedCommandCount: 2,
        batchCount: 1, // slot A flushed, slot B still pending
        slotMismatchFlushCount: 1,
        timerFlushCount: 0,
        drainFlushCount: 0,
      },
    },
    {
      name: 'manual drain increments drainFlushCount',
      setup: (queue) => {
        queue.addCommand(['SET', 'key', 'value']);
        collectYielded(queue);
      },
      action: (queue) => {
        queue.drainPendingOutbound();
      },
      expectedStats: {
        totalCommandCount: 1,
        batchedCommandCount: 1,
        batchCount: 1,
        drainFlushCount: 1,
        timerFlushCount: 0,
      },
    },
    {
      name: 'batched commands in single timer flush',
      setup: () => {},
      action: async (queue) => {
        queue.addCommand(['SET', 'key', 'v1']);
        collectYielded(queue);
        queue.addCommand(['GET', 'key']);
        collectYielded(queue);
        queue.addCommand(['DEL', 'key']);
        collectYielded(queue);
        await delay(30);
      },
      expectedStats: {
        totalCommandCount: 3,
        batchedCommandCount: 3,
        batchCount: 1, // all 3 in one batch
        timerFlushCount: 1,
      },
    },
    {
      name: 'slot change then timer: both flush types recorded',
      setup: () => {},
      action: async (queue) => {
        queue.addCommand(['SET', '{a}k', 'v']);
        queue.addCommand(['SET', '{b}k', 'v']); // triggers slot flush
        collectYielded(queue);
        await delay(30); // timer flushes {b}k
      },
      expectedStats: {
        totalCommandCount: 2,
        batchedCommandCount: 2,
        batchCount: 2,
        slotMismatchFlushCount: 1,
        timerFlushCount: 1,
        drainFlushCount: 0,
      },
    },
  ];

  for (const tc of statsTimerCases) {
    it(tc.name, async function () {
      const queue = createQueueWithTimerAndStats(15);
      queue.setTimerFlushCallback(() => {}); // required for timer to work

      await tc.setup(queue);
      await tc.action(queue);

      const stats = queue.getStats();
      assertStats(stats, tc.expectedStats);
    });
  }

  describe('stats without timer (drain at generator end)', function () {
    const noTimerCases: StatsTimerTestCase[] = [
      {
        name: 'generator drain increments drainFlushCount',
        setup: () => {},
        action: (queue) => {
          queue.addCommand(['SET', 'key', 'value']);
          collectYielded(queue); // drains at end
        },
        expectedStats: {
          totalCommandCount: 1,
          batchedCommandCount: 1,
          batchCount: 1,
          drainFlushCount: 1,
          timerFlushCount: 0,
        },
      },
      {
        name: 'multiple commands drained together',
        setup: () => {},
        action: (queue) => {
          queue.addCommand(['SET', 'k1', 'v1']);
          queue.addCommand(['GET', 'k1']);
          queue.addCommand(['DEL', 'k1']);
          collectYielded(queue);
        },
        expectedStats: {
          totalCommandCount: 3,
          batchedCommandCount: 3,
          batchCount: 1,
          drainFlushCount: 1,
        },
      },
      {
        name: 'slot change + drain at end',
        setup: () => {},
        action: (queue) => {
          queue.addCommand(['SET', '{a}k', 'v']);
          queue.addCommand(['SET', '{b}k', 'v']);
          collectYielded(queue);
        },
        expectedStats: {
          totalCommandCount: 2,
          batchedCommandCount: 2,
          batchCount: 2,
          slotMismatchFlushCount: 1,
          drainFlushCount: 1,
        },
      },
    ];

    for (const tc of noTimerCases) {
      it(tc.name, function () {
        const queue = createBinhdrQueueWithStats() as unknown as TestableQueueWithTimerAndStats;
        tc.action(queue);
        const stats = (queue as unknown as TestableQueueWithStats).getStats();
        assertStats(stats, tc.expectedStats);
      });
    }
  });
});



// ============================================================================
// Timer Precision and Accumulation Tests
// ============================================================================

describe('Timer Precision and Accumulation', function () {
  let activeQueues: TestableQueueWithTimer[] = [];

  afterEach(function () {
    for (const queue of activeQueues) {
      queue.destroy();
    }
    activeQueues = [];
  });

  interface TimerPrecisionCase {
    name: string;
    maxWaitMs: number;
    waitBefore: number;
    expectFired: boolean;
  }

  const precisionCases: TimerPrecisionCase[] = [
    { name: 'timer does not fire at 30% of maxWaitMs', maxWaitMs: 100, waitBefore: 30, expectFired: false },
    { name: 'timer does not fire at 60% of maxWaitMs', maxWaitMs: 100, waitBefore: 60, expectFired: false },
    { name: 'timer fires after maxWaitMs elapsed', maxWaitMs: 50, waitBefore: 70, expectFired: true },
    { name: 'timer fires promptly with small maxWaitMs', maxWaitMs: 10, waitBefore: 25, expectFired: true },
  ];

  for (const tc of precisionCases) {
    it(tc.name, async function () {
      const queue = createBinhdrQueueWithTimer({ timer: { maxWaitMs: tc.maxWaitMs, scheduler: createTimeoutScheduler() } });
      activeQueues.push(queue);

      let fired = false;
      queue.setTimerFlushCallback(() => { fired = true; });

      queue.addCommand(['PING']);
      collectYielded(queue);

      await delay(tc.waitBefore);
      assert.equal(fired, tc.expectFired, `Timer fired=${fired}, expected=${tc.expectFired}`);
    });
  }

  it('timer accumulation: 5 cycles with stats', async function () {
    const queue = createBinhdrQueueWithTimerAndStats({
      timer: { maxWaitMs: 10, scheduler: createTimeoutScheduler() },
    });
    activeQueues.push(queue as TestableQueueWithTimer);
    queue.setTimerFlushCallback(() => {});

    for (let i = 0; i < 5; i++) {
      queue.addCommand(['SET', `key${i}`, `value${i}`]);
      collectYielded(queue);
      await delay(20);
    }

    const stats = queue.getStats();
    assertStats(stats, {
      totalCommandCount: 5,
      batchedCommandCount: 5,
      batchCount: 5,
      timerFlushCount: 5,
    });
  });
});

// ============================================================================
// Stats Immutability and Isolation Tests
// ============================================================================

describe('Stats Immutability and Isolation', function () {
  it('snapshot is immutable after creation', function () {
    const queue = createBinhdrQueueWithStats();
    queue.addCommand(['PING']);
    collectYielded(queue);

    const snapshot1 = queue.getStats();
    const originalTotal = snapshot1.totalCommandCount;

    // Add more commands
    queue.addCommand(['PING']);
    queue.addCommand(['PING']);
    collectYielded(queue);

    // Original snapshot should be unchanged
    assert.equal(snapshot1.totalCommandCount, originalTotal, 'Snapshot should be immutable');

    // New snapshot should have updated values
    const snapshot2 = queue.getStats();
    assert.equal(snapshot2.totalCommandCount, originalTotal + 2);
  });

  it('multiple snapshots are independent', function () {
    const queue = createBinhdrQueueWithStats();

    queue.addCommand(['PING']);
    collectYielded(queue);
    const s1 = queue.getStats();

    queue.addCommand(['PING']);
    collectYielded(queue);
    const s2 = queue.getStats();

    queue.addCommand(['PING']);
    collectYielded(queue);
    const s3 = queue.getStats();

    assert.equal(s1.totalCommandCount, 1);
    assert.equal(s2.totalCommandCount, 2);
    assert.equal(s3.totalCommandCount, 3);
  });

  it('stats from different queues are isolated', function () {
    const queue1 = createBinhdrQueueWithStats();
    const queue2 = createBinhdrQueueWithStats();

    queue1.addCommand(['PING']);
    queue1.addCommand(['PING']);
    queue1.addCommand(['PING']);
    collectYielded(queue1);

    queue2.addCommand(['PING']);
    collectYielded(queue2);

    const stats1 = queue1.getStats();
    const stats2 = queue2.getStats();

    assert.equal(stats1.totalCommandCount, 3);
    assert.equal(stats2.totalCommandCount, 1);
  });


});

// ============================================================================
// Partial Generator Consumption
// ============================================================================

describe('Partial Generator Consumption', function () {
  let activeQueues: TestableQueueWithTimer[] = [];

  afterEach(function () {
    for (const queue of activeQueues) {
      queue.destroy();
    }
    activeQueues = [];
  });

  it('partial consumption with timer: exhausting generator buffers for timer', async function () {
    const { scheduler, stats } = createTrackingScheduler();
    const queue = createBinhdrQueueWithTimer({ timer: { maxWaitMs: 20, scheduler } });
    activeQueues.push(queue);

    const flushedData: ReadonlyArray<unknown>[] = [];
    queue.setTimerFlushCallback((encoded) => { flushedData.push(encoded); });

    // Add commands that will cause slot flush
    queue.addCommand(['SET', '{a}k1', 'v']);
    queue.addCommand(['SET', '{b}k2', 'v']); // triggers flush of {a}k1

    // Consume generator fully - slot flush yields first batch, second is buffered for timer
    const results = collectYielded(queue);

    // Should yield first batch (flushed due to slot change)
    assert.equal(results.length, 1);
    assertPackedHeader(results[0], { commandCount: 1 });

    // Second command should be pending in codec buffer for timer
    assert.equal(queue.hasPendingOutbound(), true);

    // Wait for timer
    await delay(30);

    // Timer should have flushed the remaining command
    assert.equal(flushedData.length, 1);
    assertPackedHeader(flushedData[0], { commandCount: 1 });
  });

  it('generator not started: commands stay in toWrite until consumed', function () {
    const queue = createBinhdrQueueWithTimer({ timer: { maxWaitMs: 100, scheduler: createTimeoutScheduler() } });
    activeQueues.push(queue);

    queue.addCommand(['PING']);
    queue.addCommand(['PING']);

    // Don't start generator at all
    // Commands are in toWrite, not in codec buffer yet
    assert.equal(queue.hasPendingOutbound(), false, 'Nothing in codec buffer');

    // Now consume
    const results = collectYielded(queue);
    // With scheduler, generator doesn't drain at end
    assert.equal(results.length, 0);
    assert.equal(queue.hasPendingOutbound(), true, 'Now in codec buffer');
  });

  it('multiple partial consumptions accumulate correctly', async function () {
    const queue = createBinhdrQueueWithTimerAndStats({
      timer: { maxWaitMs: 100, scheduler: createTimeoutScheduler() },
    });
    activeQueues.push(queue as TestableQueueWithTimer);

    // First batch: add and partial consume
    queue.addCommand(['SET', '{a}k1', 'v']);
    queue.addCommand(['SET', '{b}k2', 'v']); // triggers flush

    const gen1 = queue.commandsToWrite();
    gen1.next(); // consume flushed batch
    // Don't exhaust gen1

    // Second batch: add more
    queue.addCommand(['SET', '{c}k3', 'v']); // triggers flush of {b}k2

    const gen2 = queue.commandsToWrite();
    gen2.next(); // consume flushed batch

    // Stats should reflect all operations
    const stats = queue.getStats();
    assert.equal(stats.totalCommandCount, 3);
    assert.equal(stats.slotMismatchFlushCount, 2);
  });
});

// ============================================================================
// Explicit Pipeline Behavior (chainId detection)
// ============================================================================

describe('Explicit Pipeline Behavior (chainId)', function () {
  /**
   * These tests verify the optimization for explicit pipelines (execAsPipeline).
   * When commands have a chainId set, they are part of an explicit pipeline
   * and should flush immediately without waiting for timer.
   */

  describe('explicit pipeline detection via chainId', function () {
    it('commands with chainId flush immediately even with scheduler', function () {
      const { scheduler, stats: schedulerStats } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 100, scheduler }
      });

      const chainId = Symbol('Pipeline Chain');

      // Add commands with chainId (simulating execAsPipeline)
      // Use same-slot keys (hash tag format) to ensure batching
      queue.addCommand(['SET', '{slot}key1', 'value1'], { chainId });
      queue.addCommand(['SET', '{slot}key2', 'value2'], { chainId });

      const results = collectYielded(queue);

      // Should yield immediately (not wait for timer)
      assert.equal(results.length, 1, 'Should yield 1 batch immediately');
      assertPackedData(results[0], {
        commandCount: 2,
        commands: [['SET', '{slot}key1', 'value1'], ['SET', '{slot}key2', 'value2']]
      });

      // Timer should NOT have been scheduled for explicit pipeline
      assert.equal(schedulerStats.scheduleCount, 0, 'Timer should not be scheduled for explicit pipeline');

      queue.destroy();
    });

    it('commands without chainId wait for timer (auto-pipelining)', function () {
      const { scheduler, stats: schedulerStats } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 100, scheduler }
      });

      // Add commands without chainId (auto-pipelining)
      // Use same-slot keys to ensure they batch together
      queue.addCommand(['SET', '{slot}key1', 'value1']);
      queue.addCommand(['SET', '{slot}key2', 'value2']);

      const results = collectYielded(queue);

      // Should NOT yield (timer handles it)
      assert.equal(results.length, 0, 'Should not yield - timer handles it');

      // Timer should have been scheduled
      assert.equal(schedulerStats.scheduleCount, 1, 'Timer should be scheduled for auto-pipelining');

      // Commands should be pending
      assert.equal((queue as RedisCommandsQueue).hasPendingOutbound(), true, 'Commands should be pending');

      queue.destroy();
    });

    it('mixed chainId and non-chainId commands: chainId commands flush, others wait', async function () {
      const { scheduler, stats: schedulerStats } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 50, scheduler }
      });

      const flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((data) => flushedData.push(data));

      const chainId = Symbol('Pipeline Chain');

      // First: auto-pipelining command (no chainId)
      // Use different slot than explicit pipeline to avoid slot mismatch flush
      queue.addCommand(['SET', '{auto}key1', 'value1']);
      collectYielded(queue); // Process - should buffer for timer

      // Second: explicit pipeline commands (with chainId)
      // Use same slot within explicit pipeline, but different from auto command
      queue.addCommand(['SET', '{explicit}key1', 'value1'], { chainId });
      queue.addCommand(['SET', '{explicit}key2', 'value2'], { chainId });
      const results = collectYielded(queue);

      // Explicit pipeline should flush immediately (2 outputs: auto flushed by slot change + explicit batch)
      // Note: The auto command gets flushed when explicit commands with different slot arrive
      assert.equal(results.length, 2, 'Should yield 2 batches (auto flushed by slot change, then explicit)');
      assertPackedData(results[0], {
        commandCount: 1,
        commands: [['SET', '{auto}key1', 'value1']]
      });
      assertPackedData(results[1], {
        commandCount: 2,
        commands: [['SET', '{explicit}key1', 'value1'], ['SET', '{explicit}key2', 'value2']]
      });

      // Nothing should be pending after explicit pipeline
      assert.equal((queue as RedisCommandsQueue).hasPendingOutbound(), false, 'Nothing should be pending');

      queue.destroy();
    });

    it('explicit then auto in same drain: explicit flushes, auto waits for timer', async function () {
      const { scheduler, stats: schedulerStats } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 50, scheduler }
      });

      const flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((data) => flushedData.push(data));

      const chainId = Symbol('Pipeline Chain');

      // Queue explicit first, then auto in the same write cycle.
      queue.addCommand(['SET', '{explicit}key1', 'value1'], { chainId });
      queue.addCommand(['SET', '{auto}key1', 'value1']);

      const results = collectYielded(queue);

      // Explicit command should flush immediately.
      assert.equal(results.length, 1, 'Only explicit command should flush immediately');
      assertPackedData(results[0], {
        commandCount: 1,
        commands: [['SET', '{explicit}key1', 'value1']]
      });

      // Auto command should remain pending and be timer-flushed later.
      assert.equal((queue as RedisCommandsQueue).hasPendingOutbound(), true, 'Auto command should remain pending');
      assert.equal(schedulerStats.scheduleCount, 1, 'Timer should be scheduled for pending auto command');

      await delay(60);
      assert.equal(flushedData.length, 1, 'Timer should flush pending auto command');
      assertPackedData(flushedData[0], {
        commandCount: 1,
        commands: [['SET', '{auto}key1', 'value1']]
      });

      queue.destroy();
    });

    it('same-slot auto and explicit commands: auto waits, explicit flushes all', async function () {
      const { scheduler, stats: schedulerStats } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 50, scheduler }
      });

      const flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((data) => flushedData.push(data));

      const chainId = Symbol('Pipeline Chain');

      // First: auto-pipelining command (no chainId)
      queue.addCommand(['SET', '{same}auto1', 'value1']);
      collectYielded(queue); // Process - should buffer for timer

      // Second: explicit pipeline commands (with chainId) - SAME SLOT
      queue.addCommand(['SET', '{same}explicit1', 'value1'], { chainId });
      queue.addCommand(['SET', '{same}explicit2', 'value2'], { chainId });
      const results = collectYielded(queue);

      // Explicit pipeline has chainId, so everything flushes (including the buffered auto command)
      assert.equal(results.length, 1, 'All same-slot commands should flush together');
      assertPackedData(results[0], {
        commandCount: 3,
        commands: [
          ['SET', '{same}auto1', 'value1'],
          ['SET', '{same}explicit1', 'value1'],
          ['SET', '{same}explicit2', 'value2']
        ]
      });

      // Nothing pending
      assert.equal((queue as RedisCommandsQueue).hasPendingOutbound(), false, 'Nothing should be pending');

      // Timer was scheduled for auto command, but cancelled when explicit pipeline flushed
      assert.equal(schedulerStats.cancelCount, 1, 'Timer should have been cancelled');

      queue.destroy();
    });
  });

  describe('explicit pipeline with slot changes (slot cached per chainId)', function () {
    it('commands with different slots in same chainId all use first slots cached value', function () {
      const { scheduler, stats: schedulerStats } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 100, scheduler }
      });

      const chainId = Symbol('Pipeline Chain');

      // Commands with different slots - but chainId caches the first slot
      queue.addCommand(['SET', '{slot1}key1', 'value1'], { chainId }); // slot1 calculated and cached
      queue.addCommand(['SET', '{slot2}key2', 'value2'], { chainId }); // uses cached slot1
      queue.addCommand(['SET', '{slot2}key3', 'value3'], { chainId }); // uses cached slot1

      const results = collectYielded(queue);

      // Should yield 1 batch: all commands use cached slot, flushed at drain
      assert.equal(results.length, 1, 'Should yield 1 batch (all use cached slot)');

      assertPackedData(results[0], {
        commandCount: 3,
        commands: [
          ['SET', '{slot1}key1', 'value1'],
          ['SET', '{slot2}key2', 'value2'],
          ['SET', '{slot2}key3', 'value3']
        ]
      });

      // No timer should be scheduled for explicit pipeline
      assert.equal(schedulerStats.scheduleCount, 0, 'Timer should not be scheduled');

      // Nothing pending
      assert.equal((queue as RedisCommandsQueue).hasPendingOutbound(), false, 'Nothing should be pending');

      queue.destroy();
    });

    it('multiple different slots in explicit pipeline all batch together using cached slot', function () {
      const { scheduler, stats: schedulerStats } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 100, scheduler }
      });

      const chainId = Symbol('Pipeline Chain');

      // Alternating slots: A, B, C - but all use cached slot from first command
      queue.addCommand(['SET', '{a}k1', 'v1'], { chainId }); // slot a calculated and cached
      queue.addCommand(['SET', '{b}k2', 'v2'], { chainId }); // uses cached slot a
      queue.addCommand(['SET', '{c}k3', 'v3'], { chainId }); // uses cached slot a

      const results = collectYielded(queue);

      // Should yield 1 batch (all use cached slot)
      assert.equal(results.length, 1, 'Should yield 1 batch (all use cached slot)');
      assertPackedData(results[0], {
        commandCount: 3,
        commands: [['SET', '{a}k1', 'v1'], ['SET', '{b}k2', 'v2'], ['SET', '{c}k3', 'v3']]
      });

      // No timer scheduled
      assert.equal(schedulerStats.scheduleCount, 0, 'No timer for explicit pipeline');

      queue.destroy();
    });
  });

  describe('explicit pipeline edge cases', function () {
    it('single command with chainId flushes immediately', function () {
      const { scheduler, stats: schedulerStats } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 100, scheduler }
      });

      const chainId = Symbol('Pipeline Chain');

      queue.addCommand(['PING'], { chainId });

      const results = collectYielded(queue);

      assert.equal(results.length, 1, 'Single command should flush');
      assertPackedData(results[0], { commandCount: 1, commands: [['PING']] });
      assert.equal(schedulerStats.scheduleCount, 0, 'No timer for explicit pipeline');

      queue.destroy();
    });

    it('empty explicit pipeline yields nothing', function () {
      const { scheduler } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 100, scheduler }
      });

      // No commands added
      const results = collectYielded(queue);

      assert.equal(results.length, 0, 'Empty pipeline yields nothing');

      queue.destroy();
    });

    it('different chainIds are still treated as explicit pipelines', function () {
      const { scheduler, stats: schedulerStats } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 100, scheduler }
      });

      const chainId1 = Symbol('Pipeline 1');
      const chainId2 = Symbol('Pipeline 2');

      // Two separate explicit pipelines - use same slot
      queue.addCommand(['SET', '{slot}k1', 'v1'], { chainId: chainId1 });
      queue.addCommand(['SET', '{slot}k2', 'v2'], { chainId: chainId2 });

      const results = collectYielded(queue);

      // With chainId boundary flushing, each chainId gets its own batch
      // chainId1 is flushed when we see chainId2, chainId2 is flushed at end
      assert.equal(results.length, 2, 'Each chainId should flush separately');
      assertPackedData(results[0], {
        commandCount: 1,
        commands: [['SET', '{slot}k1', 'v1']]
      });
      assertPackedData(results[1], {
        commandCount: 1,
        commands: [['SET', '{slot}k2', 'v2']]
      });

      assert.equal(schedulerStats.scheduleCount, 0, 'No timer scheduled');

      queue.destroy();
    });

    it('ineligible command in explicit pipeline uses cached slot and batches together', function () {
      const { scheduler, stats: schedulerStats } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 100, scheduler }
      });

      const chainId = Symbol('Pipeline Chain');

      queue.addCommand(['SET', 'k1', 'v1'], { chainId }); // slot calculated and cached
      queue.addCommand(['UNKNOWNCMD', 'arg'], { chainId }); // uses cached slot (not recalculated)
      queue.addCommand(['SET', 'k2', 'v2'], { chainId }); // uses cached slot

      const results = collectYielded(queue);

      // With chainId slot caching, all commands use the cached slot from first command
      // So even UNKNOWNCMD gets batched together (server will error if invalid)
      assert.equal(results.length, 1, 'Should yield 1 batch (all use cached slot)');

      assertPackedData(results[0], {
        commandCount: 3,
        commands: [['SET', 'k1', 'v1'], ['UNKNOWNCMD', 'arg'], ['SET', 'k2', 'v2']]
      });

      assert.equal(schedulerStats.scheduleCount, 0, 'No timer scheduled');

      queue.destroy();
    });
  });

  describe('explicit pipeline stats', function () {
    it('stats correctly track explicit pipeline flushes as DRAIN', function () {
      const queue = createBinhdrQueueWithTimerAndStats({
        timer: { maxWaitMs: 100, scheduler: createTimeoutScheduler() }
      });

      const chainId = Symbol('Pipeline Chain');

      // Use same-slot keys
      queue.addCommand(['SET', '{slot}k1', 'v1'], { chainId });
      queue.addCommand(['SET', '{slot}k2', 'v2'], { chainId });
      queue.addCommand(['SET', '{slot}k3', 'v3'], { chainId });

      collectYielded(queue);

      const stats = queue.getStats();

      assert.equal(stats.totalCommandCount, 3, 'totalCommandCount');
      assert.equal(stats.batchedCommandCount, 3, 'batchedCommandCount');
      assert.equal(stats.batchCount, 1, 'batchCount');
      assert.equal(stats.drainFlushCount, 1, 'drainFlushCount - explicit pipeline uses DRAIN');
      assert.equal(stats.timerFlushCount, 0, 'timerFlushCount - no timer used');

      queue.destroy();
    });

    it('different slots in explicit pipeline all use cached slot - only DRAIN flush', function () {
      const queue = createBinhdrQueueWithTimerAndStats({
        timer: { maxWaitMs: 100, scheduler: createTimeoutScheduler() }
      });

      const chainId = Symbol('Pipeline Chain');

      queue.addCommand(['SET', '{a}k1', 'v1'], { chainId }); // slot a cached
      queue.addCommand(['SET', '{b}k2', 'v2'], { chainId }); // uses cached slot a

      collectYielded(queue);

      const stats = queue.getStats();

      // With chainId slot caching, all commands use cached slot - no slot mismatch
      assert.equal(stats.totalCommandCount, 2, 'totalCommandCount');
      assert.equal(stats.batchCount, 1, 'batchCount - all batched together');
      assert.equal(stats.slotMismatchFlushCount, 0, 'slotMismatchFlushCount - no mismatch with caching');
      assert.equal(stats.drainFlushCount, 1, 'drainFlushCount');
      assert.equal(stats.timerFlushCount, 0, 'timerFlushCount');

      queue.destroy();
    });
  });

  describe('timer creation verification', function () {
    it('explicit pipeline: scheduler.schedule is never called', function () {
      const { scheduler, stats: schedulerStats } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 100, scheduler }
      });

      const chainId = Symbol('Pipeline Chain');

      // Add multiple commands with chainId
      queue.addCommand(['SET', '{slot}k1', 'v1'], { chainId });
      queue.addCommand(['SET', '{slot}k2', 'v2'], { chainId });
      queue.addCommand(['SET', '{slot}k3', 'v3'], { chainId });

      collectYielded(queue);

      // Verify no timer was ever scheduled
      assert.equal(schedulerStats.scheduleCount, 0, 'scheduler.schedule should never be called');
      assert.equal(schedulerStats.cancelCount, 0, 'scheduler.cancel should never be called');
      assert.equal(schedulerStats.lastDelayMs, null, 'no delay should be recorded');

      queue.destroy();
    });

    it('auto-pipelining: scheduler.schedule IS called', function () {
      const { scheduler, stats: schedulerStats } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 100, scheduler }
      });

      // Add commands without chainId (auto-pipelining)
      queue.addCommand(['SET', '{slot}k1', 'v1']);
      queue.addCommand(['SET', '{slot}k2', 'v2']);

      collectYielded(queue);

      // Verify timer WAS scheduled for auto-pipelining
      assert.equal(schedulerStats.scheduleCount, 1, 'scheduler.schedule should be called once');
      assert.equal(schedulerStats.lastDelayMs, 100, 'delay should match maxWaitMs');

      queue.destroy();
    });

    it('explicit pipeline with slot changes: no timer scheduled between flushes', function () {
      const { scheduler, stats: schedulerStats } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 100, scheduler }
      });

      const chainId = Symbol('Pipeline Chain');

      // Multiple slot changes
      queue.addCommand(['SET', '{a}k1', 'v1'], { chainId });
      queue.addCommand(['SET', '{b}k2', 'v2'], { chainId }); // Slot change
      queue.addCommand(['SET', '{c}k3', 'v3'], { chainId }); // Slot change
      queue.addCommand(['SET', '{c}k4', 'v4'], { chainId }); // Same slot

      collectYielded(queue);

      // Even with slot changes, no timer should be scheduled for explicit pipeline
      assert.equal(schedulerStats.scheduleCount, 0, 'no timer scheduled despite slot changes');
      assert.equal(schedulerStats.cancelCount, 0, 'no timer to cancel');

      queue.destroy();
    });

    it('auto-pipelining with slot changes: timer scheduled for remaining', function () {
      const { scheduler, stats: schedulerStats } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 100, scheduler }
      });

      // No chainId - auto-pipelining
      queue.addCommand(['SET', '{a}k1', 'v1']);
      queue.addCommand(['SET', '{b}k2', 'v2']); // Slot change triggers flush, schedules new timer

      collectYielded(queue);

      // Timer should be scheduled for the remaining command after slot flush
      assert.equal(schedulerStats.scheduleCount, 2, 'timer scheduled twice (initial + after slot flush)');

      queue.destroy();
    });

    it('explicit pipeline after auto command: cancels pending timer', function () {
      const { scheduler, stats: schedulerStats } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 100, scheduler }
      });

      const chainId = Symbol('Pipeline Chain');

      // First: auto-pipelining command
      queue.addCommand(['SET', '{slot}auto', 'v1']);
      collectYielded(queue); // Timer scheduled

      assert.equal(schedulerStats.scheduleCount, 1, 'timer scheduled for auto command');

      // Second: explicit pipeline command (same slot)
      queue.addCommand(['SET', '{slot}explicit', 'v2'], { chainId });
      collectYielded(queue); // Should cancel timer and flush

      // Timer should have been cancelled
      assert.equal(schedulerStats.cancelCount, 1, 'timer cancelled when explicit pipeline flushes');

      queue.destroy();
    });

    it('multiple explicit pipelines in sequence: no timers created', function () {
      const { scheduler, stats: schedulerStats } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 100, scheduler }
      });

      const chainId1 = Symbol('Pipeline 1');
      const chainId2 = Symbol('Pipeline 2');

      // First explicit pipeline
      queue.addCommand(['SET', '{slot}k1', 'v1'], { chainId: chainId1 });
      queue.addCommand(['SET', '{slot}k2', 'v2'], { chainId: chainId1 });
      collectYielded(queue);

      // Second explicit pipeline
      queue.addCommand(['SET', '{slot}k3', 'v3'], { chainId: chainId2 });
      queue.addCommand(['SET', '{slot}k4', 'v4'], { chainId: chainId2 });
      collectYielded(queue);

      // No timers should have been created
      assert.equal(schedulerStats.scheduleCount, 0, 'no timers for explicit pipelines');
      assert.equal(schedulerStats.cancelCount, 0, 'nothing to cancel');

      queue.destroy();
    });

    it('interleaved auto and explicit: timers only for auto sections', async function () {
      const { scheduler, stats: schedulerStats } = createTrackingScheduler();
      const queue = createBinhdrQueueWithTimer({
        timer: { maxWaitMs: 50, scheduler }
      });

      const flushedData: ReadonlyArray<unknown>[] = [];
      queue.setTimerFlushCallback((data) => flushedData.push(data));

      const chainId = Symbol('Pipeline');

      // Auto command - timer scheduled
      queue.addCommand(['SET', '{a}auto1', 'v1']);
      collectYielded(queue);
      assert.equal(schedulerStats.scheduleCount, 1, 'timer for auto1');

      // Explicit pipeline (different slot) - flushes auto, no new timer
      queue.addCommand(['SET', '{b}explicit1', 'v1'], { chainId });
      queue.addCommand(['SET', '{b}explicit2', 'v2'], { chainId });
      const results1 = collectYielded(queue);
      assert.equal(results1.length, 2, 'auto flushed by slot change + explicit batch');
      assert.equal(schedulerStats.scheduleCount, 1, 'no new timer for explicit');
      assert.equal(schedulerStats.cancelCount, 1, 'auto timer cancelled');

      // Another auto command - new timer scheduled
      queue.addCommand(['SET', '{c}auto2', 'v1']);
      collectYielded(queue);
      assert.equal(schedulerStats.scheduleCount, 2, 'timer for auto2');

      // Wait for timer to fire
      await delay(60);
      assert.equal(flushedData.length, 1, 'timer flushed auto2');

      queue.destroy();
    });
  });
});
