import { BINHDR } from './constants';
import type { BinaryRequestHeader, BinaryResponseHeader } from './types';

export type ParseRequestHeaderError =
  | 'buffer_too_small'
  | 'invalid_designator';

export type ParseRequestHeaderResult =
  | { readonly success: true; readonly header: BinaryRequestHeader; readonly bytesConsumed: typeof BINHDR.REQUEST_HEADER_SIZE }
  | { readonly success: false; readonly error: ParseRequestHeaderError };

export type ParseResponseHeaderError =
  | 'buffer_too_small'
  | 'invalid_designator'
  | 'invalid_command_count';

export type ParseResponseHeaderResult =
  | { readonly success: true; readonly header: BinaryResponseHeader; readonly bytesConsumed: typeof BINHDR.RESPONSE_HEADER_SIZE }
  | { readonly success: false; readonly error: ParseResponseHeaderError };

export function isBinaryHeaderDesignator(byte: number): boolean {
  return byte === BINHDR.DESIGNATOR;
}

export function extractCommandCount(flagsByte: number): number {
  return flagsByte & BINHDR.COMMAND_COUNT_MASK;
}

export function hasProtocolError(flagsByte: number): boolean {
  return (flagsByte & BINHDR.PROTOCOL_ERROR_BIT) !== 0;
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
export function parseResponseHeader(
  buffer: Buffer,
  offset: number = 0
): ParseResponseHeaderResult {
  if (buffer.length < offset + BINHDR.RESPONSE_HEADER_SIZE) {
    return { success: false, error: 'buffer_too_small' };
  }

  const designator = buffer[offset];
  if (designator !== BINHDR.DESIGNATOR) {
    return { success: false, error: 'invalid_designator' };
  }

  const length = buffer.readUInt32BE(offset + 4);
  const flagsByte = buffer[offset + 8];
  const requestId = buffer.readUInt32BE(offset + 9);

  const commandCount = extractCommandCount(flagsByte);
  const protocolError = hasProtocolError(flagsByte);

  if (commandCount < 1 || commandCount > BINHDR.MAX_COMMANDS_PER_PACK) {
    return { success: false, error: 'invalid_command_count' };
  }

  const header: BinaryResponseHeader = {
    designator: BINHDR.DESIGNATOR,
    version: BINHDR.VERSION,
    length,
    commandCount,
    protocolError,
    requestId,
  };

  return {
    success: true,
    header,
    bytesConsumed: BINHDR.RESPONSE_HEADER_SIZE,
  };
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
export function parseRequestHeader(
  buffer: Buffer,
  offset: number = 0
): ParseRequestHeaderResult {
  if (buffer.length < offset + BINHDR.REQUEST_HEADER_SIZE) {
    return { success: false, error: 'buffer_too_small' };
  }

  const designator = buffer[offset];
  if (designator !== BINHDR.DESIGNATOR) {
    return { success: false, error: 'invalid_designator' };
  }

  const header: BinaryRequestHeader = {
    designator: BINHDR.DESIGNATOR,
    version: BINHDR.VERSION,
    slot: buffer.readUInt16BE(offset + 2),
    length: buffer.readUInt32BE(offset + 4),
    commandCount: buffer[offset + 8],
    requestId: buffer.readUInt32BE(offset + 9),
  };

  return {
    success: true,
    header,
    bytesConsumed: BINHDR.REQUEST_HEADER_SIZE,
  };
}

export function startsWithBinaryHeader(buffer: Buffer, offset: number = 0): boolean {
  return buffer.length > offset && isBinaryHeaderDesignator(buffer[offset]);
}
