import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  RequestHeaderEncoder,
  RequestHeaderDecoder,
} from './generated/request-header-codec';
import {
  ResponseHeaderEncoder,
  ResponseHeaderDecoder,
} from './generated/response-header-codec';

describe.skip('RequestHeader (v1)', () => {
  const roundTripCases = [
    { name: 'minimum', slot: 0, length: 0, commandCount: 1, requestId: 0 },
    { name: 'maximum', slot: 0x3FFF, length: 0xFFFFFFFF, commandCount: 0x7F, requestId: 0xFFFFFFFF },
    { name: 'typical', slot: 1000, length: 159, commandCount: 6, requestId: 42 },
    { name: 'null slot', slot: 0xFFFF, length: 100, commandCount: 1, requestId: 1 },
  ];

  for (const tc of roundTripCases) {
    it(`round-trip: ${tc.name}`, () => {
      const buffer = Buffer.alloc(RequestHeaderEncoder.ENCODED_LENGTH);
      RequestHeaderEncoder.encodeInto(buffer, 0, tc.slot, tc.length, tc.commandCount, tc.requestId);

      const decoder = new RequestHeaderDecoder().wrap(buffer, 0);
      assert.strictEqual(decoder.slot(), tc.slot);
      assert.strictEqual(decoder.length(), tc.length);
      assert.strictEqual(decoder.commandCount(), tc.commandCount);
      assert.strictEqual(decoder.requestId(), tc.requestId);
    });
  }

  it('encodes fixed fields (designator=0xAE, version=0x01)', () => {
    const buffer = RequestHeaderEncoder.allocateAndEncode(0, 0, 1, 0);
    assert.strictEqual(buffer[0], 0xAE);
    assert.strictEqual(buffer[1], 0x01);
  });

  const validationCases = [
    { name: 'valid header', setup: (b: Buffer) => {}, expected: true },
    { name: 'invalid designator', setup: (b: Buffer) => { b[0] = 0x00; }, expected: false },
    { name: 'buffer too small', setup: () => Buffer.alloc(4), expected: false },
  ];

  for (const tc of validationCases) {
    it(`isValid: ${tc.name}`, () => {
      const buffer = typeof tc.setup === 'function' && tc.setup.length === 0
        ? (tc.setup as () => Buffer)()
        : RequestHeaderEncoder.allocateAndEncode(0, 0, 1, 0);
      if (typeof tc.setup === 'function' && tc.setup.length === 1) {
        (tc.setup as (b: Buffer) => void)(buffer);
      }
      assert.strictEqual(new RequestHeaderDecoder().wrap(buffer, 0).isValid(), tc.expected);
    });
  }

  it('encodes at non-zero offset', () => {
    const offset = 10;
    const buffer = Buffer.alloc(offset + RequestHeaderEncoder.ENCODED_LENGTH);
    RequestHeaderEncoder.encodeInto(buffer, offset, 1234, 5678, 5, 9999);

    const decoder = new RequestHeaderDecoder().wrap(buffer, offset);
    assert.strictEqual(decoder.slot(), 1234);
    assert.strictEqual(decoder.requestId(), 9999);
  });
});

describe.skip('ResponseHeader (v1)', () => {
  const roundTripCases = [
    { name: 'minimum', length: 0, commandCount: 1, protocolError: false, requestId: 0 },
    { name: 'maximum', length: 0xFFFFFFFF, commandCount: 0x7F, protocolError: true, requestId: 0xFFFFFFFF },
    { name: 'with error', length: 100, commandCount: 5, protocolError: true, requestId: 42 },
    { name: 'typical', length: 256, commandCount: 10, protocolError: false, requestId: 1000 },
  ];

  for (const tc of roundTripCases) {
    it(`round-trip: ${tc.name}`, () => {
      const buffer = Buffer.alloc(ResponseHeaderEncoder.ENCODED_LENGTH);
      ResponseHeaderEncoder.encodeInto(buffer, 0, tc.length, tc.commandCount, tc.protocolError, tc.requestId);

      const decoder = new ResponseHeaderDecoder().wrap(buffer, 0);
      assert.strictEqual(decoder.length(), tc.length);
      assert.strictEqual(decoder.commandCount(), tc.commandCount);
      assert.strictEqual(decoder.protocolError(), tc.protocolError);
      assert.strictEqual(decoder.requestId(), tc.requestId);
    });
  }

  it('encodes flags byte correctly (commandCount | protocolError)', () => {
    const buffer = Buffer.alloc(ResponseHeaderEncoder.ENCODED_LENGTH);
    ResponseHeaderEncoder.encodeInto(buffer, 0, 0, 0x35, true, 0);
    assert.strictEqual(buffer[8], 0x35 | 0x80);
  });

  it('rejects buffer too small', () => {
    assert.strictEqual(new ResponseHeaderDecoder().wrap(Buffer.alloc(4), 0).isValid(), false);
  });
});

describe.skip('utility functions (v1)', () => {
  const designatorCases = [
    { byte: 0xAE, expected: true },
    { byte: 0x00, expected: false },
    { byte: 0x80, expected: false },
  ];

  for (const tc of designatorCases) {
    it(`isRequestHeaderDesignator(0x${tc.byte.toString(16)}) = ${tc.expected}`, () => {
      const expected = tc.byte === RequestHeaderDecoder.designatorConstantValue();
      assert.strictEqual(expected, tc.expected);
      assert.strictEqual(tc.byte === ResponseHeaderDecoder.designatorConstantValue(), tc.expected);
    });
  }

  it('startsWithBinaryHeader', () => {
    assert.strictEqual(RequestHeaderDecoder.startsWithBinaryHeader(Buffer.from([0xAE, 0x01])), true);
    assert.strictEqual(RequestHeaderDecoder.startsWithBinaryHeader(Buffer.from([0x00, 0x01])), false);
    assert.strictEqual(RequestHeaderDecoder.startsWithBinaryHeader(Buffer.alloc(0)), false);
  });

  it('peekDesignator', () => {
    assert.strictEqual(RequestHeaderDecoder.peekDesignator(Buffer.from([0xAE])), 0xAE);
    assert.strictEqual(RequestHeaderDecoder.peekDesignator(Buffer.alloc(0)), null);
  });
});

describe.skip('flyweight reuse (v1)', () => {
  it('encoder/decoder can process multiple buffers sequentially', () => {
    const encoder = new RequestHeaderEncoder();
    const decoder = new RequestHeaderDecoder();
    const buf1 = Buffer.alloc(16);
    const buf2 = Buffer.alloc(16);

    encoder.wrapAndWrite(buf1, 0).slot(100).length(200).commandCount(1).requestId(1);
    encoder.wrapAndWrite(buf2, 0).slot(300).length(400).commandCount(2).requestId(2);

    assert.strictEqual(decoder.wrap(buf1, 0).slot(), 100);
    assert.strictEqual(decoder.wrap(buf2, 0).slot(), 300);
  });
});

describe.skip('toObject conversion (v1)', () => {
  it('RequestHeaderDecoder.toObject returns plain object', () => {
    const buffer = RequestHeaderEncoder.allocateAndEncode(1000, 500, 5, 42);
    const obj = new RequestHeaderDecoder().wrap(buffer, 0).toObject();

    assert.strictEqual(obj.designator, 0xAE);
    assert.strictEqual(obj.version, 1);
    assert.strictEqual(obj.slot, 1000);
    assert.strictEqual(obj.length, 500);
    assert.strictEqual(obj.commandCount, 5);
    assert.strictEqual(obj.requestId, 42);
  });

  it('ResponseHeaderDecoder.toObject returns plain object', () => {
    const buffer = ResponseHeaderEncoder.allocateAndEncode(500, 3, true, 99);
    const obj = new ResponseHeaderDecoder().wrap(buffer, 0).toObject();

    assert.strictEqual(obj.designator, 0xAE);
    assert.strictEqual(obj.version, 1);
    assert.strictEqual(obj.length, 500);
    assert.strictEqual(obj.commandCount, 3);
    assert.strictEqual(obj.protocolError, true);
    assert.strictEqual(obj.requestId, 99);
  });
});
