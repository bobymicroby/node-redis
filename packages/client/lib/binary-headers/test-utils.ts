import { ResponseHeaderEncoder } from './generated/response-header-codec';
import { Decoder } from '../RESP/decoder';

/**
 * Creates a complete binary header response buffer with RESP payload.
 */
export function createBinhdrResponse(respPayload: string): Buffer {
  const payload = Buffer.from(respPayload);
  return Buffer.concat([
    ResponseHeaderEncoder.allocateAndEncode(payload.length, 1, false, 0),
    payload
  ]);
}

/**
 * Creates a complete binary header response frame with a Buffer payload.
 * More flexible than createBinhdrResponse for testing chunked data and multiple commands.
 */
export function createBinhdrFrame(
  payload: Buffer,
  commandCount: number = 1,
  requestId: number = 0,
  protocolError: boolean = false
): Buffer {
  return Buffer.concat([
    ResponseHeaderEncoder.allocateAndEncode(payload.length, commandCount, protocolError, requestId),
    payload
  ]);
}

/**
 * Parses RESP-encoded data back into command arrays using the existing Decoder.
 * Useful for testing - converts '*3\r\n$3\r\nSET\r\n$1\r\na\r\n$1\r\n1\r\n' back to ['SET', 'a', '1']
 */
export function parseRespCommands(data: string | Buffer): unknown[] {
  const replies: unknown[] = [];
  const decoder = new Decoder({
    onReply: (reply: unknown) => replies.push(reply),
    onErrorReply: () => {},
    onPush: () => {},
    getTypeMapping: () => ({}),
  });
  decoder.write(typeof data === 'string' ? Buffer.from(data) : data);
  return replies;
}

// ============================================================================
// Chunking Utilities
// ============================================================================

/**
 * Splits a buffer into chunks of specified sizes.
 * Last chunk gets remaining bytes.
 */
export function splitBuffer(buf: Buffer, chunkSizes: number[]): Buffer[] {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const size of chunkSizes) {
    if (offset >= buf.length) break;
    chunks.push(buf.subarray(offset, offset + size));
    offset += size;
  }
  if (offset < buf.length) {
    chunks.push(buf.subarray(offset));
  }
  return chunks;
}

/**
 * Splits buffer into single-byte chunks.
 */
export function splitIntoBytes(buf: Buffer): Buffer[] {
  return splitBuffer(buf, Array(buf.length).fill(1));
}

/**
 * Splits buffer at specific byte positions.
 */
export function splitAt(buf: Buffer, ...positions: number[]): Buffer[] {
  const sorted = [0, ...positions.sort((a, b) => a - b), buf.length];
  const chunks: Buffer[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i] < sorted[i + 1]) {
      chunks.push(buf.subarray(sorted[i], sorted[i + 1]));
    }
  }
  return chunks;
}

// ============================================================================
// RESP Encoding Utilities
// ============================================================================

/**
 * Encodes a value as RESP simple string: +value\r\n
 */
export function respSimpleString(value: string): Buffer {
  return Buffer.from(`+${value}\r\n`);
}

/**
 * Encodes a value as RESP integer: :value\r\n
 */
export function respInteger(value: number): Buffer {
  return Buffer.from(`:${value}\r\n`);
}

/**
 * Encodes a value as RESP bulk string: $len\r\nvalue\r\n
 */
export function respBulkString(value: string | Buffer): Buffer {
  const buf = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([
    Buffer.from(`$${buf.length}\r\n`),
    buf,
    Buffer.from('\r\n')
  ]);
}

/**
 * Encodes null as RESP null bulk string: $-1\r\n
 */
export function respNull(): Buffer {
  return Buffer.from('$-1\r\n');
}

/**
 * Encodes an error as RESP error: -ERR message\r\n
 */
export function respError(message: string): Buffer {
  return Buffer.from(`-ERR ${message}\r\n`);
}

/**
 * Encodes an array as RESP array: *len\r\n...elements
 */
export function respArray(elements: Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from(`*${elements.length}\r\n`),
    ...elements
  ]);
}

// ============================================================================
// Stress Test Utilities
// ============================================================================

/**
 * Generates a large string of specified size.
 */
export function largeString(size: number, char = 'x'): string {
  return char.repeat(size);
}

/**
 * Generates a large buffer of specified size.
 */
export function largeBuffer(size: number, fill = 0x78): Buffer {
  return Buffer.alloc(size, fill);
}

/**
 * Creates N response frames concatenated together.
 */
export function createMultipleFrames(count: number, respPayload: Buffer): Buffer {
  const frames: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    frames.push(createBinhdrFrame(respPayload));
  }
  return Buffer.concat(frames);
}
