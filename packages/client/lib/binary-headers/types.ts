import { BINHDR } from './constants';

/**
 * Wire format (10 bytes):
 * - Byte 0: DESIG (0x80)
 * - Bytes 1-4: LENGTH (32-bit big-endian)
 * - Byte 5: NCMD (1-127)
 * - Bytes 6-7: SLOT (16-bit big-endian)
 * - Bytes 8-9: CLIENT_IDX (16-bit big-endian)
 */
export interface BinaryRequestHeader {
  readonly designator: typeof BINHDR.DESIGNATOR;
  readonly length: number;
  readonly commandCount: number;
  readonly slot: number;
  readonly clientIdx: number;
}

/**
 * Wire format (8 bytes):
 * - Byte 0: DESIG (0x80)
 * - Bytes 1-4: LENGTH (32-bit big-endian)
 * - Byte 5: NCMD/FLAGS (bits 0-6 = count, bit 7 = protocol error)
 * - Bytes 6-7: CLIENT_IDX (16-bit big-endian)
 */
export interface BinaryResponseHeader {
  readonly designator: typeof BINHDR.DESIGNATOR;
  readonly length: number;
  readonly commandCount: number;
  readonly protocolError: boolean;
  readonly clientIdx: number;
}

export type CreateRequestHeaderError =
  | 'invalid_length'
  | 'invalid_command_count'
  | 'invalid_slot'
  | 'invalid_client_idx';

export type CreateRequestHeaderResult =
  | { readonly success: true; readonly header: BinaryRequestHeader }
  | { readonly success: false; readonly error: CreateRequestHeaderError };

export type EncodeRequestHeaderIntoError = 'buffer_too_small';

export type EncodeRequestHeaderIntoResult =
  | { readonly success: true; readonly bytesWritten: typeof BINHDR.REQUEST_HEADER_SIZE }
  | { readonly success: false; readonly error: EncodeRequestHeaderIntoError };
