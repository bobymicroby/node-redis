import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { BINHDR } from './constants';
import {
  createRequestHeader,
  encodeRequestHeader,
  encodeRequestHeaderInto,
} from './encoder';

describe('Binary Headers Encoder', () => {
  describe('createRequestHeader', () => {
    describe('valid inputs', () => {
      it('creates header with minimum values', () => {
        const result = createRequestHeader(0, 1, 0, 0);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.designator, BINHDR.DESIGNATOR);
          assert.equal(result.header.length, 0);
          assert.equal(result.header.commandCount, 1);
          assert.equal(result.header.slot, 0);
          assert.equal(result.header.clientIdx, 0);
        }
      });

      it('creates header with maximum values', () => {
        const result = createRequestHeader(
          BINHDR.MAX_PAYLOAD_LENGTH,
          BINHDR.MAX_COMMANDS_PER_PACK,
          BINHDR.SLOT_MAX_VALID,
          BINHDR.MAX_CLIENT_IDX
        );

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.length, BINHDR.MAX_PAYLOAD_LENGTH);
          assert.equal(result.header.commandCount, BINHDR.MAX_COMMANDS_PER_PACK);
          assert.equal(result.header.slot, BINHDR.SLOT_MAX_VALID);
          assert.equal(result.header.clientIdx, BINHDR.MAX_CLIENT_IDX);
        }
      });

      it('creates header with SLOT_NO_SLOT', () => {
        const result = createRequestHeader(100, 5, BINHDR.SLOT_NO_SLOT, 42);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.slot, BINHDR.SLOT_NO_SLOT);
        }
      });

      it('creates header with typical values', () => {
        const result = createRequestHeader(159, 6, 16287, 100);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.length, 159);
          assert.equal(result.header.commandCount, 6);
          assert.equal(result.header.slot, 16287);
          assert.equal(result.header.clientIdx, 100);
        }
      });
    });

    describe('invalid length', () => {
      it('rejects negative length', () => {
        const result = createRequestHeader(-1, 1, 0, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_length');
        }
      });

      it('rejects length exceeding maximum', () => {
        const result = createRequestHeader(BINHDR.MAX_PAYLOAD_LENGTH + 1, 1, 0, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_length');
        }
      });

      it('rejects non-integer length', () => {
        const result = createRequestHeader(1.5, 1, 0, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_length');
        }
      });
    });

    describe('invalid command count', () => {
      it('rejects zero command count', () => {
        const result = createRequestHeader(100, 0, 0, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_command_count');
        }
      });

      it('rejects negative command count', () => {
        const result = createRequestHeader(100, -1, 0, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_command_count');
        }
      });

      it('rejects command count exceeding maximum', () => {
        const result = createRequestHeader(100, BINHDR.MAX_COMMANDS_PER_PACK + 1, 0, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_command_count');
        }
      });

      it('rejects non-integer command count', () => {
        const result = createRequestHeader(100, 1.5, 0, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_command_count');
        }
      });
    });

    describe('invalid slot', () => {
      it('rejects negative slot', () => {
        const result = createRequestHeader(100, 1, -1, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_slot');
        }
      });

      it('rejects slot in reserved range (0x4000 to 0xFFFE)', () => {
        const result = createRequestHeader(100, 1, 0x4000, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_slot');
        }
      });

      it('rejects slot 0xFFFE (reserved)', () => {
        const result = createRequestHeader(100, 1, 0xFFFE, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_slot');
        }
      });

      it('rejects non-integer slot', () => {
        const result = createRequestHeader(100, 1, 1.5, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_slot');
        }
      });
    });

    describe('invalid client index', () => {
      it('rejects negative client index', () => {
        const result = createRequestHeader(100, 1, 0, -1);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_client_idx');
        }
      });

      it('rejects client index exceeding maximum', () => {
        const result = createRequestHeader(100, 1, 0, BINHDR.MAX_CLIENT_IDX + 1);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_client_idx');
        }
      });

      it('rejects non-integer client index', () => {
        const result = createRequestHeader(100, 1, 0, 1.5);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_client_idx');
        }
      });
    });
  });

  describe('encodeRequestHeader', () => {
    it('encodes header with correct size', () => {
      const result = createRequestHeader(159, 6, 16287, 42);
      assert.equal(result.success, true);
      if (!result.success) return;

      const buffer = encodeRequestHeader(result.header);

      assert.equal(buffer.length, BINHDR.REQUEST_HEADER_SIZE);
    });

    it('encodes designator byte correctly', () => {
      const result = createRequestHeader(0, 1, 0, 0);
      assert.equal(result.success, true);
      if (!result.success) return;

      const buffer = encodeRequestHeader(result.header);

      assert.equal(buffer[0], BINHDR.DESIGNATOR);
    });

    it('encodes length in big-endian format', () => {
      const result = createRequestHeader(0x12345678, 1, 0, 0);
      assert.equal(result.success, true);
      if (!result.success) return;

      const buffer = encodeRequestHeader(result.header);

      assert.equal(buffer[1], 0x12);
      assert.equal(buffer[2], 0x34);
      assert.equal(buffer[3], 0x56);
      assert.equal(buffer[4], 0x78);
    });

    it('encodes command count correctly', () => {
      const result = createRequestHeader(0, 127, 0, 0);
      assert.equal(result.success, true);
      if (!result.success) return;

      const buffer = encodeRequestHeader(result.header);

      assert.equal(buffer[5], 127);
    });

    it('encodes slot in big-endian format', () => {
      const result = createRequestHeader(0, 1, 0x3F9F, 0);
      assert.equal(result.success, true);
      if (!result.success) return;

      const buffer = encodeRequestHeader(result.header);

      assert.equal(buffer[6], 0x3F);
      assert.equal(buffer[7], 0x9F);
    });

    it('encodes SLOT_NO_SLOT correctly', () => {
      const result = createRequestHeader(0, 1, BINHDR.SLOT_NO_SLOT, 0);
      assert.equal(result.success, true);
      if (!result.success) return;

      const buffer = encodeRequestHeader(result.header);

      assert.equal(buffer[6], 0xFF);
      assert.equal(buffer[7], 0xFF);
    });

    it('encodes client index in big-endian format', () => {
      const result = createRequestHeader(0, 1, 0, 0xABCD);
      assert.equal(result.success, true);
      if (!result.success) return;

      const buffer = encodeRequestHeader(result.header);

      assert.equal(buffer[8], 0xAB);
      assert.equal(buffer[9], 0xCD);
    });

    it('encodes example from spec correctly', () => {
      // From spec: slot 16287 (0x3F9F), 6 commands, length 159
      const result = createRequestHeader(159, 6, 16287, 0x1234);
      assert.equal(result.success, true);
      if (!result.success) return;

      const buffer = encodeRequestHeader(result.header);

      assert.equal(buffer[0], 0x80);           // DESIG
      assert.equal(buffer[1], 0x00);           // LENGTH byte 0
      assert.equal(buffer[2], 0x00);           // LENGTH byte 1
      assert.equal(buffer[3], 0x00);           // LENGTH byte 2
      assert.equal(buffer[4], 0x9F);           // LENGTH byte 3 (159)
      assert.equal(buffer[5], 0x06);           // NCMD
      assert.equal(buffer[6], 0x3F);           // SLOT high byte
      assert.equal(buffer[7], 0x9F);           // SLOT low byte (16287 = 0x3F9F)
      assert.equal(buffer[8], 0x12);           // CLIENT_IDX high byte
      assert.equal(buffer[9], 0x34);           // CLIENT_IDX low byte
    });
  });

  describe('encodeRequestHeaderInto', () => {
    it('encodes header into buffer at offset 0', () => {
      const result = createRequestHeader(159, 6, 16287, 42);
      assert.equal(result.success, true);
      if (!result.success) return;

      const buffer = Buffer.alloc(BINHDR.REQUEST_HEADER_SIZE);
      const encodeResult = encodeRequestHeaderInto(result.header, buffer, 0);

      assert.equal(encodeResult.success, true);
      if (encodeResult.success) {
        assert.equal(encodeResult.bytesWritten, BINHDR.REQUEST_HEADER_SIZE);
      }
      assert.equal(buffer[0], BINHDR.DESIGNATOR);
    });

    it('encodes header into buffer at non-zero offset', () => {
      const result = createRequestHeader(0, 1, 0, 0);
      assert.equal(result.success, true);
      if (!result.success) return;

      const buffer = Buffer.alloc(20, 0xAA); // Fill with pattern to verify offset works

      const encodeResult = encodeRequestHeaderInto(result.header, buffer, 5);

      assert.equal(encodeResult.success, true);
      assert.equal(buffer[4], 0xAA);           // Unchanged before offset
      assert.equal(buffer[5], BINHDR.DESIGNATOR); // Header starts at offset
      assert.equal(buffer[15], 0xAA);          // Unchanged after header
    });

    it('fails when buffer is too small', () => {
      const result = createRequestHeader(0, 1, 0, 0);
      assert.equal(result.success, true);
      if (!result.success) return;

      const buffer = Buffer.alloc(5); // Too small
      const encodeResult = encodeRequestHeaderInto(result.header, buffer, 0);

      assert.equal(encodeResult.success, false);
      if (!encodeResult.success) {
        assert.equal(encodeResult.error, 'buffer_too_small');
      }
    });

    it('fails when offset leaves insufficient space', () => {
      const result = createRequestHeader(0, 1, 0, 0);
      assert.equal(result.success, true);
      if (!result.success) return;

      const buffer = Buffer.alloc(BINHDR.REQUEST_HEADER_SIZE);
      const encodeResult = encodeRequestHeaderInto(result.header, buffer, 1);

      assert.equal(encodeResult.success, false);
      if (!encodeResult.success) {
        assert.equal(encodeResult.error, 'buffer_too_small');
      }
    });

    it('produces same bytes as encodeRequestHeader', () => {
      const result = createRequestHeader(159, 6, 16287, 42);
      assert.equal(result.success, true);
      if (!result.success) return;

      const directBuffer = encodeRequestHeader(result.header);
      const intoBuffer = Buffer.alloc(BINHDR.REQUEST_HEADER_SIZE);
      encodeRequestHeaderInto(result.header, intoBuffer, 0);

      assert.deepEqual(intoBuffer, directBuffer);
    });
  });
});
