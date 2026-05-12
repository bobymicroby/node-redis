import { RESP_TYPES } from '../RESP/decoder';

const CR = 0x0D;
const LF = 0x0A;
const MINUS = 0x2D;
const ASCII_ZERO = 0x30;
const ASCII_NINE = 0x39;
const BOOL_TRUE = 0x74;
const BOOL_FALSE = 0x66;

const ParseState = {
  EXPECT_TYPE: 0,
  READ_SIMPLE_LINE: 1,
  READ_LENGTH_LINE: 2,
  READ_BOOLEAN_VALUE: 3,
  EXPECT_BOOLEAN_CR: 4,
  EXPECT_BOOLEAN_LF: 5,
  EXPECT_NULL_CR: 6,
  EXPECT_NULL_LF: 7,
  READ_BULK_DATA: 8,
  EXPECT_BULK_CR: 9,
  EXPECT_BULK_LF: 10
} as const;

type ParseState = typeof ParseState[keyof typeof ParseState];

const LengthKind = {
  BULK: 0,
  AGGREGATE: 1
} as const;

type LengthKind = typeof LengthKind[keyof typeof LengthKind];

const ByteConsumeResult = {
  CONTINUE: 0,
  COMPLETE: 1,
  INVALID: 2
} as const;

type ByteConsumeResult = typeof ByteConsumeResult[keyof typeof ByteConsumeResult];

export const PLAIN_FRAME_NEED_MORE = -1;
export const PLAIN_FRAME_INVALID = -2;

/**
 * Internal stateful scanner for exactly one RESP plain frame.
 * Retains parser state across chunks and returns frame end offsets when complete.
 */
export class PlainRespFrameScanner {
  #frameInProgress = false;
  #parseState: ParseState = ParseState.EXPECT_TYPE;
  #sawCR = false;
  #lengthValue = 0;
  #lengthNegative = false;
  #lengthHasDigit = false;
  #bulkRemaining = 0;
  #lengthKind: LengthKind = LengthKind.BULK;
  #aggregateMultiplier = 1;
  readonly #containerRemaining: number[] = [];

  get inProgress(): boolean {
    return this.#frameInProgress;
  }

  reset(): void {
    this.#parseState = ParseState.EXPECT_TYPE;
    this.#sawCR = false;
    this.#resetLengthParser();
    this.#bulkRemaining = 0;
    this.#lengthKind = LengthKind.BULK;
    this.#aggregateMultiplier = 1;
    this.#containerRemaining.length = 0;
    this.#frameInProgress = false;
  }

  consumeFrameEnd(data: Buffer, startOffset: number): number {
    for (let i = startOffset; i < data.length; i++) {
      const consume = this.#consumeByte(data[i]);
      if (consume === ByteConsumeResult.INVALID) {
        this.reset();
        return PLAIN_FRAME_INVALID;
      }
      if (consume === ByteConsumeResult.COMPLETE) {
        this.reset();
        return i + 1;
      }
    }

    this.#frameInProgress = true;
    return PLAIN_FRAME_NEED_MORE;
  }

  #resetLengthParser(): void {
    this.#lengthValue = 0;
    this.#lengthNegative = false;
    this.#lengthHasDigit = false;
  }

  #startLengthLine(kind: LengthKind, aggregateMultiplier: number): ByteConsumeResult {
    this.#parseState = ParseState.READ_LENGTH_LINE;
    this.#lengthKind = kind;
    this.#aggregateMultiplier = aggregateMultiplier;
    this.#sawCR = false;
    this.#resetLengthParser();
    return ByteConsumeResult.CONTINUE;
  }

  #consumeByte(byte: number): ByteConsumeResult {
    switch (this.#parseState) {
      case ParseState.EXPECT_TYPE:
        return this.#consumeType(byte);

      case ParseState.READ_SIMPLE_LINE:
        return this.#consumeSimpleLineByte(byte);

      case ParseState.READ_LENGTH_LINE:
        return this.#consumeLengthLineByte(byte);

      case ParseState.READ_BOOLEAN_VALUE:
        if (byte !== BOOL_TRUE && byte !== BOOL_FALSE) return ByteConsumeResult.INVALID;
        this.#parseState = ParseState.EXPECT_BOOLEAN_CR;
        return ByteConsumeResult.CONTINUE;

      case ParseState.EXPECT_BOOLEAN_CR:
        if (byte !== CR) return ByteConsumeResult.INVALID;
        this.#parseState = ParseState.EXPECT_BOOLEAN_LF;
        return ByteConsumeResult.CONTINUE;

      case ParseState.EXPECT_BOOLEAN_LF:
        if (byte !== LF) return ByteConsumeResult.INVALID;
        return this.#onValueComplete();

      case ParseState.EXPECT_NULL_CR:
        if (byte !== CR) return ByteConsumeResult.INVALID;
        this.#parseState = ParseState.EXPECT_NULL_LF;
        return ByteConsumeResult.CONTINUE;

      case ParseState.EXPECT_NULL_LF:
        if (byte !== LF) return ByteConsumeResult.INVALID;
        return this.#onValueComplete();

      case ParseState.READ_BULK_DATA:
        this.#bulkRemaining--;
        if (this.#bulkRemaining === 0) {
          this.#parseState = ParseState.EXPECT_BULK_CR;
        }
        return ByteConsumeResult.CONTINUE;

      case ParseState.EXPECT_BULK_CR:
        if (byte !== CR) return ByteConsumeResult.INVALID;
        this.#parseState = ParseState.EXPECT_BULK_LF;
        return ByteConsumeResult.CONTINUE;

      case ParseState.EXPECT_BULK_LF:
        if (byte !== LF) return ByteConsumeResult.INVALID;
        return this.#onValueComplete();

      default:
        return ByteConsumeResult.INVALID;
    }
  }

  #consumeType(byte: number): ByteConsumeResult {
    switch (byte) {
      case RESP_TYPES.SIMPLE_STRING:
      case RESP_TYPES.SIMPLE_ERROR:
      case RESP_TYPES.NUMBER:
      case RESP_TYPES.DOUBLE:
      case RESP_TYPES.BIG_NUMBER:
        this.#parseState = ParseState.READ_SIMPLE_LINE;
        this.#sawCR = false;
        return ByteConsumeResult.CONTINUE;

      case RESP_TYPES.BOOLEAN:
        this.#parseState = ParseState.READ_BOOLEAN_VALUE;
        return ByteConsumeResult.CONTINUE;

      case RESP_TYPES.NULL:
        this.#parseState = ParseState.EXPECT_NULL_CR;
        return ByteConsumeResult.CONTINUE;

      case RESP_TYPES.BLOB_STRING:
      case RESP_TYPES.BLOB_ERROR:
      case RESP_TYPES.VERBATIM_STRING:
        return this.#startLengthLine(LengthKind.BULK, 1);

      case RESP_TYPES.ARRAY:
      case RESP_TYPES.SET:
      case RESP_TYPES.PUSH:
        return this.#startLengthLine(LengthKind.AGGREGATE, 1);

      case RESP_TYPES.MAP:
        return this.#startLengthLine(LengthKind.AGGREGATE, 2);

      default:
        return ByteConsumeResult.INVALID;
    }
  }

  #consumeSimpleLineByte(byte: number): ByteConsumeResult {
    if (!this.#sawCR) {
      if (byte === CR) {
        this.#sawCR = true;
      }
      return ByteConsumeResult.CONTINUE;
    }

    if (byte !== LF) {
      this.#sawCR = false;
      return ByteConsumeResult.CONTINUE;
    }

    return this.#onValueComplete();
  }

  #consumeLengthLineByte(byte: number): ByteConsumeResult {
    if (!this.#sawCR) {
      if (byte === CR) {
        if (!this.#lengthHasDigit) {
          return ByteConsumeResult.INVALID;
        }
        this.#sawCR = true;
      } else {
        if (
          byte === MINUS &&
          !this.#lengthHasDigit &&
          !this.#lengthNegative &&
          this.#lengthValue === 0
        ) {
          this.#lengthNegative = true;
          return ByteConsumeResult.CONTINUE;
        }
        if (byte < ASCII_ZERO || byte > ASCII_NINE) {
          return ByteConsumeResult.INVALID;
        }
        this.#lengthHasDigit = true;
        this.#lengthValue = this.#lengthValue * 10 + (byte - ASCII_ZERO);
      }
      return ByteConsumeResult.CONTINUE;
    }

    if (byte !== LF) {
      return ByteConsumeResult.INVALID;
    }

    const length = this.#lengthNegative ? -this.#lengthValue : this.#lengthValue;
    this.#sawCR = false;
    this.#resetLengthParser();

    if (this.#lengthKind === LengthKind.BULK) {
      if (length < -1) {
        return ByteConsumeResult.INVALID;
      }
      if (length === -1) {
        return this.#onValueComplete();
      }
      if (length === 0) {
        this.#parseState = ParseState.EXPECT_BULK_CR;
      } else {
        this.#parseState = ParseState.READ_BULK_DATA;
        this.#bulkRemaining = length;
      }
      return ByteConsumeResult.CONTINUE;
    }

    if (length < -1) {
      return ByteConsumeResult.INVALID;
    }
    if (length <= 0) {
      return this.#onValueComplete();
    }

    this.#containerRemaining.push(length * this.#aggregateMultiplier);
    this.#parseState = ParseState.EXPECT_TYPE;
    return ByteConsumeResult.CONTINUE;
  }

  #onValueComplete(): ByteConsumeResult {
    this.#parseState = ParseState.EXPECT_TYPE;
    this.#sawCR = false;
    this.#resetLengthParser();
    this.#bulkRemaining = 0;

    while (this.#containerRemaining.length > 0) {
      const idx = this.#containerRemaining.length - 1;
      const remaining = this.#containerRemaining[idx] - 1;
      this.#containerRemaining[idx] = remaining;
      if (remaining > 0) {
        return ByteConsumeResult.CONTINUE;
      }
      this.#containerRemaining.pop();
    }

    return ByteConsumeResult.COMPLETE;
  }
}
