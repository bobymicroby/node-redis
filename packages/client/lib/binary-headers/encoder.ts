import { BINHDR } from './constants';
import type {
  BinaryRequestHeader,
  BinaryResponseHeader,
  CreateRequestHeaderResult,
  EncodeRequestHeaderIntoResult,
} from './types';

export function createRequestHeader(
  length: number,
  commandCount: number,
  slot: number,
  requestId: number
): CreateRequestHeaderResult {
  if (
    !Number.isInteger(length) ||
    length < 0 ||
    length > BINHDR.MAX_PAYLOAD_LENGTH
  ) {
    return { success: false, error: 'invalid_length' };
  }

  if (
    !Number.isInteger(commandCount) ||
    commandCount < 1 ||
    commandCount > BINHDR.MAX_COMMANDS_PER_PACK
  ) {
    return { success: false, error: 'invalid_command_count' };
  }

  if (
    !Number.isInteger(slot) ||
    slot < 0 ||
    (slot > BINHDR.SLOT_MAX_VALID && slot !== BINHDR.SLOT_NO_SLOT)
  ) {
    return { success: false, error: 'invalid_slot' };
  }

  if (
    !Number.isInteger(requestId) ||
    requestId < 0 ||
    requestId > BINHDR.MAX_REQUEST_ID
  ) {
    return { success: false, error: 'invalid_request_id' };
  }

  const header: BinaryRequestHeader = {
    designator: BINHDR.DESIGNATOR,
    version: BINHDR.VERSION,
    slot,
    length,
    commandCount,
    requestId,
  };

  return { success: true, header };
}

/**
 * Wire format (16 bytes):
 * - Byte 0: Magic byte (0xAE)
 * - Byte 1: Version (0x01)
 * - Bytes 2-3: Slot (16-bit big-endian)
 * - Bytes 4-7: Payload size (32-bit big-endian)
 * - Byte 8: Batch count
 * - Bytes 9-12: Request ID (32-bit big-endian)
 * - Bytes 13-15: Reserved
 */
export function encodeRequestHeader(header: BinaryRequestHeader): Buffer {
  const buffer = Buffer.allocUnsafe(BINHDR.REQUEST_HEADER_SIZE);

  buffer[0] = header.designator;
  buffer[1] = header.version;
  buffer.writeUInt16BE(header.slot, 2);
  buffer.writeUInt32BE(header.length, 4);
  buffer[8] = header.commandCount;
  buffer.writeUInt32BE(header.requestId, 9);
  buffer[13] = 0;
  buffer[14] = 0;
  buffer[15] = 0;

  return buffer;
}

export function encodeRequestHeaderInto(
  header: BinaryRequestHeader,
  buffer: Buffer,
  offset: number
): EncodeRequestHeaderIntoResult {
  if (buffer.length < offset + BINHDR.REQUEST_HEADER_SIZE) {
    return { success: false, error: 'buffer_too_small' };
  }

  buffer[offset] = header.designator;
  buffer[offset + 1] = header.version;
  buffer.writeUInt16BE(header.slot, offset + 2);
  buffer.writeUInt32BE(header.length, offset + 4);
  buffer[offset + 8] = header.commandCount;
  buffer.writeUInt32BE(header.requestId, offset + 9);
  buffer[offset + 13] = 0;
  buffer[offset + 14] = 0;
  buffer[offset + 15] = 0;

  return { success: true, bytesWritten: BINHDR.REQUEST_HEADER_SIZE };
}

/**
 * Wire format (16 bytes):
 * - Byte 0: Magic byte (0xAE)
 * - Byte 1: Version (0x01)
 * - Bytes 2-3: Reserved
 * - Bytes 4-7: Payload size (32-bit big-endian)
 * - Byte 8: Batch count / flags (bits 0-6 = count, bit 7 = protocol error)
 * - Bytes 9-12: Request ID (32-bit big-endian)
 * - Bytes 13-15: Reserved
 */
export function encodeResponseHeader(header: BinaryResponseHeader): Buffer {
  const buffer = Buffer.allocUnsafe(BINHDR.RESPONSE_HEADER_SIZE);

  buffer[0] = header.designator;
  buffer[1] = header.version;
  buffer[2] = 0;
  buffer[3] = 0;
  buffer.writeUInt32BE(header.length, 4);
  buffer[8] = header.protocolError
    ? header.commandCount | BINHDR.PROTOCOL_ERROR_BIT
    : header.commandCount;
  buffer.writeUInt32BE(header.requestId, 9);
  buffer[13] = 0;
  buffer[14] = 0;
  buffer[15] = 0;

  return buffer;
}
