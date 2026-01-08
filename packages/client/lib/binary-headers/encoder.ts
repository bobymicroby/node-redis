import { BINHDR } from './constants';
import type {
  BinaryRequestHeader,
  BinaryResponseHeader,
  CreateRequestHeaderResult,
  EncodeRequestHeaderIntoResult,
} from './types';

/**
 * Validates inputs and creates an immutable request header.
 *
 * @param length - Payload length in bytes (0 to MAX_PAYLOAD_LENGTH)
 * @param commandCount - Number of commands (1 to 127)
 * @param slot - Slot number (0 to 16383) or SLOT_NO_SLOT (0xFFFF)
 * @param clientIdx - Client correlation ID (0 to 65535)
 * @returns Discriminated union with success/failure and header or error
 */
export function createRequestHeader(
  length: number,
  commandCount: number,
  slot: number,
  clientIdx: number
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
    !Number.isInteger(clientIdx) ||
    clientIdx < 0 ||
    clientIdx > BINHDR.MAX_CLIENT_IDX
  ) {
    return { success: false, error: 'invalid_client_idx' };
  }

  const header: BinaryRequestHeader = {
    designator: BINHDR.DESIGNATOR,
    length,
    commandCount,
    slot,
    clientIdx,
  };

  return { success: true, header };
}

/**
 * Encodes a request header into a new Buffer.
 *
 * @param header - The validated binary request header
 * @returns New Buffer containing the encoded 10-byte header
 */
export function encodeRequestHeader(header: BinaryRequestHeader): Buffer {
  const buffer = Buffer.allocUnsafe(BINHDR.REQUEST_HEADER_SIZE);

  buffer[0] = header.designator;
  buffer.writeUInt32BE(header.length, 1);
  buffer.writeUInt8(header.commandCount, 5);
  buffer.writeUInt16BE(header.slot, 6);
  buffer.writeUInt16BE(header.clientIdx, 8);

  return buffer;
}

/**
 * Encodes a request header into an existing buffer at the specified offset.
 *
 * @param header - The validated binary request header
 * @param buffer - Target buffer to write into
 * @param offset - Byte offset within the buffer to start writing
 * @returns Discriminated union indicating success or buffer_too_small error
 */
export function encodeRequestHeaderInto(
  header: BinaryRequestHeader,
  buffer: Buffer,
  offset: number
): EncodeRequestHeaderIntoResult {
  if (buffer.length < offset + BINHDR.REQUEST_HEADER_SIZE) {
    return { success: false, error: 'buffer_too_small' };
  }

  buffer[offset] = header.designator;
  buffer.writeUInt32BE(header.length, offset + 1);
  buffer.writeUInt8(header.commandCount, offset + 5);
  buffer.writeUInt16BE(header.slot, offset + 6);
  buffer.writeUInt16BE(header.clientIdx, offset + 8);

  return { success: true, bytesWritten: BINHDR.REQUEST_HEADER_SIZE };
}

/**
 * Encodes a response header into a new Buffer.
 *
 * Wire format (8 bytes):
 * - Byte 0: DESIG (0x80)
 * - Bytes 1-4: LENGTH (32-bit big-endian)
 * - Byte 5: NCMD/FLAGS (bits 0-6 = command count, bit 7 = protocol error)
 * - Bytes 6-7: CLIENT_IDX (16-bit big-endian)
 *
 * @param header - The binary response header
 * @returns New Buffer containing the encoded 8-byte header
 */
export function encodeResponseHeader(header: BinaryResponseHeader): Buffer {
  const buffer = Buffer.allocUnsafe(BINHDR.RESPONSE_HEADER_SIZE);

  buffer[0] = header.designator;
  buffer.writeUInt32BE(header.length, 1);
  buffer[5] = header.protocolError
    ? header.commandCount | BINHDR.PROTOCOL_ERROR_BIT
    : header.commandCount;
  buffer.writeUInt16BE(header.clientIdx, 6);

  return buffer;
}
