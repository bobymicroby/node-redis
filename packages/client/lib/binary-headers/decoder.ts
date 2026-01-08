import { BINHDR } from './constants';
import type { BinaryRequestHeader, BinaryResponseHeader } from './types';

/**
 * Error codes for request header parsing failures.
 */
export type ParseRequestHeaderError =
  | 'buffer_too_small'
  | 'invalid_designator';

/**
 * Result of parsing a request header.
 */
export type ParseRequestHeaderResult =
  | { readonly success: true; readonly header: BinaryRequestHeader; readonly bytesConsumed: typeof BINHDR.REQUEST_HEADER_SIZE }
  | { readonly success: false; readonly error: ParseRequestHeaderError };

/**
 * Error codes for response header parsing failures.
 */
export type ParseResponseHeaderError =
  | 'buffer_too_small'
  | 'invalid_designator'
  | 'invalid_command_count';

/**
 * Result of parsing a response header.
 */
export type ParseResponseHeaderResult =
  | { readonly success: true; readonly header: BinaryResponseHeader; readonly bytesConsumed: typeof BINHDR.RESPONSE_HEADER_SIZE }
  | { readonly success: false; readonly error: ParseResponseHeaderError };

/**
 * Checks if the given byte is the binary header designator.
 *
 * @param byte - First byte of incoming data
 * @returns true if byte is 0x80 (binary header), false otherwise
 */
export function isBinaryHeaderDesignator(byte: number): boolean {
  return byte === BINHDR.DESIGNATOR;
}

/**
 * Extracts the command count from the response flags byte.
 * Masks out bit 7 (protocol error indicator) to get bits 0-6.
 *
 * @param flagsByte - The NCMD/FLAGS byte from response header
 * @returns Command count (1-127)
 */
export function extractCommandCount(flagsByte: number): number {
  return flagsByte & BINHDR.COMMAND_COUNT_MASK;
}

/**
 * Checks if the protocol error bit is set in the response flags byte.
 *
 * @param flagsByte - The NCMD/FLAGS byte from response header
 * @returns true if bit 7 is set, indicating a protocol error
 */
export function hasProtocolError(flagsByte: number): boolean {
  return (flagsByte & BINHDR.PROTOCOL_ERROR_BIT) !== 0;
}

/**
 * Parses a binary response header from a buffer.
 *
 * Wire format (8 bytes):
 * - Byte 0: DESIG (0x80)
 * - Bytes 1-4: LENGTH (32-bit big-endian)
 * - Byte 5: NCMD/FLAGS (bits 0-6 = command count, bit 7 = protocol error)
 * - Bytes 6-7: CLIENT_IDX (16-bit big-endian)
 *
 * @param buffer - Buffer containing the response data
 * @param offset - Byte offset within the buffer to start reading
 * @returns Discriminated union with parsed header or error
 */
export function parseResponseHeader(
  buffer: Buffer,
  offset: number = 0
): ParseResponseHeaderResult {
  // Check minimum buffer size
  if (buffer.length < offset + BINHDR.RESPONSE_HEADER_SIZE) {
    return { success: false, error: 'buffer_too_small' };
  }

  // Validate designator byte
  const designator = buffer[offset];
  if (designator !== BINHDR.DESIGNATOR) {
    return { success: false, error: 'invalid_designator' };
  }

  // Parse fields
  const length = buffer.readUInt32BE(offset + 1);
  const flagsByte = buffer[offset + 5];
  const clientIdx = buffer.readUInt16BE(offset + 6);

  // Extract command count and protocol error from flags byte
  const commandCount = extractCommandCount(flagsByte);
  const protocolError = hasProtocolError(flagsByte);

  // Validate command count (must be 1-127)
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
 * Parses a binary request header from a buffer.
 *
 * Wire format (10 bytes):
 * - Byte 0: DESIG (0x80)
 * - Bytes 1-4: LENGTH (32-bit big-endian)
 * - Byte 5: NCMD (1-127)
 * - Bytes 6-7: SLOT (16-bit big-endian)
 * - Bytes 8-9: CLIENT_IDX (16-bit big-endian)
 *
 * @param buffer - Buffer containing the request data
 * @param offset - Byte offset within the buffer to start reading
 * @returns Discriminated union with parsed header or error
 */
export function parseRequestHeader(
  buffer: Buffer,
  offset: number = 0
): ParseRequestHeaderResult {
  // Check minimum buffer size
  if (buffer.length < offset + BINHDR.REQUEST_HEADER_SIZE) {
    return { success: false, error: 'buffer_too_small' };
  }

  // Validate designator byte
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

/**
 * Convenience function to check if a buffer starts with a binary header.
 * Useful for the decoder to determine whether to use binary header parsing
 * or fall back to standard RESP parsing.
 *
 * @param buffer - Buffer to check
 * @param offset - Optional offset within the buffer
 * @returns true if buffer has at least 1 byte and starts with designator
 */
export function startsWithBinaryHeader(buffer: Buffer, offset: number = 0): boolean {
  return buffer.length > offset && isBinaryHeaderDesignator(buffer[offset]);
}
