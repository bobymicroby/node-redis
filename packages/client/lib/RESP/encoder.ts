import { RedisArgument } from './types';

const CRLF = '\r\n';

export interface EncodedCommandWithLength {
  encoded: ReadonlyArray<RedisArgument>;
  byteLength: number;
}

export default function encodeCommand(args: ReadonlyArray<RedisArgument>): ReadonlyArray<RedisArgument> {
  const toWrite: Array<RedisArgument> = [];

  let strings = '*' + args.length + CRLF;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg === 'string') {
      strings += '$' + Buffer.byteLength(arg) + CRLF + arg + CRLF;
    } else if (arg instanceof Buffer) {
      toWrite.push(
        strings + '$' + arg.length.toString() + CRLF,
        arg
      );
      strings = CRLF;
    } else {
      throw new TypeError(`"arguments[${i}]" must be of type "string | Buffer", got ${typeof arg} instead.`);
    }
  }

  toWrite.push(strings);

  return toWrite;
}

export function encodeCommandWithLength(args: ReadonlyArray<RedisArgument>): EncodedCommandWithLength {
  const toWrite: Array<RedisArgument> = [];

  // Start with '*<count>\r\n' - track byte length incrementally
  const argsCountStr = args.length.toString();
  let strings = '*' + argsCountStr + CRLF;
  let stringsLen = 1 + argsCountStr.length + 2; // '*' + digits + '\r\n'
  let byteLength = 0;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg === 'string') {
      const argByteLength = Buffer.byteLength(arg);
      const argByteLengthStr = argByteLength.toString();
      // '$<len>\r\n<arg>\r\n'
      strings += '$' + argByteLengthStr + CRLF + arg + CRLF;
      stringsLen += 1 + argByteLengthStr.length + 2 + argByteLength + 2;
    } else if (arg instanceof Buffer) {
      const argLengthStr = arg.length.toString();
      // Flush current strings + '$<len>\r\n'
      const header = strings + '$' + argLengthStr + CRLF;
      byteLength += stringsLen + 1 + argLengthStr.length + 2;
      toWrite.push(header, arg);
      // Buffer content + '\r\n'
      byteLength += arg.length;
      strings = CRLF;
      stringsLen = 2;
    } else {
      throw new TypeError(`"arguments[${i}]" must be of type "string | Buffer", got ${typeof arg} instead.`);
    }
  }

  toWrite.push(strings);
  byteLength += stringsLen;

  return { encoded: toWrite, byteLength };
}
