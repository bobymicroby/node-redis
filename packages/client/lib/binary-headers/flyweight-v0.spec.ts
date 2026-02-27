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

describe('RequestHeader (v0)', () => {
  const roundTripCases = [
    { name: 'minimum', length: 0, commandCount: 1, slot: 0, clientIdx: 0 },
    { name: 'maximum', length: 0x7FFFFFFF, commandCount: 0x7F, slot: 0x3FFF, clientIdx: 0xFFFF },
    { name: 'typical', length: 159, commandCount: 6, slot: 1000, clientIdx: 42 },
    { name: 'null slot', length: 100, commandCount: 1, slot: 0xFFFF, clientIdx: 1 },
  ];

  for (const tc of roundTripCases) {
    it(`round-trip: ${tc.name}`, () => {
      const buffer = Buffer.alloc(RequestHeaderEncoder.ENCODED_LENGTH);
      RequestHeaderEncoder.encodeInto(buffer, 0, tc.length, tc.commandCount, tc.slot, tc.clientIdx);

      const decoder = new RequestHeaderDecoder().wrap(buffer, 0);
      assert.strictEqual(decoder.length(), tc.length);
      assert.strictEqual(decoder.commandCount(), tc.commandCount);
      assert.strictEqual(decoder.slot(), tc.slot);
      assert.strictEqual(decoder.clientIdx(), tc.clientIdx);
    });
  }

  it('encodes fixed field (designator=0x80)', () => {
    const buffer = RequestHeaderEncoder.allocateAndEncode(0, 1, 0, 0);
    assert.strictEqual(buffer[0], 0x80);
  });

  it('ENCODED_LENGTH is 10 bytes', () => {
    assert.strictEqual(RequestHeaderEncoder.ENCODED_LENGTH, 10);
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
        : RequestHeaderEncoder.allocateAndEncode(0, 1, 0, 0);
      if (typeof tc.setup === 'function' && tc.setup.length === 1) {
        (tc.setup as (b: Buffer) => void)(buffer);
      }
      assert.strictEqual(new RequestHeaderDecoder().wrap(buffer, 0).isValid(), tc.expected);
    });
  }

  it('encodes at non-zero offset', () => {
    const offset = 10;
    const buffer = Buffer.alloc(offset + RequestHeaderEncoder.ENCODED_LENGTH);
    RequestHeaderEncoder.encodeInto(buffer, offset, 5678, 5, 1234, 9999);

    const decoder = new RequestHeaderDecoder().wrap(buffer, offset);
    assert.strictEqual(decoder.length(), 5678);
    assert.strictEqual(decoder.commandCount(), 5);
    assert.strictEqual(decoder.slot(), 1234);
    assert.strictEqual(decoder.clientIdx(), 9999);
  });
});

describe('ResponseHeader (v0)', () => {
  const roundTripCases = [
    { name: 'minimum', length: 0, commandCount: 1, protocolError: false, clientIdx: 0 },
    { name: 'maximum', length: 0x7FFFFFFF, commandCount: 0x7F, protocolError: true, clientIdx: 0xFFFF },
    { name: 'with error', length: 100, commandCount: 5, protocolError: true, clientIdx: 42 },
    { name: 'typical', length: 256, commandCount: 10, protocolError: false, clientIdx: 1000 },
  ];

  for (const tc of roundTripCases) {
    it(`round-trip: ${tc.name}`, () => {
      const buffer = Buffer.alloc(ResponseHeaderEncoder.ENCODED_LENGTH);
      ResponseHeaderEncoder.encodeInto(buffer, 0, tc.length, tc.commandCount, tc.protocolError, tc.clientIdx);

      const decoder = new ResponseHeaderDecoder().wrap(buffer, 0);
      assert.strictEqual(decoder.length(), tc.length);
      assert.strictEqual(decoder.commandCount(), tc.commandCount);
      assert.strictEqual(decoder.protocolError(), tc.protocolError);
      assert.strictEqual(decoder.clientIdx(), tc.clientIdx);
    });
  }

  it('encodes fixed field (designator=0x80)', () => {
    const buffer = ResponseHeaderEncoder.allocateAndEncode(0, 1, false, 0);
    assert.strictEqual(buffer[0], 0x80);
  });

  it('ENCODED_LENGTH is 8 bytes', () => {
    assert.strictEqual(ResponseHeaderEncoder.ENCODED_LENGTH, 8);
  });

  it('encodes flags byte correctly (commandCount | protocolError)', () => {
    const buffer = Buffer.alloc(ResponseHeaderEncoder.ENCODED_LENGTH);
    ResponseHeaderEncoder.encodeInto(buffer, 0, 0, 0x35, true, 0);
    // flags byte is at offset 5 in v0
    assert.strictEqual(buffer[5], 0x35 | 0x80);
  });

  it('rejects buffer too small', () => {
    assert.strictEqual(new ResponseHeaderDecoder().wrap(Buffer.alloc(4), 0).isValid(), false);
  });
});

describe('utility functions (v0)', () => {
  const designatorCases = [
    { byte: 0x80, expected: true },
    { byte: 0x00, expected: false },
    { byte: 0xAE, expected: false },
  ];

  for (const tc of designatorCases) {
    it(`isRequestHeaderDesignator(0x${tc.byte.toString(16)}) = ${tc.expected}`, () => {
      const expected = tc.byte === RequestHeaderDecoder.designatorConstantValue();
      assert.strictEqual(expected, tc.expected);
      assert.strictEqual(tc.byte === ResponseHeaderDecoder.designatorConstantValue(), tc.expected);
    });
  }

  it('startsWithBinaryHeader', () => {
    assert.strictEqual(RequestHeaderDecoder.startsWithBinaryHeader(Buffer.from([0x80, 0x00])), true);
    assert.strictEqual(RequestHeaderDecoder.startsWithBinaryHeader(Buffer.from([0x00, 0x01])), false);
    assert.strictEqual(RequestHeaderDecoder.startsWithBinaryHeader(Buffer.from([0xAE, 0x01])), false);
    assert.strictEqual(RequestHeaderDecoder.startsWithBinaryHeader(Buffer.alloc(0)), false);
  });

  it('peekDesignator', () => {
    assert.strictEqual(RequestHeaderDecoder.peekDesignator(Buffer.from([0x80])), 0x80);
    assert.strictEqual(RequestHeaderDecoder.peekDesignator(Buffer.alloc(0)), null);
  });
});

describe('flyweight reuse (v0)', () => {
  it('encoder/decoder can process multiple buffers sequentially', () => {
    const encoder = new RequestHeaderEncoder();
    const decoder = new RequestHeaderDecoder();
    const buf1 = Buffer.alloc(RequestHeaderEncoder.ENCODED_LENGTH);
    const buf2 = Buffer.alloc(RequestHeaderEncoder.ENCODED_LENGTH);

    encoder.wrapAndWrite(buf1, 0).length(200).commandCount(1).slot(100).clientIdx(1);
    encoder.wrapAndWrite(buf2, 0).length(400).commandCount(2).slot(300).clientIdx(2);

    assert.strictEqual(decoder.wrap(buf1, 0).slot(), 100);
    assert.strictEqual(decoder.wrap(buf1, 0).length(), 200);
    assert.strictEqual(decoder.wrap(buf2, 0).slot(), 300);
    assert.strictEqual(decoder.wrap(buf2, 0).length(), 400);
  });
});

describe('toObject conversion (v0)', () => {
  it('RequestHeaderDecoder.toObject returns plain object', () => {
    const buffer = RequestHeaderEncoder.allocateAndEncode(500, 5, 1000, 42);
    const obj = new RequestHeaderDecoder().wrap(buffer, 0).toObject();

    assert.strictEqual(obj.designator, 0x80);
    assert.strictEqual(obj.length, 500);
    assert.strictEqual(obj.commandCount, 5);
    assert.strictEqual(obj.slot, 1000);
    assert.strictEqual(obj.clientIdx, 42);
  });

  it('ResponseHeaderDecoder.toObject returns plain object', () => {
    const buffer = ResponseHeaderEncoder.allocateAndEncode(500, 3, true, 99);
    const obj = new ResponseHeaderDecoder().wrap(buffer, 0).toObject();

    assert.strictEqual(obj.designator, 0x80);
    assert.strictEqual(obj.length, 500);
    assert.strictEqual(obj.commandCount, 3);
    assert.strictEqual(obj.protocolError, true);
    assert.strictEqual(obj.clientIdx, 99);
  });
});

describe('v0 wire format verification', () => {
  it('RequestHeader wire layout matches spec', () => {
    // Per spec:
    // Octet 0: DESIG (0x80)
    // Octets 1-4: LENGTH (32b BE)
    // Octet 5: NCMD (8b)
    // Octets 6-7: SLOT (16b BE)
    // Octets 8-9: CLIENT_IDX (16b BE)
    const buffer = RequestHeaderEncoder.allocateAndEncode(0x12345678, 0x2A, 0x1234, 0xABCD);

    assert.strictEqual(buffer[0], 0x80, 'designator at offset 0');
    assert.strictEqual(buffer.readUInt32BE(1), 0x12345678, 'length at offset 1-4');
    assert.strictEqual(buffer[5], 0x2A, 'commandCount at offset 5');
    assert.strictEqual(buffer.readUInt16BE(6), 0x1234, 'slot at offset 6-7');
    assert.strictEqual(buffer.readUInt16BE(8), 0xABCD, 'clientIdx at offset 8-9');
  });

  it('ResponseHeader wire layout matches spec', () => {
    // Per spec:
    // Octet 0: DESIG (0x80)
    // Octets 1-4: LENGTH (32b BE)
    // Octet 5: NCMD / FLAGS (commandCount in bits 0-6, protocolError in bit 7)
    // Octets 6-7: CLIENT_IDX (16b BE)
    const buffer = ResponseHeaderEncoder.allocateAndEncode(0x12345678, 0x2A, true, 0xABCD);

    assert.strictEqual(buffer[0], 0x80, 'designator at offset 0');
    assert.strictEqual(buffer.readUInt32BE(1), 0x12345678, 'length at offset 1-4');
    assert.strictEqual(buffer[5], 0x2A | 0x80, 'flags at offset 5 (commandCount | protocolError)');
    assert.strictEqual(buffer.readUInt16BE(6), 0xABCD, 'clientIdx at offset 6-7');
  });

  it('slotNullValue is 0xFFFF per spec', () => {
    assert.strictEqual(RequestHeaderEncoder.slotNullValue(), 0xFFFF);
  });

  it('slotMaxValue is 0x3FFF per spec', () => {
    assert.strictEqual(RequestHeaderEncoder.slotMaxValue(), 0x3FFF);
  });
});

describe('unchecked fast-path contract (v0)', () => {
  it('RequestHeaderEncoder.encodeInto truncates out-of-range values instead of throwing', () => {
    const buffer = Buffer.alloc(RequestHeaderEncoder.ENCODED_LENGTH);

    assert.doesNotThrow(() => {
      RequestHeaderEncoder.encodeInto(
        buffer,
        0,
        0x1_0000_0002, // length (over 32-bit)
        0x1AA,         // commandCount (over 8-bit)
        0x12345,       // slot (over 16-bit)
        0x1ABCD        // clientIdx (over 16-bit)
      );
    });

    const decoder = new RequestHeaderDecoder().wrap(buffer, 0);
    assert.strictEqual(decoder.length(), 2, 'length should be truncated to low 32 bits');
    assert.strictEqual(decoder.commandCount(), 0xAA, 'commandCount should be truncated to low 8 bits');
    assert.strictEqual(decoder.slot(), 0x2345, 'slot should be truncated to low 16 bits');
    assert.strictEqual(decoder.clientIdx(), 0xABCD, 'clientIdx should be truncated to low 16 bits');
  });

  it('RequestHeaderEncoder flyweight setters follow the same unchecked truncation behavior', () => {
    const buffer = Buffer.alloc(RequestHeaderEncoder.ENCODED_LENGTH);

    assert.doesNotThrow(() => {
      new RequestHeaderEncoder()
        .wrapAndWrite(buffer, 0)
        .length(0x1_0000_0003)
        .commandCount(0x1AB)
        .slot(0x12345)
        .clientIdx(0x1BCDE);
    });

    const decoder = new RequestHeaderDecoder().wrap(buffer, 0);
    assert.strictEqual(decoder.length(), 3);
    assert.strictEqual(decoder.commandCount(), 0xAB);
    assert.strictEqual(decoder.slot(), 0x2345);
    assert.strictEqual(decoder.clientIdx(), 0xBCDE);
  });

  it('ResponseHeaderEncoder.encodeInto truncates out-of-range values and preserves explicit protocolError', () => {
    const buffer = Buffer.alloc(ResponseHeaderEncoder.ENCODED_LENGTH);

    assert.doesNotThrow(() => {
      ResponseHeaderEncoder.encodeInto(
        buffer,
        0,
        0x1_0000_0004, // length (over 32-bit)
        0x1FF,         // commandCount (over 7-bit field)
        false,         // protocolError explicitly false
        0x1CDEF        // clientIdx (over 16-bit)
      );
    });

    const decoder = new ResponseHeaderDecoder().wrap(buffer, 0);
    assert.strictEqual(decoder.length(), 4, 'length should be truncated to low 32 bits');
    assert.strictEqual(decoder.commandCount(), 0x7F, 'commandCount should be truncated to low 7 bits');
    assert.strictEqual(
      decoder.protocolError(),
      false,
      'protocolError should follow the explicit boolean input'
    );
    assert.strictEqual(decoder.clientIdx(), 0xCDEF, 'clientIdx should be truncated to low 16 bits');

    // Explicit protocolError=true should still set the flag regardless of commandCount truncation.
    ResponseHeaderEncoder.encodeInto(buffer, 0, 1, 0x155, true, 0);
    assert.strictEqual(decoder.wrap(buffer, 0).commandCount(), 0x55);
    assert.strictEqual(decoder.protocolError(), true);
  });
});
