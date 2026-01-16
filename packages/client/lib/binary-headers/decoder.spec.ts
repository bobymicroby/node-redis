import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { BINHDR } from './constants';
import {
  isBinaryHeaderDesignator,
  extractCommandCount,
  hasProtocolError,
  parseResponseHeader,
  startsWithBinaryHeader,
} from './decoder';
import { encodeResponseHeader } from './encoder';
import { createResponseHeader } from './test-utils';

describe('Binary Headers Decoder', () => {
  describe('isBinaryHeaderDesignator', () => {
    it('returns true for 0x80', () => {
      assert.equal(isBinaryHeaderDesignator(0x80), true);
    });

    it('returns false for RESP type designators', () => {
      // Simple string
      assert.equal(isBinaryHeaderDesignator(0x2b), false); // '+'
      // Error
      assert.equal(isBinaryHeaderDesignator(0x2d), false); // '-'
      // Integer
      assert.equal(isBinaryHeaderDesignator(0x3a), false); // ':'
      // Bulk string
      assert.equal(isBinaryHeaderDesignator(0x24), false); // '$'
      // Array
      assert.equal(isBinaryHeaderDesignator(0x2a), false); // '*'
    });

    it('returns false for 0x00', () => {
      assert.equal(isBinaryHeaderDesignator(0x00), false);
    });

    it('returns false for 0xFF', () => {
      assert.equal(isBinaryHeaderDesignator(0xff), false);
    });
  });

  describe('extractCommandCount', () => {
    it('extracts count from flags byte without error bit', () => {
      assert.equal(extractCommandCount(0x01), 1);
      assert.equal(extractCommandCount(0x7f), 127);
      assert.equal(extractCommandCount(0x05), 5);
    });

    it('masks out protocol error bit', () => {
      // 0x83 = 10000011 -> count should be 3
      assert.equal(extractCommandCount(0x83), 3);
      // 0xFF = 11111111 -> count should be 127
      assert.equal(extractCommandCount(0xff), 127);
      // 0x80 = 10000000 -> count should be 0
      assert.equal(extractCommandCount(0x80), 0);
    });
  });

  describe('hasProtocolError', () => {
    it('returns false when bit 7 is not set', () => {
      assert.equal(hasProtocolError(0x00), false);
      assert.equal(hasProtocolError(0x01), false);
      assert.equal(hasProtocolError(0x7f), false);
    });

    it('returns true when bit 7 is set', () => {
      assert.equal(hasProtocolError(0x80), true);
      assert.equal(hasProtocolError(0x81), true);
      assert.equal(hasProtocolError(0xff), true);
    });
  });

  describe('parseResponseHeader', () => {
    // Uses shared helpers from test-utils.ts
    function createResponseBuffer(
      length: number,
      commandCount: number,
      clientIdx: number,
      protocolError: boolean = false
    ): Buffer {
      return encodeResponseHeader(createResponseHeader(length, commandCount, clientIdx, protocolError));
    }

    describe('valid inputs', () => {
      it('parses header with minimum values', () => {
        const buffer = createResponseBuffer(0, 1, 0);
        const result = parseResponseHeader(buffer);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.designator, BINHDR.DESIGNATOR);
          assert.equal(result.header.length, 0);
          assert.equal(result.header.commandCount, 1);
          assert.equal(result.header.clientIdx, 0);
          assert.equal(result.header.protocolError, false);
          assert.equal(result.bytesConsumed, BINHDR.RESPONSE_HEADER_SIZE);
        }
      });

      it('parses header with maximum values', () => {
        const buffer = createResponseBuffer(
          BINHDR.MAX_PAYLOAD_LENGTH,
          BINHDR.MAX_COMMANDS_PER_PACK,
          BINHDR.MAX_CLIENT_IDX
        );
        const result = parseResponseHeader(buffer);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.length, BINHDR.MAX_PAYLOAD_LENGTH);
          assert.equal(result.header.commandCount, BINHDR.MAX_COMMANDS_PER_PACK);
          assert.equal(result.header.clientIdx, BINHDR.MAX_CLIENT_IDX);
        }
      });

      it('parses header with typical values', () => {
        const buffer = createResponseBuffer(159, 6, 100);
        const result = parseResponseHeader(buffer);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.length, 159);
          assert.equal(result.header.commandCount, 6);
          assert.equal(result.header.clientIdx, 100);
        }
      });

      it('parses header with protocol error flag set', () => {
        const buffer = createResponseBuffer(50, 3, 42, true);
        const result = parseResponseHeader(buffer);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.commandCount, 3);
          assert.equal(result.header.protocolError, true);
          assert.equal(result.header.clientIdx, 42);
        }
      });

      it('parses header at non-zero offset', () => {
        const prefix = Buffer.from([0xaa, 0xbb, 0xcc]); // 3 bytes prefix
        const headerBuffer = createResponseBuffer(100, 5, 200);
        const buffer = Buffer.concat([prefix, headerBuffer]);

        const result = parseResponseHeader(buffer, 3);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.length, 100);
          assert.equal(result.header.commandCount, 5);
          assert.equal(result.header.clientIdx, 200);
        }
      });

      it('parses header with extra trailing bytes', () => {
        const headerBuffer = createResponseBuffer(100, 5, 200);
        const suffix = Buffer.from([0x00, 0x01, 0x02, 0x03]); // payload bytes
        const buffer = Buffer.concat([headerBuffer, suffix]);

        const result = parseResponseHeader(buffer);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.length, 100);
          assert.equal(result.bytesConsumed, BINHDR.RESPONSE_HEADER_SIZE);
        }
      });
    });

    describe('invalid inputs', () => {
      it('returns buffer_too_small for empty buffer', () => {
        const result = parseResponseHeader(Buffer.alloc(0));

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'buffer_too_small');
        }
      });

      it('returns buffer_too_small for 7-byte buffer', () => {
        const result = parseResponseHeader(Buffer.alloc(7));

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'buffer_too_small');
        }
      });

      it('returns buffer_too_small when offset leaves insufficient bytes', () => {
        const buffer = Buffer.alloc(10); // 10 bytes total
        const result = parseResponseHeader(buffer, 5); // only 5 bytes remaining

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'buffer_too_small');
        }
      });

      it('returns invalid_designator for wrong first byte', () => {
        const buffer = Buffer.alloc(8);
        buffer[0] = 0x2b; // '+' (RESP simple string)

        const result = parseResponseHeader(buffer);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_designator');
        }
      });

      it('returns invalid_designator for 0x00', () => {
        const buffer = Buffer.alloc(8);
        buffer[0] = 0x00;

        const result = parseResponseHeader(buffer);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_designator');
        }
      });

      it('returns invalid_command_count for zero commands', () => {
        const buffer = Buffer.alloc(8);
        buffer[0] = BINHDR.DESIGNATOR;
        buffer[5] = 0x00; // command count = 0

        const result = parseResponseHeader(buffer);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_command_count');
        }
      });

      it('returns invalid_command_count for zero commands with error bit', () => {
        const buffer = Buffer.alloc(8);
        buffer[0] = BINHDR.DESIGNATOR;
        buffer[5] = 0x80; // error bit set, but count = 0

        const result = parseResponseHeader(buffer);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_command_count');
        }
      });
    });

    describe('wire format verification', () => {
      it('correctly parses big-endian length', () => {
        const buffer = Buffer.alloc(8);
        buffer[0] = BINHDR.DESIGNATOR;
        // Length = 0x12345678 in big-endian
        buffer[1] = 0x12;
        buffer[2] = 0x34;
        buffer[3] = 0x56;
        buffer[4] = 0x78;
        buffer[5] = 0x01; // command count

        const result = parseResponseHeader(buffer);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.length, 0x12345678);
        }
      });

      it('correctly parses big-endian clientIdx', () => {
        const buffer = Buffer.alloc(8);
        buffer[0] = BINHDR.DESIGNATOR;
        buffer[5] = 0x01; // command count
        // clientIdx = 0xABCD in big-endian
        buffer[6] = 0xab;
        buffer[7] = 0xcd;

        const result = parseResponseHeader(buffer);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.clientIdx, 0xabcd);
        }
      });

      it('matches spec example format', () => {
        // From spec: response for packed message with 3 replies, clientIdx=42
        const buffer = Buffer.alloc(8);
        buffer[0] = 0x80; // DESIG
        buffer.writeUInt32BE(50, 1); // LENGTH = 50 bytes
        buffer[5] = 0x03; // NCMD = 3, no error
        buffer.writeUInt16BE(42, 6); // CLIENT_IDX = 42

        const result = parseResponseHeader(buffer);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.designator, 0x80);
          assert.equal(result.header.length, 50);
          assert.equal(result.header.commandCount, 3);
          assert.equal(result.header.protocolError, false);
          assert.equal(result.header.clientIdx, 42);
        }
      });
    });
  });

  describe('startsWithBinaryHeader', () => {
    it('returns true for buffer starting with 0x80', () => {
      const buffer = Buffer.from([0x80, 0x00, 0x00]);
      assert.equal(startsWithBinaryHeader(buffer), true);
    });

    it('returns false for buffer starting with RESP designator', () => {
      const buffer = Buffer.from([0x2b, 0x4f, 0x4b]); // '+OK'
      assert.equal(startsWithBinaryHeader(buffer), false);
    });

    it('returns false for empty buffer', () => {
      assert.equal(startsWithBinaryHeader(Buffer.alloc(0)), false);
    });

    it('checks at specified offset', () => {
      const buffer = Buffer.from([0x00, 0x00, 0x80, 0x00]);
      assert.equal(startsWithBinaryHeader(buffer, 0), false);
      assert.equal(startsWithBinaryHeader(buffer, 2), true);
    });

    it('returns false when offset is at buffer end', () => {
      const buffer = Buffer.from([0x80]);
      assert.equal(startsWithBinaryHeader(buffer, 1), false);
    });

    it('returns false when offset exceeds buffer length', () => {
      const buffer = Buffer.from([0x80]);
      assert.equal(startsWithBinaryHeader(buffer, 5), false);
    });
  });
});
