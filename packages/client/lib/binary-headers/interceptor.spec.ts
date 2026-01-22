import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  createBinhdrInterceptor,
  passthroughInbound,
  passthroughOutbound,
  chainInbound,
} from './interceptor';
import type { InboundInterceptor, OutboundCommand } from '../client/commands-queue';
import RedisCommandsQueue from '../client/commands-queue';
import BinhdrCommandsQueue from './binhdr-commands-queue';
import { ResponseHeaderEncoder, type ResponseHeader as BinaryResponseHeader } from './generated/response-header-codec';
import { RequestHeaderDecoder } from './generated/request-header-codec';
import { createBinhdrFrame, parseRespCommands } from './test-utils';
import { STATIC_RESOLVER } from './eligibility-static-data';

function collect(interceptor: InboundInterceptor, data: Buffer): Buffer[] {
  const received: Buffer[] = [];
  interceptor(data, (chunk) => received.push(chunk));
  return received;
}

describe('Binary Headers Interceptor', function () {
  describe('createBinhdrInterceptor', function () {
    describe('passthrough behavior', function () {
      const passthroughCases = [
        { name: 'simple string', data: Buffer.from('+OK\r\n') },
        { name: 'RESP array', data: Buffer.from('*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n') },
      ];

      for (const { name, data } of passthroughCases) {
        it(`passes through ${name} unchanged`, function () {
          const received = collect(createBinhdrInterceptor(), data);
          assert.equal(received.length, 1);
          assert.deepEqual(received[0], data);
        });
      }
    });

    describe('single frame processing', function () {
      it('strips header and forwards payload', function () {
        const payload = Buffer.from('+OK\r\n');
        const received = collect(createBinhdrInterceptor(), createBinhdrFrame(payload));
        assert.equal(received.length, 1);
        assert.deepEqual(received[0], payload);
      });

      it('handles empty payload', function () {
        const header = ResponseHeaderEncoder.allocateAndEncode(0, 1, false, 0);
        const received = collect(createBinhdrInterceptor(), header);
        assert.equal(received.length, 0);
      });

      it('handles large payload', function () {
        const payload = Buffer.alloc(10000, 'x');
        const received = collect(createBinhdrInterceptor(), createBinhdrFrame(payload));
        assert.deepEqual(received[0], payload);
      });
    });

    describe('chunked data handling', function () {
      const chunkingCases = [
        { name: 'header split at byte 4', splitAt: 4 },
        { name: 'split at header boundary', splitAt: 16 },
        { name: 'payload split mid-stream', splitAt: 20 },
      ];

      for (const { name, splitAt } of chunkingCases) {
        it(`handles ${name}`, function () {
          const interceptor = createBinhdrInterceptor();
          const payload = Buffer.from('+OK\r\n');
          const frame = createBinhdrFrame(payload);
          const received: Buffer[] = [];

          interceptor(frame.subarray(0, splitAt), (c) => received.push(c));
          interceptor(frame.subarray(splitAt), (c) => received.push(c));

          const combined = Buffer.concat(received);
          assert.deepEqual(combined, payload);
        });
      }

      it('handles single byte chunks', function () {
        const interceptor = createBinhdrInterceptor();
        const payload = Buffer.from('+OK\r\n');
        const frame = createBinhdrFrame(payload);
        const received: Buffer[] = [];

        for (let i = 0; i < frame.length; i++) {
          interceptor(frame.subarray(i, i + 1), (c) => received.push(c));
        }

        assert.deepEqual(Buffer.concat(received), payload);
      });
    });

    describe('multiple frames', function () {
      it('handles multiple complete frames in one chunk', function () {
        const payload1 = Buffer.from('+OK\r\n');
        const payload2 = Buffer.from(':123\r\n');
        const combined = Buffer.concat([createBinhdrFrame(payload1), createBinhdrFrame(payload2)]);

        const received = collect(createBinhdrInterceptor(), combined);

        assert.equal(received.length, 2);
        assert.deepEqual(received[0], payload1);
        assert.deepEqual(received[1], payload2);
      });

      it('handles frame boundary across chunks', function () {
        const interceptor = createBinhdrInterceptor();
        const payload1 = Buffer.from('+OK\r\n');
        const payload2 = Buffer.from(':456\r\n');
        const frame1 = createBinhdrFrame(payload1);
        const frame2 = createBinhdrFrame(payload2);
        const combined = Buffer.concat([frame1, frame2]);
        const splitPoint = frame1.length + 3;
        const received: Buffer[] = [];

        interceptor(combined.subarray(0, splitPoint), (c) => received.push(c));
        interceptor(combined.subarray(splitPoint), (c) => received.push(c));

        assert.deepEqual(received[0], payload1);
        assert.deepEqual(received[1], payload2);
      });
    });

    describe('callbacks', function () {
      it('calls onHeader for each frame', function () {
        const headers: BinaryResponseHeader[] = [];
        const interceptor = createBinhdrInterceptor({ onHeader: (h) => headers.push(h) });
        const payload = Buffer.from('+OK\r\n');

        interceptor(createBinhdrFrame(payload, 3, 42), () => {});

        assert.equal(headers.length, 1);
        assert.equal(headers[0].commandCount, 3);
        assert.equal(headers[0].requestId, 42);
        assert.equal(headers[0].length, payload.length);
      });

      it('calls onProtocolError when flag is set', function () {
        const errors: BinaryResponseHeader[] = [];
        const interceptor = createBinhdrInterceptor({ onProtocolError: (h) => errors.push(h) });

        interceptor(createBinhdrFrame(Buffer.from('+OK\r\n'), 1, 99, true), () => {});

        assert.equal(errors.length, 1);
        assert.equal(errors[0].protocolError, true);
        assert.equal(errors[0].requestId, 99);
      });

      it('does not call onProtocolError when flag is not set', function () {
        let called = false;
        const interceptor = createBinhdrInterceptor({ onProtocolError: () => { called = true; } });

        interceptor(createBinhdrFrame(Buffer.from('+OK\r\n')), () => {});

        assert.equal(called, false);
      });
    });

    describe('mixed binary header and RESP data', function () {
      it('switches from binary header frame to regular RESP', function () {
        const binhdrPayload = Buffer.from('+OK\r\n');
        const respData = Buffer.from(':999\r\n');
        const combined = Buffer.concat([createBinhdrFrame(binhdrPayload), respData]);

        const received = collect(createBinhdrInterceptor(), combined);

        assert.equal(received.length, 2);
        assert.deepEqual(received[0], binhdrPayload);
        assert.deepEqual(received[1], respData);
      });
    });

    describe('state isolation', function () {
      it('maintains separate state per interceptor instance', function () {
        const interceptor1 = createBinhdrInterceptor();
        const interceptor2 = createBinhdrInterceptor();
        const received1: Buffer[] = [];
        const received2: Buffer[] = [];
        const frame = createBinhdrFrame(Buffer.from('+OK\r\n'));

        interceptor1(frame.subarray(0, 4), (c) => received1.push(c));
        interceptor2(frame, (c) => received2.push(c));

        assert.equal(received1.length, 0);
        assert.equal(received2.length, 1);

        interceptor1(frame.subarray(4), (c) => received1.push(c));
        assert.equal(received1.length, 1);
      });
    });
  });

  describe('chainInbound', function () {
    it('returns passthroughInbound for empty array', function () {
      const chained = chainInbound([]);
      const received = collect(chained, Buffer.from('hello'));
      assert.deepEqual(received[0], Buffer.from('hello'));
    });

    it('returns single interceptor for array of one', function () {
      const interceptor = createBinhdrInterceptor();
      assert.strictEqual(chainInbound([interceptor]), interceptor);
    });

    it('chains interceptors in order', function () {
      const log: string[] = [];
      const interceptors: InboundInterceptor[] = ['A', 'B', 'C'].map(
        (name) => (chunk, next) => { log.push(name); next(chunk); }
      );

      const received = collect(chainInbound(interceptors), Buffer.from('data'));

      assert.deepEqual(log, ['A', 'B', 'C']);
      assert.equal(received.length, 1);
    });

    it('allows interceptor to call next multiple times (splitting)', function () {
      const splitter: InboundInterceptor = (chunk, next) => {
        const mid = Math.floor(chunk.length / 2);
        next(chunk.subarray(0, mid));
        next(chunk.subarray(mid));
      };

      const received = collect(chainInbound([splitter]), Buffer.from('ABCD'));

      assert.equal(received.length, 2);
      assert.equal(received[0].toString(), 'AB');
      assert.equal(received[1].toString(), 'CD');
    });

    it('allows interceptor to filter (not call next)', function () {
      const filter: InboundInterceptor = (chunk, next) => {
        if (chunk[0] !== 0x00) next(chunk);
      };
      const chained = chainInbound([filter]);
      const received: Buffer[] = [];

      chained(Buffer.from([0x00, 0x01]), (c) => received.push(c));
      chained(Buffer.from([0x01, 0x02]), (c) => received.push(c));

      assert.equal(received.length, 1);
      assert.deepEqual(received[0], Buffer.from([0x01, 0x02]));
    });
  });

  describe('passthroughInbound', function () {
    it('passes through data unchanged', function () {
      const data = Buffer.from('test data');
      const received = collect(passthroughInbound(), data);
      assert.deepEqual(received[0], data);
    });
  });

  describe('passthroughOutbound', function () {
    it('returns command unchanged', function () {
      const interceptor = passthroughOutbound();
      const command: OutboundCommand = { args: ['SET', 'key', 'value'], encoded: ['*3\r\n'] };
      assert.deepEqual(interceptor.process(command), command);
    });

    it('drain returns null', function () {
      assert.equal(passthroughOutbound().drain(), null);
    });
  });

  describe('Queue + Codec Integration', function () {
    function createQueue(): RedisCommandsQueue {
      return new RedisCommandsQueue(2, null, () => {});
    }

    function createQueueWithBinhdr(useStaticResolver: boolean): BinhdrCommandsQueue {
      return new BinhdrCommandsQueue(2, null, () => {}, useStaticResolver ? { resolver: STATIC_RESOLVER } : {});
    }

    function collectYielded(queue: RedisCommandsQueue): unknown[][] {
      const results: unknown[][] = [];
      for (const encoded of queue.commandsToWrite()) {
        results.push(parseRespCommands(encoded.join('')) as unknown[][]);
      }
      return results;
    }

    describe('queue without codec', function () {
      const queueCases = [
        { name: 'single command', commands: [['PING']], expected: [[['PING']]] },
        { name: 'multiple commands', commands: [['SET', 'a', '1'], ['GET', 'a']], expected: [[['SET', 'a', '1']], [['GET', 'a']]] },
        { name: 'empty queue', commands: [], expected: [] },
      ];

      for (const { name, commands, expected } of queueCases) {
        it(name, function () {
          const queue = createQueue();
          commands.forEach((cmd) => queue.addCommand(cmd));
          assert.deepEqual(collectYielded(queue), expected);
        });
      }
    });

    describe('queue with binhdr codec (passthrough resolver)', function () {
      const passthroughCases = [
        { name: 'single command', commands: [['PING']], expected: [[['PING']]] },
        { name: 'multiple commands', commands: [['SET', 'a', '1'], ['GET', 'a']], expected: [[['SET', 'a', '1']], [['GET', 'a']]] },
      ];

      for (const { name, commands, expected } of passthroughCases) {
        it(name, function () {
          const queue = createQueueWithBinhdr(false);
          commands.forEach((cmd) => queue.addCommand(cmd));
          assert.deepEqual(collectYielded(queue), expected);
        });
      }
    });

    describe('queue with binhdr codec (default resolver)', function () {
      const binhdrCases = [
        { name: 'single command', commands: [['PING']], expectedYields: 1, expectedCommandCount: 1 },
        { name: 'multiple commands batched', commands: [['PING'], ['PING'], ['PING']], expectedYields: 1, expectedCommandCount: 3 },
      ];

      for (const { name, commands, expectedYields, expectedCommandCount } of binhdrCases) {
        it(name, function () {
          const queue = createQueueWithBinhdr(true);
          commands.forEach((cmd) => queue.addCommand(cmd));

          const results: ReadonlyArray<unknown>[] = [];
          for (const encoded of queue.commandsToWrite()) {
            results.push(encoded);
          }

          assert.equal(results.length, expectedYields);
          const decoder = new RequestHeaderDecoder().wrap(results[0][0] as Buffer, 0);
          assert.ok(decoder.isValid());
          assert.equal(decoder.commandCount(), expectedCommandCount);
        });
      }
    });
  });
});
