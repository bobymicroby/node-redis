import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { BINHDR } from './generated/constants';
import {
  createRequestHeader,
  encodeRequestHeader,
  encodeRequestHeaderInto,
} from './generated/encoder';
import { describeVersion, PROTOCOL_VERSION, getConstant } from './test-version';

const isV1 = PROTOCOL_VERSION === 1;

describe('Binary Headers Encoder', () => {
  describe('createRequestHeader', () => {
    describe('valid inputs', () => {
      it('creates header with minimum values', () => {
        // v1: (slot, length, commandCount, requestId)
        // v0: (length, commandCount, slot, clientIdx)
        const result = isV1
          ? createRequestHeader(0, 0, 1, 0)
          : createRequestHeader(0, 1, 0, 0);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.designator, BINHDR.DESIGNATOR);
          assert.equal(result.header.length, 0);
          assert.equal(result.header.commandCount, 1);
        }
      });

      it('creates header with maximum values', () => {
        const result = isV1
          ? createRequestHeader(
              BINHDR.SLOT_MAX_VALID,
              BINHDR.MAX_PAYLOAD_LENGTH,
              BINHDR.MAX_COMMANDS_PER_PACK,
              getConstant('MAX_REQUEST_ID')!
            )
          : createRequestHeader(
              BINHDR.MAX_PAYLOAD_LENGTH,
              BINHDR.MAX_COMMANDS_PER_PACK,
              BINHDR.SLOT_NO_SLOT,
              getConstant('MAX_CLIENT_IDX')!
            );

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.length, BINHDR.MAX_PAYLOAD_LENGTH);
          assert.equal(result.header.commandCount, BINHDR.MAX_COMMANDS_PER_PACK);
        }
      });

      it('creates header with typical values', () => {
        const result = isV1
          ? createRequestHeader(1000, 159, 6, 100)
          : createRequestHeader(159, 6, 1000, 100);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.slot, 1000);
          assert.equal(result.header.length, 159);
          assert.equal(result.header.commandCount, 6);
        }
      });
    });

    describeVersion(1, 'v1: valid inputs with version-specific fields', () => {
      it('creates header with version field', () => {
        const result = createRequestHeader(0, 0, 1, 0);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.version, getConstant('VERSION'));
        }
      });

      it('creates header with requestId', () => {
        const result = createRequestHeader(0, 0, 1, 12345);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.requestId, 12345);
        }
      });
    });

    describeVersion(0, 'v0: valid inputs with version-specific fields', () => {
      it('creates header with clientIdx', () => {
        const result = createRequestHeader(0, 1, 0, 12345);

        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.header.clientIdx, 12345);
        }
      });
    });

    describe('invalid slot', () => {
      it('rejects negative slot', () => {
        const result = isV1
          ? createRequestHeader(-1, 100, 1, 0)
          : createRequestHeader(100, 1, -1, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_slot');
        }
      });

      it('rejects non-integer slot', () => {
        const result = isV1
          ? createRequestHeader(1.5, 100, 1, 0)
          : createRequestHeader(100, 1, 1.5, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_slot');
        }
      });
    });

    describeVersion(1, 'v1: invalid slot validation', () => {
      it('rejects slot exceeding SLOT_MAX_VALID', () => {
        const result = createRequestHeader(BINHDR.SLOT_MAX_VALID + 1, 100, 1, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_slot');
        }
      });
    });

    describeVersion(0, 'v0: invalid slot validation', () => {
      it('rejects slot exceeding SLOT_NO_SLOT (0xFFFF)', () => {
        const result = createRequestHeader(100, 1, 0x10000, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_slot');
        }
      });
    });

    describe('invalid length', () => {
      it('rejects negative length', () => {
        const result = isV1
          ? createRequestHeader(0, -1, 1, 0)
          : createRequestHeader(-1, 1, 0, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_length');
        }
      });

      it('rejects length exceeding maximum', () => {
        const result = isV1
          ? createRequestHeader(0, BINHDR.MAX_PAYLOAD_LENGTH + 1, 1, 0)
          : createRequestHeader(BINHDR.MAX_PAYLOAD_LENGTH + 1, 1, 0, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_length');
        }
      });

      it('rejects non-integer length', () => {
        const result = isV1
          ? createRequestHeader(0, 1.5, 1, 0)
          : createRequestHeader(1.5, 1, 0, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_length');
        }
      });
    });

    describe('invalid command count', () => {
      it('rejects zero command count', () => {
        const result = isV1
          ? createRequestHeader(0, 100, 0, 0)
          : createRequestHeader(100, 0, 0, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_commandCount');
        }
      });

      it('rejects negative command count', () => {
        const result = isV1
          ? createRequestHeader(0, 100, -1, 0)
          : createRequestHeader(100, -1, 0, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_commandCount');
        }
      });

      it('rejects command count exceeding maximum', () => {
        const result = isV1
          ? createRequestHeader(0, 100, BINHDR.MAX_COMMANDS_PER_PACK + 1, 0)
          : createRequestHeader(100, BINHDR.MAX_COMMANDS_PER_PACK + 1, 0, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_commandCount');
        }
      });

      it('rejects non-integer command count', () => {
        const result = isV1
          ? createRequestHeader(0, 100, 1.5, 0)
          : createRequestHeader(100, 1.5, 0, 0);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_commandCount');
        }
      });
    });

    describeVersion(1, 'v1: invalid requestId', () => {
      it('rejects negative requestId', () => {
        const result = createRequestHeader(0, 100, 1, -1);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_requestId');
        }
      });

      it('rejects requestId exceeding maximum', () => {
        const result = createRequestHeader(0, 100, 1, getConstant('MAX_REQUEST_ID')! + 1);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_requestId');
        }
      });

      it('rejects non-integer requestId', () => {
        const result = createRequestHeader(0, 100, 1, 1.5);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_requestId');
        }
      });
    });

    describeVersion(0, 'v0: invalid clientIdx', () => {
      it('rejects negative clientIdx', () => {
        const result = createRequestHeader(100, 1, 0, -1);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_clientIdx');
        }
      });

      it('rejects clientIdx exceeding maximum', () => {
        const result = createRequestHeader(100, 1, 0, getConstant('MAX_CLIENT_IDX')! + 1);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_clientIdx');
        }
      });

      it('rejects non-integer clientIdx', () => {
        const result = createRequestHeader(100, 1, 0, 1.5);

        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.error, 'invalid_clientIdx');
        }
      });
    });
  });

  describe('encodeRequestHeader', () => {
    it('encodes header with correct size', () => {
      const result = isV1
        ? createRequestHeader(1000, 159, 6, 42)
        : createRequestHeader(159, 6, 1000, 42);
      assert.equal(result.success, true);
      if (!result.success) return;

      const buffer = encodeRequestHeader(result.header);

      assert.equal(buffer.length, BINHDR.REQUEST_HEADER_SIZE);
    });

    it('encodes designator byte correctly', () => {
      const result = isV1
        ? createRequestHeader(0, 0, 1, 0)
        : createRequestHeader(0, 1, 0, 0);
      assert.equal(result.success, true);
      if (!result.success) return;

      const buffer = encodeRequestHeader(result.header);

      assert.equal(buffer[0], BINHDR.DESIGNATOR);
    });

    describeVersion(1, 'v1: wire format', () => {
      it('encodes version byte correctly', () => {
        const result = createRequestHeader(0, 0, 1, 0);
        assert.equal(result.success, true);
        if (!result.success) return;

        const buffer = encodeRequestHeader(result.header);

        assert.equal(buffer[1], getConstant('VERSION'));
      });

      it('encodes slot in big-endian format at offset 2', () => {
        const result = createRequestHeader(0x3F9F, 0, 1, 0);
        assert.equal(result.success, true);
        if (!result.success) return;

        const buffer = encodeRequestHeader(result.header);

        assert.equal(buffer[2], 0x3F);
        assert.equal(buffer[3], 0x9F);
      });

      it('encodes length in big-endian format at offset 4', () => {
        const result = createRequestHeader(0, 0x12345678, 1, 0);
        assert.equal(result.success, true);
        if (!result.success) return;

        const buffer = encodeRequestHeader(result.header);

        assert.equal(buffer[4], 0x12);
        assert.equal(buffer[5], 0x34);
        assert.equal(buffer[6], 0x56);
        assert.equal(buffer[7], 0x78);
      });

      it('encodes command count at offset 8', () => {
        const result = createRequestHeader(0, 0, 127, 0);
        assert.equal(result.success, true);
        if (!result.success) return;

        const buffer = encodeRequestHeader(result.header);

        assert.equal(buffer[8], 127);
      });

      it('encodes requestId in big-endian format at offset 9', () => {
        const result = createRequestHeader(0, 0, 1, 0xABCDEF01);
        assert.equal(result.success, true);
        if (!result.success) return;

        const buffer = encodeRequestHeader(result.header);

        assert.equal(buffer[9], 0xAB);
        assert.equal(buffer[10], 0xCD);
        assert.equal(buffer[11], 0xEF);
        assert.equal(buffer[12], 0x01);
      });

      it('encodes padding bytes as zeros at offset 13-15', () => {
        const result = createRequestHeader(0x3FFF, 0xFFFFFFFF, 127, 0xFFFFFFFF);
        assert.equal(result.success, true);
        if (!result.success) return;

        const buffer = encodeRequestHeader(result.header);

        assert.equal(buffer[13], 0x00);
        assert.equal(buffer[14], 0x00);
        assert.equal(buffer[15], 0x00);
      });

      it('encodes example from v1 spec correctly', () => {
        const result = createRequestHeader(16287, 159, 6, 0x1234);
        assert.equal(result.success, true);
        if (!result.success) return;

        const buffer = encodeRequestHeader(result.header);

        assert.equal(buffer[0], 0xAE);           // DESIGNATOR
        assert.equal(buffer[1], 0x01);           // VERSION
        assert.equal(buffer[2], 0x3F);           // SLOT high byte
        assert.equal(buffer[3], 0x9F);           // SLOT low byte (16287 = 0x3F9F)
        assert.equal(buffer[4], 0x00);           // LENGTH byte 0
        assert.equal(buffer[5], 0x00);           // LENGTH byte 1
        assert.equal(buffer[6], 0x00);           // LENGTH byte 2
        assert.equal(buffer[7], 0x9F);           // LENGTH byte 3 (159)
        assert.equal(buffer[8], 0x06);           // NCMD
        assert.equal(buffer[9], 0x00);           // REQUEST_ID byte 0
        assert.equal(buffer[10], 0x00);          // REQUEST_ID byte 1
        assert.equal(buffer[11], 0x12);          // REQUEST_ID byte 2
        assert.equal(buffer[12], 0x34);          // REQUEST_ID byte 3
        assert.equal(buffer[13], 0x00);          // Reserved
        assert.equal(buffer[14], 0x00);          // Reserved
        assert.equal(buffer[15], 0x00);          // Reserved
      });
    });

    describeVersion(0, 'v0: wire format', () => {
      it('encodes length in big-endian format at offset 1', () => {
        const result = createRequestHeader(0x12345678, 1, 0, 0);
        assert.equal(result.success, true);
        if (!result.success) return;

        const buffer = encodeRequestHeader(result.header);

        assert.equal(buffer[1], 0x12);
        assert.equal(buffer[2], 0x34);
        assert.equal(buffer[3], 0x56);
        assert.equal(buffer[4], 0x78);
      });

      it('encodes command count at offset 5', () => {
        const result = createRequestHeader(0, 127, 0, 0);
        assert.equal(result.success, true);
        if (!result.success) return;

        const buffer = encodeRequestHeader(result.header);

        assert.equal(buffer[5], 127);
      });

      it('encodes slot in big-endian format at offset 6', () => {
        const result = createRequestHeader(0, 1, 0x1234, 0);
        assert.equal(result.success, true);
        if (!result.success) return;

        const buffer = encodeRequestHeader(result.header);

        assert.equal(buffer[6], 0x12);
        assert.equal(buffer[7], 0x34);
      });

      it('encodes clientIdx in big-endian format at offset 8', () => {
        const result = createRequestHeader(0, 1, 0, 0xABCD);
        assert.equal(result.success, true);
        if (!result.success) return;

        const buffer = encodeRequestHeader(result.header);

        assert.equal(buffer[8], 0xAB);
        assert.equal(buffer[9], 0xCD);
      });

      it('encodes example from v0 spec correctly', () => {
        // v0 format: length 159, 6 commands, slot 1000, clientIdx 0x1234
        const result = createRequestHeader(159, 6, 1000, 0x1234);
        assert.equal(result.success, true);
        if (!result.success) return;

        const buffer = encodeRequestHeader(result.header);

        assert.equal(buffer[0], 0x80);           // DESIGNATOR
        assert.equal(buffer[1], 0x00);           // LENGTH byte 0
        assert.equal(buffer[2], 0x00);           // LENGTH byte 1
        assert.equal(buffer[3], 0x00);           // LENGTH byte 2
        assert.equal(buffer[4], 0x9F);           // LENGTH byte 3 (159)
        assert.equal(buffer[5], 0x06);           // NCMD
        assert.equal(buffer[6], 0x03);           // SLOT high byte (1000 = 0x03E8)
        assert.equal(buffer[7], 0xE8);           // SLOT low byte
        assert.equal(buffer[8], 0x12);           // CLIENT_IDX high byte
        assert.equal(buffer[9], 0x34);           // CLIENT_IDX low byte
      });
    });
  });

  describe('encodeRequestHeaderInto', () => {
    it('encodes header into buffer at offset 0', () => {
      const result = isV1
        ? createRequestHeader(1000, 159, 6, 42)
        : createRequestHeader(159, 6, 1000, 42);
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
      const result = isV1
        ? createRequestHeader(0, 0, 1, 0)
        : createRequestHeader(0, 1, 0, 0);
      assert.equal(result.success, true);
      if (!result.success) return;

      const bufferSize = BINHDR.REQUEST_HEADER_SIZE + 10;
      const buffer = Buffer.alloc(bufferSize, 0xAA);

      const encodeResult = encodeRequestHeaderInto(result.header, buffer, 5);

      assert.equal(encodeResult.success, true);
      assert.equal(buffer[4], 0xAA);              // Unchanged before offset
      assert.equal(buffer[5], BINHDR.DESIGNATOR); // Header starts at offset
      assert.equal(buffer[5 + BINHDR.REQUEST_HEADER_SIZE], 0xAA); // Unchanged after header
    });

    it('fails when buffer is too small', () => {
      const result = isV1
        ? createRequestHeader(0, 0, 1, 0)
        : createRequestHeader(0, 1, 0, 0);
      assert.equal(result.success, true);
      if (!result.success) return;

      const buffer = Buffer.alloc(BINHDR.REQUEST_HEADER_SIZE - 1);
      const encodeResult = encodeRequestHeaderInto(result.header, buffer, 0);

      assert.equal(encodeResult.success, false);
      if (!encodeResult.success) {
        assert.equal(encodeResult.error, 'buffer_too_small');
      }
    });

    it('fails when offset leaves insufficient space', () => {
      const result = isV1
        ? createRequestHeader(0, 0, 1, 0)
        : createRequestHeader(0, 1, 0, 0);
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
      const result = isV1
        ? createRequestHeader(1000, 159, 6, 42)
        : createRequestHeader(159, 6, 1000, 42);
      assert.equal(result.success, true);
      if (!result.success) return;

      const directBuffer = encodeRequestHeader(result.header);
      const intoBuffer = Buffer.alloc(BINHDR.REQUEST_HEADER_SIZE);
      encodeRequestHeaderInto(result.header, intoBuffer, 0);

      assert.deepEqual(intoBuffer, directBuffer);
    });
  });
});
