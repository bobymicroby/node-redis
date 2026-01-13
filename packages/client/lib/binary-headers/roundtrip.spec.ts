import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { BINHDR } from './constants';
import { createRequestHeader, encodeRequestHeader, encodeRequestHeaderInto, encodeResponseHeader } from './encoder';
import { parseRequestHeader, parseResponseHeader } from './decoder';
import { createResponseHeader } from './test-utils';

describe('Binary Headers Round-trip', () => {
  describe('Request Header: encode → decode', () => {
    const testCases: Array<{
      name: string;
      length: number;
      commandCount: number;
      slot: number;
      clientIdx: number;
    }> = [
      { name: 'minimum values', length: 0, commandCount: 1, slot: 0, clientIdx: 0 },
      { name: 'maximum values', length: BINHDR.MAX_PAYLOAD_LENGTH, commandCount: 127, slot: BINHDR.SLOT_MAX_VALID, clientIdx: BINHDR.MAX_CLIENT_IDX },
      { name: 'SLOT_NO_SLOT', length: 100, commandCount: 5, slot: BINHDR.SLOT_NO_SLOT, clientIdx: 42 },
      { name: 'spec example', length: 159, commandCount: 6, slot: 16287, clientIdx: 100 },
      { name: 'single command', length: 10, commandCount: 1, slot: 0, clientIdx: 1 },
      { name: 'max commands', length: 5000, commandCount: 127, slot: 8192, clientIdx: 255 },
      { name: 'slot boundary low', length: 50, commandCount: 3, slot: 0, clientIdx: 100 },
      { name: 'slot boundary high', length: 50, commandCount: 3, slot: 16383, clientIdx: 100 },
      { name: 'clientIdx boundary', length: 100, commandCount: 1, slot: 1000, clientIdx: 65535 },
      { name: 'mid-range all fields', length: 0x12345678, commandCount: 64, slot: 8000, clientIdx: 32768 },
      { name: 'alternating pattern', length: 0x55555555, commandCount: 85, slot: 0x1555, clientIdx: 0x5555 },
      { name: 'length near max', length: 0x7FFFFFFE, commandCount: 10, slot: 12345, clientIdx: 54321 },
    ];

    for (const { name, length, commandCount, slot, clientIdx } of testCases) {
      it(`round-trips with encodeRequestHeader: ${name}`, () => {
        const createResult = createRequestHeader(length, commandCount, slot, clientIdx);
        assert.equal(createResult.success, true);
        if (!createResult.success) return;

        const encoded = encodeRequestHeader(createResult.header);
        const parseResult = parseRequestHeader(encoded);

        assert.equal(parseResult.success, true);
        if (parseResult.success) {
          assert.deepEqual(parseResult.header, createResult.header);
        }
      });

      it(`round-trips with encodeRequestHeaderInto: ${name}`, () => {
        const createResult = createRequestHeader(length, commandCount, slot, clientIdx);
        assert.equal(createResult.success, true);
        if (!createResult.success) return;

        const buffer = Buffer.alloc(BINHDR.REQUEST_HEADER_SIZE);
        const encodeResult = encodeRequestHeaderInto(createResult.header, buffer, 0);
        assert.equal(encodeResult.success, true);

        const parseResult = parseRequestHeader(buffer, 0);

        assert.equal(parseResult.success, true);
        if (parseResult.success) {
          assert.deepEqual(parseResult.header, createResult.header);
        }
      });

      it(`round-trips with encodeRequestHeaderInto at offset: ${name}`, () => {
        const createResult = createRequestHeader(length, commandCount, slot, clientIdx);
        assert.equal(createResult.success, true);
        if (!createResult.success) return;

        const offset = 5;
        const buffer = Buffer.alloc(offset + BINHDR.REQUEST_HEADER_SIZE + 3);
        const encodeResult = encodeRequestHeaderInto(createResult.header, buffer, offset);
        assert.equal(encodeResult.success, true);

        const parseResult = parseRequestHeader(buffer, offset);

        assert.equal(parseResult.success, true);
        if (parseResult.success) {
          assert.deepEqual(parseResult.header, createResult.header);
        }
      });
    }
  });

  describe('Request Header: decode → encode (bytes round-trip)', () => {
    const testCases: Array<{
      name: string;
      bytes: Buffer;
    }> = [
      {
        name: 'minimum values',
        bytes: Buffer.from([0x80, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
      },
      {
        name: 'spec example',
        bytes: Buffer.from([0x80, 0x00, 0x00, 0x00, 0x9F, 0x06, 0x3F, 0x9F, 0x00, 0x64]),
      },
      {
        name: 'SLOT_NO_SLOT',
        bytes: Buffer.from([0x80, 0x00, 0x00, 0x00, 0x64, 0x05, 0xFF, 0xFF, 0x00, 0x2A]),
      },
      {
        name: 'max values',
        bytes: Buffer.from([0x80, 0x7F, 0xFF, 0xFF, 0xFF, 0x7F, 0x3F, 0xFF, 0xFF, 0xFF]),
      },
      {
        name: 'big-endian length',
        bytes: Buffer.from([0x80, 0x12, 0x34, 0x56, 0x78, 0x01, 0x00, 0x00, 0x00, 0x00]),
      },
      {
        name: 'big-endian slot',
        bytes: Buffer.from([0x80, 0x00, 0x00, 0x00, 0x00, 0x01, 0x12, 0x34, 0x00, 0x00]),
      },
      {
        name: 'big-endian clientIdx',
        bytes: Buffer.from([0x80, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0xAB, 0xCD]),
      },
    ];

    for (const { name, bytes } of testCases) {
      it(`round-trips bytes: ${name}`, () => {
        const parseResult = parseRequestHeader(bytes);
        assert.equal(parseResult.success, true);
        if (!parseResult.success) return;

        const reEncoded = encodeRequestHeader(parseResult.header);
        assert.deepEqual(reEncoded, bytes);
      });
    }
  });

  describe('Response Header: encode → decode', () => {
    const testCases: Array<{
      name: string;
      header: BinaryResponseHeader;
    }> = [
      { name: 'minimum values', header: createResponseHeader(0, 1, 0, false) },
      { name: 'maximum values', header: createResponseHeader(BINHDR.MAX_PAYLOAD_LENGTH, 127, BINHDR.MAX_CLIENT_IDX, false) },
      { name: 'typical without error', header: createResponseHeader(159, 6, 100, false) },
      { name: 'typical with error', header: createResponseHeader(50, 3, 42, true) },
      { name: 'single command', header: createResponseHeader(10, 1, 1, false) },
      { name: 'max commands', header: createResponseHeader(5000, 127, 255, false) },
      { name: 'error max commands', header: createResponseHeader(100, 127, 1000, true) },
      { name: 'zero length', header: createResponseHeader(0, 5, 500, false) },
      { name: 'large length', header: createResponseHeader(0x7FFFFFFE, 10, 12345, false) },
      { name: 'clientIdx low', header: createResponseHeader(100, 1, 0, false) },
      { name: 'clientIdx high', header: createResponseHeader(100, 1, 65535, false) },
      { name: 'mid-range', header: createResponseHeader(0x12345678, 64, 0x8000, false) },
      { name: 'spec example', header: createResponseHeader(50, 3, 42, false) },
    ];

    for (const { name, header } of testCases) {
      it(`round-trips: ${name}`, () => {
        const encoded = encodeResponseHeader(header);
        const result = parseResponseHeader(encoded);

        assert.equal(result.success, true);
        if (result.success) {
          assert.deepEqual(result.header, header);
        }
      });
    }
  });

  describe('Response Header: decode → encode (bytes round-trip)', () => {
    const testCases: Array<{
      name: string;
      bytes: Buffer;
    }> = [
      { name: 'minimum values', bytes: Buffer.from([0x80, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]) },
      { name: 'spec example', bytes: Buffer.from([0x80, 0x00, 0x00, 0x00, 0x32, 0x03, 0x00, 0x2A]) },
      { name: 'with error bit', bytes: Buffer.from([0x80, 0x00, 0x00, 0x00, 0x64, 0x83, 0x00, 0x05]) },
      { name: 'max count', bytes: Buffer.from([0x80, 0x00, 0x00, 0x00, 0x00, 0x7F, 0x00, 0x00]) },
      { name: 'max count + error', bytes: Buffer.from([0x80, 0x00, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00]) },
      { name: 'big-endian length', bytes: Buffer.from([0x80, 0x12, 0x34, 0x56, 0x78, 0x01, 0xAB, 0xCD]) },
      { name: 'max length', bytes: Buffer.from([0x80, 0x7F, 0xFF, 0xFF, 0xFF, 0x01, 0xFF, 0xFF]) },
    ];

    for (const { name, bytes } of testCases) {
      it(`round-trips bytes: ${name}`, () => {
        const result = parseResponseHeader(bytes);
        assert.equal(result.success, true);
        if (!result.success) return;

        const reEncoded = encodeResponseHeader(result.header);
        assert.deepEqual(reEncoded, bytes);
      });
    }
  });

  describe('Field preservation', () => {
    it('preserves all request header length values through round-trip', () => {
      const lengths = [0, 1, 255, 256, 65535, 65536, 0x00FFFFFF, 0x7FFFFFFF];

      for (const length of lengths) {
        const result = createRequestHeader(length, 1, 0, 0);
        assert.equal(result.success, true);
        if (!result.success) continue;

        const encoded = encodeRequestHeader(result.header);
        const parseResult = parseRequestHeader(encoded);

        assert.equal(parseResult.success, true);
        if (parseResult.success) {
          assert.equal(parseResult.header.length, length, `length 0x${length.toString(16)} preserved`);
        }
      }
    });

    it('preserves all request header slot values through round-trip', () => {
      const slots = [0, 1, 8191, 8192, 16383, BINHDR.SLOT_NO_SLOT];

      for (const slot of slots) {
        const result = createRequestHeader(100, 1, slot, 0);
        assert.equal(result.success, true);
        if (!result.success) continue;

        const encoded = encodeRequestHeader(result.header);
        const parseResult = parseRequestHeader(encoded);

        assert.equal(parseResult.success, true);
        if (parseResult.success) {
          assert.equal(parseResult.header.slot, slot, `slot 0x${slot.toString(16)} preserved`);
        }
      }
    });

    it('preserves all commandCount values (1-127) for request headers', () => {
      for (let count = 1; count <= 127; count++) {
        const result = createRequestHeader(100, count, 0, 0);
        assert.equal(result.success, true);
        if (!result.success) continue;

        const encoded = encodeRequestHeader(result.header);
        const parseResult = parseRequestHeader(encoded);

        assert.equal(parseResult.success, true);
        if (parseResult.success) {
          assert.equal(parseResult.header.commandCount, count);
        }
      }
    });

    it('preserves all commandCount values (1-127) for response headers', () => {
      for (let count = 1; count <= 127; count++) {
        const header = createResponseHeader(100, count, 0, false);
        const encoded = encodeResponseHeader(header);
        const result = parseResponseHeader(encoded);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.commandCount, count);
        }
      }
    });

    it('preserves protocolError independently of commandCount', () => {
      for (let count = 1; count <= 127; count++) {
        const noError = createResponseHeader(100, count, 0, false);
        const withError = createResponseHeader(100, count, 0, true);

        const encodedNoError = encodeResponseHeader(noError);
        const encodedWithError = encodeResponseHeader(withError);

        const resultNoError = parseResponseHeader(encodedNoError);
        const resultWithError = parseResponseHeader(encodedWithError);

        assert.equal(resultNoError.success, true);
        assert.equal(resultWithError.success, true);

        if (resultNoError.success && resultWithError.success) {
          assert.equal(resultNoError.header.commandCount, count);
          assert.equal(resultNoError.header.protocolError, false);
          assert.equal(resultWithError.header.commandCount, count);
          assert.equal(resultWithError.header.protocolError, true);
        }
      }
    });
  });
});
