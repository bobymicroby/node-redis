// Generated from BinaryHeaders protocol v0 - DO NOT EDIT
//
// Performance contract: encoder write paths are intentionally unchecked.
// Callers must validate inputs against generated *MinValue/*MaxValue metadata
// before calling encode methods. Out-of-range values are truncated on the wire.

/**
 * Response header sent from server to client (v0 format)
 *
 * Wire format:
 * - Byte 0: designator (uint8)
 * - Bytes 1-4: length (uint32 BE)
 * - Byte 5: Flags (commandCount, protocolError)
 * - Bytes 6-7: clientIdx (uint16 BE)
 */

export interface ResponseHeader {
  readonly designator: number;
  readonly length: number;
  readonly commandCount: number;
  readonly protocolError: boolean;
  readonly clientIdx: number;
}

export class ResponseHeaderEncoder {
  static readonly ENCODED_LENGTH = 8;
  static readonly SCHEMA_VERSION = 0;

  static designatorEncodingOffset(): number {
    return 0;
  }

  static designatorEncodingLength(): number {
    return 1;
  }

  static designatorSinceVersion(): number {
    return 0;
  }

  static designatorConstantValue(): number {
    return 0x80;
  }

  static lengthEncodingOffset(): number {
    return 1;
  }

  static lengthEncodingLength(): number {
    return 4;
  }

  static lengthSinceVersion(): number {
    return 0;
  }

  static lengthMinValue(): number {
    return 0;
  }

  static lengthMaxValue(): number {
    return 0x7FFFFFFF;
  }

  static commandCountEncodingOffset(): number {
    return 5;
  }

  static commandCountEncodingLength(): number {
    return 1;
  }

  static commandCountSinceVersion(): number {
    return 0;
  }

  static commandCountMinValue(): number {
    return 0;
  }

  static commandCountMaxValue(): number {
    return 0x7F;
  }

  static protocolErrorEncodingOffset(): number {
    return 5;
  }

  static protocolErrorEncodingLength(): number {
    return 1;
  }

  static protocolErrorSinceVersion(): number {
    return 0;
  }

  static clientIdxEncodingOffset(): number {
    return 6;
  }

  static clientIdxEncodingLength(): number {
    return 2;
  }

  static clientIdxSinceVersion(): number {
    return 0;
  }

  static clientIdxMinValue(): number {
    return 0;
  }

  static clientIdxMaxValue(): number {
    return 0xFFFF;
  }

  #buffer: Buffer | null = null;
  #offset = 0;

  wrap(buffer: Buffer, offset: number): ResponseHeaderEncoder {
    this.#buffer = buffer;
    this.#offset = offset;
    return this;
  }

  wrapAndWrite(buffer: Buffer, offset: number): ResponseHeaderEncoder {
    this.wrap(buffer, offset);
    this.designator(ResponseHeaderEncoder.designatorConstantValue());
    return this;
  }

  buffer(): Buffer | null {
    return this.#buffer;
  }

  offset(): number {
    return this.#offset;
  }

  encodedLength(): number {
    return ResponseHeaderEncoder.ENCODED_LENGTH;
  }

  designator(value: number): ResponseHeaderEncoder {
    this.#buffer![this.#offset + ResponseHeaderEncoder.designatorEncodingOffset()] = value;
    return this;
  }

  length(value: number): ResponseHeaderEncoder {
    this.#buffer![this.#offset + ResponseHeaderEncoder.lengthEncodingOffset()] = (value >>> 24) & 0xFF;
    this.#buffer![this.#offset + ResponseHeaderEncoder.lengthEncodingOffset() + 1] = (value >>> 16) & 0xFF;
    this.#buffer![this.#offset + ResponseHeaderEncoder.lengthEncodingOffset() + 2] = (value >>> 8) & 0xFF;
    this.#buffer![this.#offset + ResponseHeaderEncoder.lengthEncodingOffset() + 3] = value & 0xFF;
    return this;
  }

  commandCount(value: number): ResponseHeaderEncoder {
    const byteOffset = this.#offset + ResponseHeaderEncoder.commandCountEncodingOffset();
    const current = this.#buffer![byteOffset] & 0x80;
    this.#buffer![byteOffset] = current | (value & 0x7F);
    return this;
  }

  protocolError(value: boolean): ResponseHeaderEncoder {
    const byteOffset = this.#offset + ResponseHeaderEncoder.protocolErrorEncodingOffset();
    const current = this.#buffer![byteOffset];
    this.#buffer![byteOffset] = value
      ? (current | 0x80)
      : (current & 0x7F);
    return this;
  }

  clientIdx(value: number): ResponseHeaderEncoder {
    this.#buffer![this.#offset + ResponseHeaderEncoder.clientIdxEncodingOffset()] = (value >>> 8) & 0xFF;
    this.#buffer![this.#offset + ResponseHeaderEncoder.clientIdxEncodingOffset() + 1] = value & 0xFF;
    return this;
  }

  static encodeInto(buffer: Buffer, offset: number, length: number, commandCount: number, protocolError: boolean, clientIdx: number): number {
    buffer[offset + ResponseHeaderEncoder.designatorEncodingOffset()] = ResponseHeaderEncoder.designatorConstantValue();
    buffer[offset + ResponseHeaderEncoder.lengthEncodingOffset()] = (length >>> 24) & 0xFF;
    buffer[offset + ResponseHeaderEncoder.lengthEncodingOffset() + 1] = (length >>> 16) & 0xFF;
    buffer[offset + ResponseHeaderEncoder.lengthEncodingOffset() + 2] = (length >>> 8) & 0xFF;
    buffer[offset + ResponseHeaderEncoder.lengthEncodingOffset() + 3] = length & 0xFF;
    buffer[offset + ResponseHeaderEncoder.clientIdxEncodingOffset()] = (clientIdx >>> 8) & 0xFF;
    buffer[offset + ResponseHeaderEncoder.clientIdxEncodingOffset() + 1] = clientIdx & 0xFF;
    buffer[offset + ResponseHeaderEncoder.commandCountEncodingOffset()] = (commandCount & 0x7F) | (protocolError ? 0x80 : 0);
    return ResponseHeaderEncoder.ENCODED_LENGTH;
  }

  static allocateAndEncode(length: number, commandCount: number, protocolError: boolean, clientIdx: number): Buffer {
    const buffer = Buffer.allocUnsafe(ResponseHeaderEncoder.ENCODED_LENGTH);
    ResponseHeaderEncoder.encodeInto(buffer, 0, length, commandCount, protocolError, clientIdx);
    return buffer;
  }
}

export class ResponseHeaderDecoder {
  static readonly ENCODED_LENGTH = 8;
  static readonly SCHEMA_VERSION = 0;

  static designatorEncodingOffset(): number {
    return 0;
  }

  static designatorEncodingLength(): number {
    return 1;
  }

  static designatorSinceVersion(): number {
    return 0;
  }

  static designatorConstantValue(): number {
    return 0x80;
  }

  static lengthEncodingOffset(): number {
    return 1;
  }

  static lengthEncodingLength(): number {
    return 4;
  }

  static lengthSinceVersion(): number {
    return 0;
  }

  static lengthMinValue(): number {
    return 0;
  }

  static lengthMaxValue(): number {
    return 0x7FFFFFFF;
  }

  static commandCountEncodingOffset(): number {
    return 5;
  }

  static commandCountEncodingLength(): number {
    return 1;
  }

  static commandCountSinceVersion(): number {
    return 0;
  }

  static commandCountMinValue(): number {
    return 0;
  }

  static commandCountMaxValue(): number {
    return 0x7F;
  }

  static protocolErrorEncodingOffset(): number {
    return 5;
  }

  static protocolErrorEncodingLength(): number {
    return 1;
  }

  static protocolErrorSinceVersion(): number {
    return 0;
  }

  static clientIdxEncodingOffset(): number {
    return 6;
  }

  static clientIdxEncodingLength(): number {
    return 2;
  }

  static clientIdxSinceVersion(): number {
    return 0;
  }

  static clientIdxMinValue(): number {
    return 0;
  }

  static clientIdxMaxValue(): number {
    return 0xFFFF;
  }

  #buffer: Buffer | null = null;
  #offset = 0;

  wrap(buffer: Buffer, offset: number): ResponseHeaderDecoder {
    this.#buffer = buffer;
    this.#offset = offset;
    return this;
  }

  buffer(): Buffer | null {
    return this.#buffer;
  }

  offset(): number {
    return this.#offset;
  }

  encodedLength(): number {
    return ResponseHeaderDecoder.ENCODED_LENGTH;
  }

  hasEnoughBytes(): boolean {
    return this.#buffer !== null &&
      this.#buffer.length >= this.#offset + ResponseHeaderDecoder.ENCODED_LENGTH;
  }

  designator(): number {
    return ResponseHeaderDecoder.designatorConstantValue();
  }

  length(): number {
    return this.#buffer!.readUInt32BE(this.#offset + ResponseHeaderDecoder.lengthEncodingOffset());
  }

  commandCount(): number {
    return this.#buffer![this.#offset + ResponseHeaderDecoder.commandCountEncodingOffset()] & 0x7F;
  }

  protocolError(): boolean {
    return (this.#buffer![this.#offset + ResponseHeaderDecoder.protocolErrorEncodingOffset()] & 0x80) !== 0;
  }

  clientIdx(): number {
    return this.#buffer!.readUInt16BE(this.#offset + ResponseHeaderDecoder.clientIdxEncodingOffset());
  }

  isValidDesignator(): boolean {
    return this.#buffer![this.#offset + ResponseHeaderDecoder.designatorEncodingOffset()] === ResponseHeaderDecoder.designatorConstantValue();
  }

  isValid(): boolean {
    return this.hasEnoughBytes() && this.isValidDesignator();
  }

  toObject(): ResponseHeader {
    return {
      designator: this.designator(),
      length: this.length(),
      commandCount: this.commandCount(),
      protocolError: this.protocolError(),
      clientIdx: this.clientIdx(),
    };
  }

  static startsWithBinaryHeader(buffer: Buffer, offset: number = 0): boolean {
    return buffer.length > offset && buffer[offset] === ResponseHeaderDecoder.designatorConstantValue();
  }

  static peekDesignator(buffer: Buffer, offset: number = 0): number | null {
    return buffer.length > offset ? buffer[offset] : null;
  }
}

export function extractCommandCount(flagsByte: number): number {
  return flagsByte & 0x7F;
}

export function hasProtocolError(flagsByte: number): boolean {
  return (flagsByte & 0x80) !== 0;
}
