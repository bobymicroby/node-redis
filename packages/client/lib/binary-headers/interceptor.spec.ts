import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { createBinhdrInterceptor } from './interceptor';
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
  });
});
