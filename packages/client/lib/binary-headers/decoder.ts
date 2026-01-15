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
 * Wire format (8 bytes):
 * - Byte 0: DESIG (0x80)
 * - Bytes 1-4: LENGTH (32-bit big-endian)
 * - Byte 5: NCMD/FLAGS (bits 0-6 = command count, bit 7 = protocol error)
 * - Bytes 6-7: CLIENT_IDX (16-bit big-endian)
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

  const length = buffer.readUInt32BE(offset + 1);
  const flagsByte = buffer[offset + 5];
  const clientIdx = buffer.readUInt16BE(offset + 6);

  const commandCount = extractCommandCount(flagsByte);
  const protocolError = hasProtocolError(flagsByte);

  if (commandCount < 1 || commandCount > BINHDR.MAX_COMMANDS_PER_PACK) {
    return { success: false, error: 'invalid_command_count' };
  }

  const header: BinaryResponseHeader = {
    designator: BINHDR.DESIGNATOR,
    length,
    commandCount,
    protocolError,
    clientIdx,
  };

  return {
    success: true,
    header,
    bytesConsumed: BINHDR.RESPONSE_HEADER_SIZE,
  };
}

/**
 * Wire format (10 bytes):
 * - Byte 0: DESIG (0x80)
 * - Bytes 1-4: LENGTH (32-bit big-endian)
 * - Byte 5: NCMD (1-127)
 * - Bytes 6-7: SLOT (16-bit big-endian)
 * - Bytes 8-9: CLIENT_IDX (16-bit big-endian)
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
    length: buffer.readUInt32BE(offset + 1),
    commandCount: buffer[offset + 5],
    slot: buffer.readUInt16BE(offset + 6),
    clientIdx: buffer.readUInt16BE(offset + 8),
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
