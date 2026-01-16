import { BINHDR } from './constants';
import type { BinaryResponseHeader } from './types';
import { encodeResponseHeader } from './encoder';
import { Decoder } from '../RESP/decoder';

/**
 * Creates a valid response header object for testing.
 */
export function createResponseHeader(
  length: number,
  commandCount: number,
  clientIdx: number,
  protocolError: boolean = false
): BinaryResponseHeader {
  return {
    designator: BINHDR.DESIGNATOR,
    length,
    commandCount,
    protocolError,
    clientIdx,
  };
}

/**
 * Creates a complete binary header response buffer with RESP payload.
 */
export function createBinhdrResponse(respPayload: string): Buffer {
  const payload = Buffer.from(respPayload);
  const header = createResponseHeader(payload.length, 1, 0, false);
  return Buffer.concat([encodeResponseHeader(header), payload]);
}

/**
 * Creates a complete binary header response frame with a Buffer payload.
 * More flexible than createBinhdrResponse for testing chunked data and multiple commands.
 */
export function createBinhdrFrame(
  payload: Buffer,
  commandCount: number = 1,
  clientIdx: number = 0,
  protocolError: boolean = false
): Buffer {
  const header = createResponseHeader(payload.length, commandCount, clientIdx, protocolError);
  return Buffer.concat([encodeResponseHeader(header), payload]);
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
