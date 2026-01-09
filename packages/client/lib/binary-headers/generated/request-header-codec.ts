// Generated from BinaryHeaders protocol v0 - DO NOT EDIT
//
// Performance contract: encoder write paths are intentionally unchecked.
// Callers must validate inputs against generated *MinValue/*MaxValue metadata
// before calling encode methods. Out-of-range values are truncated on the wire.

/**
 * Request header sent from client to server (v0 format)
 *
 * Wire format:
 * - Byte 0: designator (uint8)
 * - Bytes 1-4: length (uint32 BE)
 * - Byte 5: commandCount (uint8)
 * - Bytes 6-7: slot (uint16 BE)
 * - Bytes 8-9: clientIdx (uint16 BE)
 */

export interface RequestHeader {
  readonly designator: number;
  readonly length: number;
  readonly commandCount: number;
  readonly slot: number;
  readonly clientIdx: number;
}

export class RequestHeaderEncoder {
  static readonly ENCODED_LENGTH = 10;
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
    return 1;
  }

  static commandCountMaxValue(): number {
    return 0x7F;
  }

  static slotEncodingOffset(): number {
    return 6;
  }

  static slotEncodingLength(): number {
    return 2;
  }

  static slotSinceVersion(): number {
    return 0;
  }

  static slotMinValue(): number {
    return 0;
  }

  static slotMaxValue(): number {
    return 0x3FFF;
  }

  static slotNullValue(): number {
    return 0xFFFF;
  }

  static clientIdxEncodingOffset(): number {
    return 8;
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

  wrap(buffer: Buffer, offset: number): RequestHeaderEncoder {
    this.#buffer = buffer;
    this.#offset = offset;
    return this;
  }

  wrapAndWrite(buffer: Buffer, offset: number): RequestHeaderEncoder {
    this.wrap(buffer, offset);
    this.designator(RequestHeaderEncoder.designatorConstantValue());
    return this;
  }

  buffer(): Buffer | null {
    return this.#buffer;
  }

  offset(): number {
    return this.#offset;
  }

  encodedLength(): number {
    return RequestHeaderEncoder.ENCODED_LENGTH;
  }

  designator(value: number): RequestHeaderEncoder {
    this.#buffer![this.#offset + RequestHeaderEncoder.designatorEncodingOffset()] = value;
    return this;
  }

  length(value: number): RequestHeaderEncoder {
    this.#buffer![this.#offset + RequestHeaderEncoder.lengthEncodingOffset()] = (value >>> 24) & 0xFF;
    this.#buffer![this.#offset + RequestHeaderEncoder.lengthEncodingOffset() + 1] = (value >>> 16) & 0xFF;
    this.#buffer![this.#offset + RequestHeaderEncoder.lengthEncodingOffset() + 2] = (value >>> 8) & 0xFF;
    this.#buffer![this.#offset + RequestHeaderEncoder.lengthEncodingOffset() + 3] = value & 0xFF;
    return this;
  }

  commandCount(value: number): RequestHeaderEncoder {
    this.#buffer![this.#offset + RequestHeaderEncoder.commandCountEncodingOffset()] = value;
    return this;
  }

  slot(value: number): RequestHeaderEncoder {
    this.#buffer![this.#offset + RequestHeaderEncoder.slotEncodingOffset()] = (value >>> 8) & 0xFF;
    this.#buffer![this.#offset + RequestHeaderEncoder.slotEncodingOffset() + 1] = value & 0xFF;
    return this;
  }

  clientIdx(value: number): RequestHeaderEncoder {
    this.#buffer![this.#offset + RequestHeaderEncoder.clientIdxEncodingOffset()] = (value >>> 8) & 0xFF;
    this.#buffer![this.#offset + RequestHeaderEncoder.clientIdxEncodingOffset() + 1] = value & 0xFF;
    return this;
  }

  static encodeInto(buffer: Buffer, offset: number, length: number, commandCount: number, slot: number, clientIdx: number): number {
    buffer[offset + RequestHeaderEncoder.designatorEncodingOffset()] = RequestHeaderEncoder.designatorConstantValue();
    buffer[offset + RequestHeaderEncoder.lengthEncodingOffset()] = (length >>> 24) & 0xFF;
    buffer[offset + RequestHeaderEncoder.lengthEncodingOffset() + 1] = (length >>> 16) & 0xFF;
    buffer[offset + RequestHeaderEncoder.lengthEncodingOffset() + 2] = (length >>> 8) & 0xFF;
    buffer[offset + RequestHeaderEncoder.lengthEncodingOffset() + 3] = length & 0xFF;
    buffer[offset + RequestHeaderEncoder.commandCountEncodingOffset()] = commandCount;
    buffer[offset + RequestHeaderEncoder.slotEncodingOffset()] = (slot >>> 8) & 0xFF;
    buffer[offset + RequestHeaderEncoder.slotEncodingOffset() + 1] = slot & 0xFF;
    buffer[offset + RequestHeaderEncoder.clientIdxEncodingOffset()] = (clientIdx >>> 8) & 0xFF;
    buffer[offset + RequestHeaderEncoder.clientIdxEncodingOffset() + 1] = clientIdx & 0xFF;
    return RequestHeaderEncoder.ENCODED_LENGTH;
  }

  static allocateAndEncode(length: number, commandCount: number, slot: number, clientIdx: number): Buffer {
    const buffer = Buffer.allocUnsafe(RequestHeaderEncoder.ENCODED_LENGTH);
    RequestHeaderEncoder.encodeInto(buffer, 0, length, commandCount, slot, clientIdx);
    return buffer;
  }
}

export class RequestHeaderDecoder {
  static readonly ENCODED_LENGTH = 10;
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
    return 1;
  }

  static commandCountMaxValue(): number {
    return 0x7F;
  }

  static slotEncodingOffset(): number {
    return 6;
  }

  static slotEncodingLength(): number {
    return 2;
  }

  static slotSinceVersion(): number {
    return 0;
  }

  static slotMinValue(): number {
    return 0;
  }

  static slotMaxValue(): number {
    return 0x3FFF;
  }

  static slotNullValue(): number {
    return 0xFFFF;
  }

  static clientIdxEncodingOffset(): number {
    return 8;
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

  wrap(buffer: Buffer, offset: number): RequestHeaderDecoder {
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
    return RequestHeaderDecoder.ENCODED_LENGTH;
  }

  hasEnoughBytes(): boolean {
    return this.#buffer !== null &&
      this.#buffer.length >= this.#offset + RequestHeaderDecoder.ENCODED_LENGTH;
  }

  designator(): number {
    return RequestHeaderDecoder.designatorConstantValue();
  }

  length(): number {
    return this.#buffer!.readUInt32BE(this.#offset + RequestHeaderDecoder.lengthEncodingOffset());
  }

  commandCount(): number {
    return this.#buffer![this.#offset + RequestHeaderDecoder.commandCountEncodingOffset()];
  }

  slot(): number {
    return this.#buffer!.readUInt16BE(this.#offset + RequestHeaderDecoder.slotEncodingOffset());
  }

  clientIdx(): number {
    return this.#buffer!.readUInt16BE(this.#offset + RequestHeaderDecoder.clientIdxEncodingOffset());
  }

  isValidDesignator(): boolean {
    return this.#buffer![this.#offset + RequestHeaderDecoder.designatorEncodingOffset()] === RequestHeaderDecoder.designatorConstantValue();
  }

  isValid(): boolean {
    return this.hasEnoughBytes() && this.isValidDesignator();
  }

  toObject(): RequestHeader {
    return {
      designator: this.designator(),
      length: this.length(),
      commandCount: this.commandCount(),
      slot: this.slot(),
      clientIdx: this.clientIdx(),
    };
  }

  static startsWithBinaryHeader(buffer: Buffer, offset: number = 0): boolean {
    return buffer.length > offset && buffer[offset] === RequestHeaderDecoder.designatorConstantValue();
  }

  static peekDesignator(buffer: Buffer, offset: number = 0): number | null {
    return buffer.length > offset ? buffer[offset] : null;
  }
}