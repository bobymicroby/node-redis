// Fast Redis cluster slot calculation
// Optimized version that works directly on strings without intermediate UTF-8 array allocation
// Compatible with cluster-key-slot but ~2x faster for ASCII strings

// Generate CRC16 lookup table (XMODEM/CCITT polynomial 0x1021)
function generateCRC16Table(): Uint16Array {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0);
    }
    table[i] = crc & 0xFFFF;
  }
  return table;
}

const CRC16_TABLE = generateCRC16Table();
const HASH_SLOT_MASK = 0x3FFF; // 16384 slots

/**
 * Calculate Redis cluster slot for a key (string version)
 * Handles hash tags: {hashtag}rest -> slot is calculated from "hashtag"
 */
export function calculateSlotString(key: string): number {
  let start = -1;
  let crc = 0;
  let hashCrc = 0;
  const len = key.length;

  for (let i = 0; i < len; i++) {
    let charCode = key.charCodeAt(i);

    // Handle multi-byte UTF-8 encoding inline
    if (charCode < 0x80) {
      // ASCII - single byte
      if (start === -1) {
        if (charCode === 0x7B) { // '{'
          start = i;
        }
      } else if (charCode === 0x7D) { // '}'
        if (i - 1 !== start) {
          return hashCrc & HASH_SLOT_MASK;
        }
      } else {
        hashCrc = CRC16_TABLE[((hashCrc >> 8) ^ charCode) & 0xFF] ^ (hashCrc << 8);
      }
      crc = CRC16_TABLE[((crc >> 8) ^ charCode) & 0xFF] ^ (crc << 8);
    } else if (charCode < 0x800) {
      // 2-byte UTF-8
      const b1 = (charCode >> 6) | 0xC0;
      const b2 = (charCode & 0x3F) | 0x80;
      if (start !== -1) {
        hashCrc = CRC16_TABLE[((hashCrc >> 8) ^ b1) & 0xFF] ^ (hashCrc << 8);
        hashCrc = CRC16_TABLE[((hashCrc >> 8) ^ b2) & 0xFF] ^ (hashCrc << 8);
      }
      crc = CRC16_TABLE[((crc >> 8) ^ b1) & 0xFF] ^ (crc << 8);
      crc = CRC16_TABLE[((crc >> 8) ^ b2) & 0xFF] ^ (crc << 8);
    } else if (charCode >= 0xD800 && charCode <= 0xDBFF && i + 1 < len) {
      // Surrogate pair - 4-byte UTF-8
      const nextChar = key.charCodeAt(i + 1);
      if (nextChar >= 0xDC00 && nextChar <= 0xDFFF) {
        charCode = 0x10000 + ((charCode & 0x3FF) << 10) + (nextChar & 0x3FF);
        i++;
        const b1 = (charCode >> 18) | 0xF0;
        const b2 = ((charCode >> 12) & 0x3F) | 0x80;
        const b3 = ((charCode >> 6) & 0x3F) | 0x80;
        const b4 = (charCode & 0x3F) | 0x80;
        if (start !== -1) {
          hashCrc = CRC16_TABLE[((hashCrc >> 8) ^ b1) & 0xFF] ^ (hashCrc << 8);
          hashCrc = CRC16_TABLE[((hashCrc >> 8) ^ b2) & 0xFF] ^ (hashCrc << 8);
          hashCrc = CRC16_TABLE[((hashCrc >> 8) ^ b3) & 0xFF] ^ (hashCrc << 8);
          hashCrc = CRC16_TABLE[((hashCrc >> 8) ^ b4) & 0xFF] ^ (hashCrc << 8);
        }
        crc = CRC16_TABLE[((crc >> 8) ^ b1) & 0xFF] ^ (crc << 8);
        crc = CRC16_TABLE[((crc >> 8) ^ b2) & 0xFF] ^ (crc << 8);
        crc = CRC16_TABLE[((crc >> 8) ^ b3) & 0xFF] ^ (crc << 8);
        crc = CRC16_TABLE[((crc >> 8) ^ b4) & 0xFF] ^ (crc << 8);
        continue;
      }
      // Invalid surrogate, treat as 3-byte
      const b1 = (charCode >> 12) | 0xE0;
      const b2 = ((charCode >> 6) & 0x3F) | 0x80;
      const b3 = (charCode & 0x3F) | 0x80;
      if (start !== -1) {
        hashCrc = CRC16_TABLE[((hashCrc >> 8) ^ b1) & 0xFF] ^ (hashCrc << 8);
        hashCrc = CRC16_TABLE[((hashCrc >> 8) ^ b2) & 0xFF] ^ (hashCrc << 8);
        hashCrc = CRC16_TABLE[((hashCrc >> 8) ^ b3) & 0xFF] ^ (hashCrc << 8);
      }
      crc = CRC16_TABLE[((crc >> 8) ^ b1) & 0xFF] ^ (crc << 8);
      crc = CRC16_TABLE[((crc >> 8) ^ b2) & 0xFF] ^ (crc << 8);
      crc = CRC16_TABLE[((crc >> 8) ^ b3) & 0xFF] ^ (crc << 8);
    } else {
      // 3-byte UTF-8
      const b1 = (charCode >> 12) | 0xE0;
      const b2 = ((charCode >> 6) & 0x3F) | 0x80;
      const b3 = (charCode & 0x3F) | 0x80;
      if (start !== -1) {
        hashCrc = CRC16_TABLE[((hashCrc >> 8) ^ b1) & 0xFF] ^ (hashCrc << 8);
        hashCrc = CRC16_TABLE[((hashCrc >> 8) ^ b2) & 0xFF] ^ (hashCrc << 8);
        hashCrc = CRC16_TABLE[((hashCrc >> 8) ^ b3) & 0xFF] ^ (hashCrc << 8);
      }
      crc = CRC16_TABLE[((crc >> 8) ^ b1) & 0xFF] ^ (crc << 8);
      crc = CRC16_TABLE[((crc >> 8) ^ b2) & 0xFF] ^ (crc << 8);
      crc = CRC16_TABLE[((crc >> 8) ^ b3) & 0xFF] ^ (crc << 8);
    }
  }

  return crc & HASH_SLOT_MASK;
}

/**
 * Calculate Redis cluster slot for a Buffer key
 * Slightly faster than string version for Buffer inputs
 */
export function calculateSlotBuffer(key: Buffer): number {
  let start = -1;
  let crc = 0;
  let hashCrc = 0;
  const len = key.length;

  for (let i = 0; i < len; i++) {
    const byte = key[i];

    if (start === -1) {
      if (byte === 0x7B) { // '{'
        start = i;
      }
    } else if (byte === 0x7D) { // '}'
      if (i - 1 !== start) {
        return hashCrc & HASH_SLOT_MASK;
      }
    } else {
      hashCrc = CRC16_TABLE[((hashCrc >> 8) ^ byte) & 0xFF] ^ (hashCrc << 8);
    }

    crc = CRC16_TABLE[((crc >> 8) ^ byte) & 0xFF] ^ (crc << 8);
  }

  return crc & HASH_SLOT_MASK;
}

/**
 * Calculate slot for a RedisArgument (string or Buffer)
 */
export function calculateSlot(key: string | Buffer): number {
  return typeof key === 'string' ? calculateSlotString(key) : calculateSlotBuffer(key);
}
