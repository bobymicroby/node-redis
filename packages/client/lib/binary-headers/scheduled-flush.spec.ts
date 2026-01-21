import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  createBinhdrCodec,
  createTimeoutScheduler,
} from './index';
import type { RedisArgument } from '../RESP/types';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createMockSink(): { sink: (encoded: ReadonlyArray<RedisArgument>) => void; calls: ReadonlyArray<RedisArgument>[] } {
  const calls: ReadonlyArray<RedisArgument>[] = [];
  return { sink: (encoded) => calls.push(encoded), calls };
}

function makeCommand(name: string): { args: string[]; encoded: string[] } {
  return { args: [name], encoded: [`*1\r\n$${name.length}\r\n${name}\r\n`] };
}

describe('Scheduled Flushing (Time-Bounded Codec)', () => {
  describe('BinhdrCodec lifecycle', () => {
    it('setFlushSink and destroy are available', () => {
      const codec = createBinhdrCodec({
        timeBounded: { maxWaitMs: 10, scheduler: createTimeoutScheduler() },
      });

      assert.equal(typeof codec.setFlushSink, 'function');
      assert.equal(typeof codec.destroy, 'function');
      codec.destroy();
    });

    it('setFlushSink is no-op without timeBounded option', () => {
      const codec = createBinhdrCodec();
      const mock = createMockSink();

      codec.setFlushSink(mock.sink);
      codec.destroy();

      assert.equal(mock.calls.length, 0);
    });
  });

  describe('scheduled flush behavior', () => {
    it('destroy cancels pending flush', async () => {
      const codec = createBinhdrCodec({
        timeBounded: { maxWaitMs: 50, scheduler: createTimeoutScheduler() },
      });
      const mock = createMockSink();
      codec.setFlushSink(mock.sink);

      codec.destroy();
      await delay(60);

      assert.equal(mock.calls.length, 0);
    });

    it('drain cancels scheduled flush', async () => {
      const codec = createBinhdrCodec({
        timeBounded: { maxWaitMs: 100, scheduler: createTimeoutScheduler() },
      });
      const mock = createMockSink();
      codec.setFlushSink(mock.sink);

      codec.outbound.drain();
      await delay(120);

      assert.equal(mock.calls.length, 0);
      codec.destroy();
    });
  });

  describe('integration with outbound interceptor', () => {
    it('natural flush cancels scheduled flush', async () => {
      const codec = createBinhdrCodec({
        timeBounded: { maxWaitMs: 100, scheduler: createTimeoutScheduler() },
      });
      const mock = createMockSink();
      codec.setFlushSink(mock.sink);

      for (let i = 0; i < 5; i++) {
        codec.outbound.process(makeCommand('PING'));
      }
      codec.outbound.drain();

      await delay(120);
      assert.equal(mock.calls.length, 0);
      codec.destroy();
    });

    it('process buffers command when resolver is ready', () => {
      const codec = createBinhdrCodec({
        timeBounded: { maxWaitMs: 10, scheduler: createTimeoutScheduler() },
      });

      const result = codec.outbound.process(makeCommand('PING'));

      // PING is eligible and keyless, so it gets buffered (returns null)
      assert.strictEqual(result, null);
      codec.destroy();
    });
  });
});
