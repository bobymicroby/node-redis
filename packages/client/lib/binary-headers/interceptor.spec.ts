import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  createBinhdrInterceptor,
  passthroughInbound,
  passthroughOutbound,
  chainInbound,
} from './interceptor';
import type { InboundInterceptor, OutboundInterceptor, OutboundCommand, CommandCodec } from '../client/commands-queue';
import RedisCommandsQueue from '../client/commands-queue';
import { encodeResponseHeader } from './encoder';
import { BINHDR } from './constants';
import type { BinaryResponseHeader } from './types';

describe('Binary Headers Interceptor', function () {
  function createResponseBuffer(
    payloadLength: number,
    commandCount: number,
    clientIdx: number = 0,
    protocolError: boolean = false
  ): Buffer {
    const header: BinaryResponseHeader = {
      designator: BINHDR.DESIGNATOR,
      length: payloadLength,
      commandCount,
      clientIdx,
      protocolError,
    };
    return encodeResponseHeader(header);
  }

  function createFrame(payload: Buffer, commandCount: number = 1, clientIdx: number = 0): Buffer {
    const header = createResponseBuffer(payload.length, commandCount, clientIdx);
    return Buffer.concat([header, payload]);
  }

  describe('createBinhdrInterceptor', function () {
    describe('passthrough behavior', function () {
      it('passes through non-binary-header data unchanged', function () {
        const interceptor = createBinhdrInterceptor();
        const received: Buffer[] = [];
        const respData = Buffer.from('+OK\r\n');

        interceptor(respData, (chunk) => received.push(chunk));

        assert.equal(received.length, 1);
        assert.deepEqual(received[0], respData);
      });

      it('passes through RESP array data unchanged', function () {
        const interceptor = createBinhdrInterceptor();
        const received: Buffer[] = [];
        const respData = Buffer.from('*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n');

        interceptor(respData, (chunk) => received.push(chunk));

        assert.equal(received.length, 1);
        assert.deepEqual(received[0], respData);
      });
    });

    describe('single frame processing', function () {
      it('strips header and forwards payload for complete frame', function () {
        const interceptor = createBinhdrInterceptor();
        const received: Buffer[] = [];
        const payload = Buffer.from('+OK\r\n');
        const frame = createFrame(payload);

        interceptor(frame, (chunk) => received.push(chunk));

        assert.equal(received.length, 1);
        assert.deepEqual(received[0], payload);
      });

      it('handles empty payload', function () {
        const interceptor = createBinhdrInterceptor();
        const received: Buffer[] = [];
        const header = createResponseBuffer(0, 1);

        interceptor(header, (chunk) => received.push(chunk));

        assert.equal(received.length, 0);
      });

      it('handles large payload in single chunk', function () {
        const interceptor = createBinhdrInterceptor();
        const received: Buffer[] = [];
        const payload = Buffer.alloc(10000, 'x');
        const frame = createFrame(payload);

        interceptor(frame, (chunk) => received.push(chunk));

        assert.equal(received.length, 1);
        assert.deepEqual(received[0], payload);
      });
    });

    describe('chunked data handling', function () {
      it('handles header split across two chunks', function () {
        const interceptor = createBinhdrInterceptor();
        const received: Buffer[] = [];
        const payload = Buffer.from('+OK\r\n');
        const frame = createFrame(payload);

        const chunk1 = frame.subarray(0, 4);
        const chunk2 = frame.subarray(4);

        interceptor(chunk1, (chunk) => received.push(chunk));
        assert.equal(received.length, 0);

        interceptor(chunk2, (chunk) => received.push(chunk));
        assert.equal(received.length, 1);
        assert.deepEqual(received[0], payload);
      });

      it('handles payload split across multiple chunks', function () {
        const interceptor = createBinhdrInterceptor();
        const received: Buffer[] = [];
        const payload = Buffer.from('Hello, World!');
        const frame = createFrame(payload);

        const chunk1 = frame.subarray(0, 10);
        const chunk2 = frame.subarray(10);

        interceptor(chunk1, (chunk) => received.push(chunk));
        interceptor(chunk2, (chunk) => received.push(chunk));

        const combined = Buffer.concat(received);
        assert.deepEqual(combined, payload);
      });

      it('handles frame split at header boundary', function () {
        const interceptor = createBinhdrInterceptor();
        const received: Buffer[] = [];
        const payload = Buffer.from('+OK\r\n');
        const frame = createFrame(payload);

        const chunk1 = frame.subarray(0, 8);
        const chunk2 = frame.subarray(8);

        interceptor(chunk1, (chunk) => received.push(chunk));
        assert.equal(received.length, 0);

        interceptor(chunk2, (chunk) => received.push(chunk));
        assert.equal(received.length, 1);
        assert.deepEqual(received[0], payload);
      });

      it('handles single byte chunks', function () {
        const interceptor = createBinhdrInterceptor();
        const received: Buffer[] = [];
        const payload = Buffer.from('+OK\r\n');
        const frame = createFrame(payload);

        for (let i = 0; i < frame.length; i++) {
          interceptor(frame.subarray(i, i + 1), (chunk) => received.push(chunk));
        }

        const combined = Buffer.concat(received);
        assert.deepEqual(combined, payload);
      });
    });

    describe('multiple frames', function () {
      it('handles multiple complete frames in one chunk', function () {
        const interceptor = createBinhdrInterceptor();
        const received: Buffer[] = [];
        const payload1 = Buffer.from('+OK\r\n');
        const payload2 = Buffer.from(':123\r\n');
        const frame1 = createFrame(payload1);
        const frame2 = createFrame(payload2);
        const combined = Buffer.concat([frame1, frame2]);

        interceptor(combined, (chunk) => received.push(chunk));

        assert.equal(received.length, 2);
        assert.deepEqual(received[0], payload1);
        assert.deepEqual(received[1], payload2);
      });

      it('handles frame boundary across chunks', function () {
        const interceptor = createBinhdrInterceptor();
        const received: Buffer[] = [];
        const payload1 = Buffer.from('+OK\r\n');
        const payload2 = Buffer.from(':456\r\n');
        const frame1 = createFrame(payload1);
        const frame2 = createFrame(payload2);
        const combined = Buffer.concat([frame1, frame2]);

        const splitPoint = frame1.length + 3;
        const chunk1 = combined.subarray(0, splitPoint);
        const chunk2 = combined.subarray(splitPoint);

        interceptor(chunk1, (chunk) => received.push(chunk));
        interceptor(chunk2, (chunk) => received.push(chunk));

        assert.equal(received.length, 2);
        assert.deepEqual(received[0], payload1);
        assert.deepEqual(received[1], payload2);
      });
    });

    describe('callbacks', function () {
      it('calls onHeader for each frame', function () {
        const headers: BinaryResponseHeader[] = [];
        const interceptor = createBinhdrInterceptor({
          onHeader: (h) => headers.push(h),
        });
        const payload = Buffer.from('+OK\r\n');
        const frame = createFrame(payload, 3, 42);

        interceptor(frame, () => {});

        assert.equal(headers.length, 1);
        assert.equal(headers[0].commandCount, 3);
        assert.equal(headers[0].clientIdx, 42);
        assert.equal(headers[0].length, payload.length);
        assert.equal(headers[0].protocolError, false);
      });

      it('calls onProtocolError when protocolError flag is set', function () {
        const errors: BinaryResponseHeader[] = [];
        const interceptor = createBinhdrInterceptor({
          onProtocolError: (h) => errors.push(h),
        });

        const header: BinaryResponseHeader = {
          designator: BINHDR.DESIGNATOR,
          length: 5,
          commandCount: 1,
          clientIdx: 99,
          protocolError: true,
        };
        const headerBuf = encodeResponseHeader(header);
        const payload = Buffer.from('+OK\r\n');
        const frame = Buffer.concat([headerBuf, payload]);

        interceptor(frame, () => {});

        assert.equal(errors.length, 1);
        assert.equal(errors[0].protocolError, true);
        assert.equal(errors[0].clientIdx, 99);
      });

      it('does not call onProtocolError when flag is not set', function () {
        let errorCalled = false;
        const interceptor = createBinhdrInterceptor({
          onProtocolError: () => { errorCalled = true; },
        });
        const frame = createFrame(Buffer.from('+OK\r\n'));

        interceptor(frame, () => {});

        assert.equal(errorCalled, false);
      });
    });

    describe('mixed binary header and RESP data', function () {
      it('switches from binary header frame to regular RESP', function () {
        const interceptor = createBinhdrInterceptor();
        const received: Buffer[] = [];
        const binhdrPayload = Buffer.from('+OK\r\n');
        const respData = Buffer.from(':999\r\n');
        const frame = createFrame(binhdrPayload);
        const combined = Buffer.concat([frame, respData]);

        interceptor(combined, (chunk) => received.push(chunk));

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

        const payload = Buffer.from('+OK\r\n');
        const frame = createFrame(payload);
        const chunk1 = frame.subarray(0, 4);
        const chunk2 = frame.subarray(4);

        interceptor1(chunk1, (chunk) => received1.push(chunk));
        interceptor2(frame, (chunk) => received2.push(chunk));

        assert.equal(received2.length, 1);
        assert.equal(received1.length, 0);

        interceptor1(chunk2, (chunk) => received1.push(chunk));
        assert.equal(received1.length, 1);
      });
    });

    describe('chainInbound', function () {
      it('returns passthroughInbound for empty array', function () {
        const chained = chainInbound([]);
        const received: Buffer[] = [];
        const data = Buffer.from('hello');

        chained(data, (chunk) => received.push(chunk));

        assert.equal(received.length, 1);
        assert.deepEqual(received[0], data);
      });

      it('returns single interceptor for array of one', function () {
        const interceptor = createBinhdrInterceptor();
        const chained = chainInbound([interceptor]);

        assert.strictEqual(chained, interceptor);
      });

      it('chains two interceptors in order', function () {
        const log: string[] = [];

        const first: InboundInterceptor = (chunk, next) => {
          log.push(`first: ${chunk.toString()}`);
          next(Buffer.from(chunk.toString() + '-A'));
        };

        const second: InboundInterceptor = (chunk, next) => {
          log.push(`second: ${chunk.toString()}`);
          next(Buffer.from(chunk.toString() + '-B'));
        };

        const chained = chainInbound([first, second]);
        const received: Buffer[] = [];

        chained(Buffer.from('X'), (chunk) => received.push(chunk));

        assert.deepEqual(log, ['first: X', 'second: X-A']);
        assert.equal(received.length, 1);
        assert.equal(received[0].toString(), 'X-A-B');
      });

      it('chains three interceptors in order', function () {
        const log: string[] = [];

        const interceptors: InboundInterceptor[] = ['A', 'B', 'C'].map(
          (name) => (chunk, next) => {
            log.push(name);
            next(chunk);
          }
        );

        const chained = chainInbound(interceptors);
        const received: Buffer[] = [];

        chained(Buffer.from('data'), (chunk) => received.push(chunk));

        assert.deepEqual(log, ['A', 'B', 'C']);
        assert.equal(received.length, 1);
      });

      it('allows interceptor to call next multiple times', function () {
        const splitter: InboundInterceptor = (chunk, next) => {
          const mid = Math.floor(chunk.length / 2);
          next(chunk.subarray(0, mid));
          next(chunk.subarray(mid));
        };

        const chained = chainInbound([splitter]);
        const received: Buffer[] = [];

        chained(Buffer.from('ABCD'), (chunk) => received.push(chunk));

        assert.equal(received.length, 2);
        assert.equal(received[0].toString(), 'AB');
        assert.equal(received[1].toString(), 'CD');
      });

      it('allows interceptor to not call next (filtering)', function () {
        const filter: InboundInterceptor = (chunk, next) => {
          if (chunk[0] !== 0x00) {
            next(chunk);
          }
        };

        const chained = chainInbound([filter]);
        const received: Buffer[] = [];

        chained(Buffer.from([0x00, 0x01]), (chunk) => received.push(chunk));
        chained(Buffer.from([0x01, 0x02]), (chunk) => received.push(chunk));

        assert.equal(received.length, 1);
        assert.deepEqual(received[0], Buffer.from([0x01, 0x02]));
      });

      it('chains binhdr interceptor with custom interceptor', function () {
        const payload = Buffer.from('+OK\r\n');
        const frame = createFrame(payload);

        const uppercaser: InboundInterceptor = (chunk, next) => {
          next(Buffer.from(chunk.toString().toUpperCase()));
        };

        const chained = chainInbound([
          createBinhdrInterceptor(),
          uppercaser,
        ]);

        const received: Buffer[] = [];
        chained(frame, (chunk) => received.push(chunk));

        assert.equal(received.length, 1);
        assert.equal(received[0].toString(), '+OK\r\n');
      });
    });

    describe('passthroughInbound', function () {
      it('passes through data unchanged', function () {
        const interceptor = passthroughInbound();
        const received: Buffer[] = [];
        const data = Buffer.from('test data');

        interceptor(data, (chunk) => received.push(chunk));

        assert.equal(received.length, 1);
        assert.deepEqual(received[0], data);
      });
    });

    describe('passthroughOutbound', function () {
      it('returns command unchanged', function () {
        const interceptor = passthroughOutbound();
        const command: OutboundCommand = {
          args: ['SET', 'key', 'value'],
          encoded: ['*3\r\n', '$3\r\n', 'SET\r\n'],
        };

        const result = interceptor.process(command);

        assert.deepEqual(result, command);
      });

      it('drain returns null', function () {
        const interceptor = passthroughOutbound();

        const result = interceptor.drain();

        assert.equal(result, null);
      });
    });

    describe('Queue + Codec Integration', function () {
      function createQueue(codec?: CommandCodec): RedisCommandsQueue {
        return new RedisCommandsQueue(
          2,
          null,
          () => {},
          codec
        );
      }

      function collectYielded(queue: RedisCommandsQueue): string[] {
        const results: string[] = [];
        for (const encoded of queue.commandsToWrite()) {
          results.push(encoded.join(''));
        }
        return results;
      }

      describe('queue without codec', function () {
        it('yields encoded command directly', function () {
          const queue = createQueue();
          queue.addCommand(['PING']);

          const results = collectYielded(queue);

          assert.equal(results.length, 1);
          assert.ok(results[0].includes('PING'));
        });

        it('yields multiple commands in order', function () {
          const queue = createQueue();
          queue.addCommand(['SET', 'a', '1']);
          queue.addCommand(['SET', 'b', '2']);
          queue.addCommand(['GET', 'a']);

          const results = collectYielded(queue);

          assert.equal(results.length, 3);
          assert.ok(results[0].includes('SET'));
          assert.ok(results[0].includes('a'));
          assert.ok(results[1].includes('SET'));
          assert.ok(results[1].includes('b'));
          assert.ok(results[2].includes('GET'));
        });

        it('yields nothing when queue is empty', function () {
          const queue = createQueue();

          const results = collectYielded(queue);

          assert.equal(results.length, 0);
        });
      });

      describe('queue with passthrough codec', function () {
        it('yields encoded command unchanged', function () {
          const codec: CommandCodec = {
            outbound: passthroughOutbound(),
            inbound: passthroughInbound(),
          };
          const queue = createQueue(codec);
          queue.addCommand(['PING']);

          const results = collectYielded(queue);

          assert.equal(results.length, 1);
          assert.ok(results[0].includes('PING'));
        });
      });

      describe('queue with buffering codec', function () {
        function createBufferingCodec(maxBuffer: number): { codec: CommandCodec; getBufferSize: () => number } {
          const buffer: OutboundCommand[] = [];
          return {
            codec: {
              outbound: {
                process(command) {
                  buffer.push(command);
                  if (buffer.length >= maxBuffer) {
                    const result: OutboundCommand = {
                      args: [],
                      encoded: ['[BATCH:', ...buffer.flatMap(c => c.encoded), ']'],
                    };
                    buffer.length = 0;
                    return result;
                  }
                  return null;
                },
                drain() {
                  if (buffer.length === 0) return null;
                  const result: OutboundCommand = {
                    args: [],
                    encoded: ['[BATCH:', ...buffer.flatMap(c => c.encoded), ']'],
                  };
                  buffer.length = 0;
                  return result;
                }
              },
              inbound: passthroughInbound(),
            },
            getBufferSize: () => buffer.length,
          };
        }

        it('buffers commands and drains at end', function () {
          const { codec } = createBufferingCodec(10);
          const queue = createQueue(codec);

          queue.addCommand(['SET', 'a', '1']);
          queue.addCommand(['SET', 'b', '2']);

          const results = collectYielded(queue);

          assert.equal(results.length, 1);
          assert.ok(results[0].startsWith('[BATCH:'));
          assert.ok(results[0].endsWith(']'));
          assert.ok(results[0].includes('SET'));
        });

        it('flushes when buffer is full and drains remainder', function () {
          const { codec } = createBufferingCodec(2);
          const queue = createQueue(codec);

          queue.addCommand(['CMD1']);
          queue.addCommand(['CMD2']);
          queue.addCommand(['CMD3']);

          const results = collectYielded(queue);

          assert.equal(results.length, 2);
          assert.ok(results[0].includes('CMD1'));
          assert.ok(results[0].includes('CMD2'));
          assert.ok(results[1].includes('CMD3'));
        });

        it('drain returns null when buffer is empty', function () {
          const { codec } = createBufferingCodec(10);
          const queue = createQueue(codec);

          const results = collectYielded(queue);

          assert.equal(results.length, 0);
        });

        it('handles single command buffer', function () {
          const { codec } = createBufferingCodec(10);
          const queue = createQueue(codec);

          queue.addCommand(['SINGLE']);

          const results = collectYielded(queue);

          assert.equal(results.length, 1);
          assert.ok(results[0].includes('SINGLE'));
        });

        it('handles exact buffer size boundary', function () {
          const { codec } = createBufferingCodec(3);
          const queue = createQueue(codec);

          queue.addCommand(['A']);
          queue.addCommand(['B']);
          queue.addCommand(['C']);

          const results = collectYielded(queue);

          assert.equal(results.length, 1);
          assert.ok(results[0].includes('A'));
          assert.ok(results[0].includes('B'));
          assert.ok(results[0].includes('C'));
        });

        it('multiple batches with remainder', function () {
          const { codec } = createBufferingCodec(2);
          const queue = createQueue(codec);

          queue.addCommand(['A']);
          queue.addCommand(['B']);
          queue.addCommand(['C']);
          queue.addCommand(['D']);
          queue.addCommand(['E']);

          const results = collectYielded(queue);

          assert.equal(results.length, 3);
        });
      });


    });
  });
});
