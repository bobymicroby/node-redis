const CR = 0x0D;
const LF = 0x0A;
const MINUS = 0x2D;
const ASCII_ZERO = 0x30;
const ASCII_NINE = 0x39;
const BOOL_TRUE = 0x74;
const BOOL_FALSE = 0x66;
const RESP_SIMPLE_STRING = 0x2B; // +
const RESP_SIMPLE_ERROR = 0x2D; // -
const RESP_INTEGER = 0x3A; // :
const RESP_DOUBLE = 0x2C; // ,
const RESP_BIG_NUMBER = 0x28; // (
const RESP_BOOLEAN = 0x23; // #
const RESP_NULL = 0x5F; // _
const RESP_BLOB_STRING = 0x24; // $
const RESP_BLOB_ERROR = 0x21; // !
const RESP_VERBATIM_STRING = 0x3D; // =
const RESP_ARRAY = 0x2A; // *
const RESP_SET = 0x7E; // ~
const RESP_PUSH = 0x3E; // >
const RESP_MAP = 0x25; // %

const enum ParseState {
  EXPECT_TYPE,
  READ_SIMPLE_LINE,
  READ_LENGTH_LINE,
  READ_BOOLEAN_VALUE,
  EXPECT_BOOLEAN_CR,
  EXPECT_BOOLEAN_LF,
  EXPECT_NULL_CR,
  EXPECT_NULL_LF,
  READ_BULK_DATA,
  EXPECT_BULK_CR,
  EXPECT_BULK_LF,
}

const enum LengthKind {
  BULK,
  AGGREGATE,
}

const enum ByteConsumeResult {
  CONTINUE,
  COMPLETE,
  INVALID,
}

export const PLAIN_FRAME_NEED_MORE = -1;
export const PLAIN_FRAME_INVALID = -2;

/**
 * Internal stateful scanner for exactly one RESP plain frame.
 * Retains parser state across chunks and returns frame end offsets when complete.
 */
export class PlainRespFrameScanner {
  #frameInProgress = false;
  #parseState = ParseState.EXPECT_TYPE;
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
      case RESP_SIMPLE_STRING:
      case RESP_SIMPLE_ERROR:
      case RESP_INTEGER:
      case RESP_DOUBLE:
      case RESP_BIG_NUMBER:
        this.#parseState = ParseState.READ_SIMPLE_LINE;
        this.#sawCR = false;
        return ByteConsumeResult.CONTINUE;

      case RESP_BOOLEAN:
        this.#parseState = ParseState.READ_BOOLEAN_VALUE;
        return ByteConsumeResult.CONTINUE;

      case RESP_NULL:
        this.#parseState = ParseState.EXPECT_NULL_CR;
        return ByteConsumeResult.CONTINUE;

      case RESP_BLOB_STRING:
      case RESP_BLOB_ERROR:
      case RESP_VERBATIM_STRING:
        return this.#startLengthLine(LengthKind.BULK, 1);

      case RESP_ARRAY:
      case RESP_SET:
      case RESP_PUSH:
        return this.#startLengthLine(LengthKind.AGGREGATE, 1);

      case RESP_MAP:
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
