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
