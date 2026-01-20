import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { BINHDR } from './generated/constants';
import {
  isBinaryHeaderDesignator,
  extractCommandCount,
  hasProtocolError,
  parseResponseHeader,
  startsWithBinaryHeader,
} from './generated/decoder';
import { encodeResponseHeader } from './generated/encoder';
import { createResponseHeader } from './test-utils';

describe('Binary Headers Decoder', () => {
  describe('isBinaryHeaderDesignator', () => {
    it('returns true for 0xAE (v1 designator)', () => {
      assert.equal(isBinaryHeaderDesignator(0xAE), true);
    });

    it('returns false for 0x80 (v0 designator)', () => {
      assert.equal(isBinaryHeaderDesignator(0x80), false);
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
    function createResponseBuffer(
      length: number,
      commandCount: number,
      requestId: number,
      protocolError: boolean = false
    ): Buffer {
      return encodeResponseHeader(createResponseHeader(length, commandCount, requestId, protocolError));
    }

    describe('valid inputs', () => {
      it('parses header with minimum values', () => {
        const buffer = createResponseBuffer(0, 1, 0);
        const result = parseResponseHeader(buffer);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.designator, BINHDR.DESIGNATOR);
          assert.equal(result.header.version, BINHDR.VERSION);
          assert.equal(result.header.length, 0);
          assert.equal(result.header.commandCount, 1);
          assert.equal(result.header.requestId, 0);
          assert.equal(result.header.protocolError, false);
          assert.equal(result.bytesConsumed, BINHDR.RESPONSE_HEADER_SIZE);
        }
      });

      it('parses header with maximum values', () => {
        const buffer = createResponseBuffer(
          BINHDR.MAX_PAYLOAD_LENGTH,
          BINHDR.MAX_COMMANDS_PER_PACK,
          BINHDR.MAX_REQUEST_ID
        );
        const result = parseResponseHeader(buffer);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.length, BINHDR.MAX_PAYLOAD_LENGTH);
          assert.equal(result.header.commandCount, BINHDR.MAX_COMMANDS_PER_PACK);
          assert.equal(result.header.requestId, BINHDR.MAX_REQUEST_ID);
        }
      });

      it('parses header with typical values', () => {
        const buffer = createResponseBuffer(159, 6, 100);
        const result = parseResponseHeader(buffer);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.length, 159);
          assert.equal(result.header.commandCount, 6);
          assert.equal(result.header.requestId, 100);
        }
      });

      it('parses header with protocol error flag set', () => {
        const buffer = createResponseBuffer(50, 3, 42, true);
        const result = parseResponseHeader(buffer);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.commandCount, 3);
          assert.equal(result.header.protocolError, true);
          assert.equal(result.header.requestId, 42);
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
          assert.equal(result.header.requestId, 200);
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

      it('returns buffer_too_small for 15-byte buffer', () => {
        const result = parseResponseHeader(Buffer.alloc(15));

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'buffer_too_small');
        }
      });

      it('returns buffer_too_small when offset leaves insufficient bytes', () => {
        const buffer = Buffer.alloc(20); // 20 bytes total
        const result = parseResponseHeader(buffer, 10); // only 10 bytes remaining

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'buffer_too_small');
        }
      });

      it('returns invalid_designator for wrong first byte', () => {
        const buffer = Buffer.alloc(16);
        buffer[0] = 0x2b; // '+' (RESP simple string)
        buffer[1] = BINHDR.VERSION;

        const result = parseResponseHeader(buffer);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_designator');
        }
      });

      it('returns invalid_designator for 0x00', () => {
        const buffer = Buffer.alloc(16);
        buffer[0] = 0x00;
        buffer[1] = BINHDR.VERSION;

        const result = parseResponseHeader(buffer);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_designator');
        }
      });

      it('returns invalid_designator for 0x80 (v0 designator)', () => {
        const buffer = Buffer.alloc(16);
        buffer[0] = 0x80;
        buffer[1] = BINHDR.VERSION;

        const result = parseResponseHeader(buffer);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_designator');
        }
      });

      it('returns invalid_version for wrong version byte', () => {
        const buffer = Buffer.alloc(16);
        buffer[0] = BINHDR.DESIGNATOR;
        buffer[1] = 0x00; // wrong version

        const result = parseResponseHeader(buffer);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_version');
        }
      });
    });

    describe('wire format verification', () => {
      it('correctly parses big-endian length at offset 4', () => {
        const buffer = Buffer.alloc(16);
        buffer[0] = BINHDR.DESIGNATOR;
        buffer[1] = BINHDR.VERSION;
        // Bytes 2-3: reserved (padding)
        // Length = 0x12345678 in big-endian at offset 4
        buffer.writeUInt32BE(0x12345678, 4);
        buffer[8] = 0x01; // flags: command count = 1
        // Bytes 9-12: requestId
        // Bytes 13-15: reserved (padding)

        const result = parseResponseHeader(buffer);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.length, 0x12345678);
        }
      });

      it('correctly parses big-endian requestId at offset 9', () => {
        const buffer = Buffer.alloc(16);
        buffer[0] = BINHDR.DESIGNATOR;
        buffer[1] = BINHDR.VERSION;
        // Bytes 2-3: reserved
        buffer.writeUInt32BE(100, 4); // length
        buffer[8] = 0x01; // flags: command count = 1
        // requestId = 0xABCDEF01 in big-endian at offset 9
        buffer.writeUInt32BE(0xABCDEF01, 9);

        const result = parseResponseHeader(buffer);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.requestId, 0xABCDEF01);
        }
      });

      it('matches v1 spec format', () => {
        // v1 format: 16 bytes
        // Byte 0: designator (0xAE)
        // Byte 1: version (1)
        // Bytes 2-3: reserved
        // Bytes 4-7: length (big-endian)
        // Byte 8: flags (commandCount & protocolError)
        // Bytes 9-12: requestId (big-endian)
        // Bytes 13-15: reserved
        const buffer = Buffer.alloc(16);
        buffer[0] = 0xAE; // DESIGNATOR
        buffer[1] = 0x01; // VERSION
        buffer[2] = 0x00; // reserved
        buffer[3] = 0x00; // reserved
        buffer.writeUInt32BE(50, 4); // LENGTH = 50 bytes
        buffer[8] = 0x03; // NCMD = 3, no error
        buffer.writeUInt32BE(42, 9); // REQUEST_ID = 42
        buffer[13] = 0x00; // reserved
        buffer[14] = 0x00; // reserved
        buffer[15] = 0x00; // reserved

        const result = parseResponseHeader(buffer);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.designator, 0xAE);
          assert.equal(result.header.version, 1);
          assert.equal(result.header.length, 50);
          assert.equal(result.header.commandCount, 3);
          assert.equal(result.header.protocolError, false);
          assert.equal(result.header.requestId, 42);
        }
      });
    });
  });

  describe('startsWithBinaryHeader', () => {
    it('returns true for buffer starting with 0xAE', () => {
      const buffer = Buffer.from([0xAE, 0x01, 0x00]);
      assert.equal(startsWithBinaryHeader(buffer), true);
    });

    it('returns false for buffer starting with 0x80 (v0)', () => {
      const buffer = Buffer.from([0x80, 0x00, 0x00]);
      assert.equal(startsWithBinaryHeader(buffer), false);
    });

    it('returns false for buffer starting with RESP designator', () => {
      const buffer = Buffer.from([0x2b, 0x4f, 0x4b]); // '+OK'
      assert.equal(startsWithBinaryHeader(buffer), false);
    });

    it('returns false for empty buffer', () => {
      assert.equal(startsWithBinaryHeader(Buffer.alloc(0)), false);
    });

    it('checks at specified offset', () => {
      const buffer = Buffer.from([0x00, 0x00, 0xAE, 0x01]);
      assert.equal(startsWithBinaryHeader(buffer, 0), false);
      assert.equal(startsWithBinaryHeader(buffer, 2), true);
    });

    it('returns false when offset is at buffer end', () => {
      const buffer = Buffer.from([0xAE]);
      assert.equal(startsWithBinaryHeader(buffer, 1), false);
    });

    it('returns false when offset exceeds buffer length', () => {
      const buffer = Buffer.from([0xAE]);
      assert.equal(startsWithBinaryHeader(buffer, 5), false);
    });
  });
});
