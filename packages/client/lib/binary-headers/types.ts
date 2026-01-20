import { BINHDR } from './constants';

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
export interface BinaryRequestHeader {
  readonly designator: typeof BINHDR.DESIGNATOR;
  readonly version: typeof BINHDR.VERSION;
  readonly slot: number;
  readonly length: number;
  readonly commandCount: number;
  readonly requestId: number;
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
export interface BinaryResponseHeader {
  readonly designator: typeof BINHDR.DESIGNATOR;
  readonly version: typeof BINHDR.VERSION;
  readonly length: number;
  readonly commandCount: number;
  readonly protocolError: boolean;
  readonly requestId: number;
}

export type CreateRequestHeaderError =
  | 'invalid_length'
  | 'invalid_command_count'
  | 'invalid_slot'
  | 'invalid_request_id';

export type CreateRequestHeaderResult =
  | { readonly success: true; readonly header: BinaryRequestHeader }
  | { readonly success: false; readonly error: CreateRequestHeaderError };

export type EncodeRequestHeaderIntoError = 'buffer_too_small';

export type EncodeRequestHeaderIntoResult =
  | { readonly success: true; readonly bytesWritten: typeof BINHDR.REQUEST_HEADER_SIZE }
  | { readonly success: false; readonly error: EncodeRequestHeaderIntoError };
