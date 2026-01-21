import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  constant,
  field,
  fixed,
  bitfield,
  padding,
  message,
  protocol,
} from './schema';
import { generateFromSchema } from './generator';


describe('Schema Helper Functions', () => {
  describe('constant()', () => {
    const tests = [
      { name: 'basic', input: { n: 'FOO', v: 42 }, expected: { name: 'FOO', value: 42, description: undefined } },
      { name: 'with description', input: { n: 'BAR', v: 0xFF, d: 'A byte' }, expected: { name: 'BAR', value: 0xFF, description: 'A byte' } },
      { name: 'zero value', input: { n: 'ZERO', v: 0 }, expected: { name: 'ZERO', value: 0, description: undefined } },
    ];

    for (const tt of tests) {
      it(tt.name, () => {
        const result = constant(tt.input.n, tt.input.v, tt.input.d);
        assert.deepEqual(result, tt.expected);
      });
    }
  });

  describe('field()', () => {
    it('basic uint8', () => {
      const result = field('count', 'uint8', 0);
      assert.deepEqual(result, { kind: 'variable', name: 'count', type: 'uint8', offset: 0, endian: undefined, validation: undefined });
    });

    it('uint16 big-endian', () => {
      const result = field('slot', 'uint16', 2, { endian: 'big' });
      assert.deepEqual(result, { kind: 'variable', name: 'slot', type: 'uint16', offset: 2, endian: 'big', validation: undefined });
    });

    it('with min only', () => {
      const result = field('value', 'uint8', 0, { min: 1 });
      assert.deepEqual(result, { kind: 'variable', name: 'value', type: 'uint8', offset: 0, endian: undefined, validation: { min: 1 } });
    });

    it('with max only', () => {
      const result = field('value', 'uint8', 0, { max: 127 });
      assert.deepEqual(result, { kind: 'variable', name: 'value', type: 'uint8', offset: 0, endian: undefined, validation: { max: 127 } });
    });

    it('with min and max', () => {
      const result = field('cmd', 'uint8', 8, { min: 1, max: 127 });
      assert.deepEqual(result, { kind: 'variable', name: 'cmd', type: 'uint8', offset: 8, endian: undefined, validation: { min: 1, max: 127 } });
    });
  });

  describe('fixed()', () => {
    it('uint8', () => {
      const result = fixed('designator', 'uint8', 0, 0xAE);
      assert.deepEqual(result, { kind: 'fixed', name: 'designator', type: 'uint8', offset: 0, value: 0xAE });
    });

    it('uint16 big-endian', () => {
      const result = fixed('magic', 'uint16', 0, 0xCAFE, { endian: 'big' });
      assert.deepEqual(result, { kind: 'fixed', name: 'magic', type: 'uint16', offset: 0, value: 0xCAFE, endian: 'big' });
    });
  });

  describe('bitfield()', () => {
    it('creates bitfield group', () => {
      const result = bitfield('flags', 8, [
        { name: 'count', bits: 7, mask: 0x7F },
        { name: 'error', bits: 1, mask: 0x80 },
      ]);
      assert.deepEqual(result, {
        kind: 'bitfield',
        name: 'flags',
        offset: 8,
        fields: [
          { name: 'count', bits: 7, mask: 0x7F },
          { name: 'error', bits: 1, mask: 0x80 },
        ],
      });
    });
  });

  describe('padding()', () => {
    it('single byte', () => {
      const result = padding(7, 1);
      assert.deepEqual(result, { kind: 'padding', offset: 7, size: 1 });
    });

    it('three bytes', () => {
      const result = padding(13, 3);
      assert.deepEqual(result, { kind: 'padding', offset: 13, size: 3 });
    });
  });

  describe('message()', () => {
    it('creates message schema', () => {
      const result = message('Header', 4, [field('value', 'uint32', 0)], 'A header');
      assert.equal(result.name, 'Header');
      assert.equal(result.size, 4);
      assert.equal(result.description, 'A header');
      assert.equal(result.fields.length, 1);
    });
  });

  describe('protocol()', () => {
    it('creates protocol schema', () => {
      const result = protocol('Test', 1, [constant('V', 1)], [], 'Description');
      assert.equal(result.name, 'Test');
      assert.equal(result.version, 1);
      assert.equal(result.description, 'Description');
      assert.equal(result.constants.length, 1);
    });
  });
});


describe('Generator Output (Inline Snapshots)', () => {
  describe('simple schema', () => {
    const simpleSchema = protocol(
      'TestProtocol',
      1,
      [
        constant('DESIGNATOR', 0xAE, 'Magic byte'),
        constant('VERSION', 1),
        constant('HEADER_SIZE', 8),
      ],
      [
        message('TestHeader', 8, [
          fixed('designator', 'uint8', 0, 0xAE),
          fixed('version', 'uint8', 1, 0x01),
          field('slot', 'uint16', 2, { endian: 'big', min: 0, max: 0x3FFF }),
          field('length', 'uint32', 4, { endian: 'big' }),
        ], 'Test header'),
      ],
    );

    const output = generateFromSchema(simpleSchema);

    it('generates constants', () => {
      assert.equal(output.constants, `\
export const BINHDR = {
  DESIGNATOR: 0xAE, // Magic byte
  VERSION: 1,
  HEADER_SIZE: 8,
} as const;

export type BINHDR = typeof BINHDR;`);
    });

    it('generates types', () => {
      assert.equal(output.types, `\
// Generated from TestProtocol protocol v1
//

/**
 * Test header
 * Wire format:
 * - Byte 0: designator
 * - Byte 1: version
 * - Bytes 2-3: slot
 * - Bytes 4-7: length
 */
export interface TestHeader {
  readonly designator: number;
  readonly version: number;
  readonly slot: number;
  readonly length: number;
}
`);
    });

    it('generates encoder', () => {
      assert.equal(output.encoder, `\
// Generated from TestProtocol protocol v1

import { BINHDR } from './constants';
import type { TestHeader } from './types';

export type CreateTestHeaderError =
  | 'invalid_slot';

export type CreateTestHeaderResult =
  | { readonly success: true; readonly header: TestHeader }
  | { readonly success: false; readonly error: CreateTestHeaderError };

export function createTestHeader(slot: number, length: number): CreateTestHeaderResult {
  if (!Number.isInteger(slot) || slot < 0 || slot > 0x3FFF) {
    return { success: false, error: 'invalid_slot' };
  }


  const header: TestHeader = {
    designator: 0xAE,
    version: 1,
    slot,
    length,
  };

  return { success: true, header };
}

export function encodeTestHeader(header: TestHeader): Buffer {
  const buffer = Buffer.allocUnsafe(8);

  buffer[0] = 0xAE;
  buffer[1] = 1;
  buffer.writeUInt16BE(header.slot, 2);
  buffer.writeUInt32BE(header.length, 4);

  return buffer;
}

export type EncodeTestHeaderIntoResult =
  | { readonly success: true; readonly bytesWritten: number }
  | { readonly success: false; readonly error: 'buffer_too_small' };

export function encodeTestHeaderInto(header: TestHeader, buffer: Buffer, offset: number): EncodeTestHeaderIntoResult {
  if (buffer.length < offset + 8) {
    return { success: false, error: 'buffer_too_small' };
  }

  buffer[offset + 0] = 0xAE;
  buffer[offset + 1] = 1;
  buffer.writeUInt16BE(header.slot, offset + 2);
  buffer.writeUInt32BE(header.length, offset + 4);

  return { success: true, bytesWritten: 8 };
}
`);
    });

    it('generates decoder', () => {
      assert.equal(output.decoder, `\
// Generated from TestProtocol protocol v1

import { BINHDR } from './constants';
import type { TestHeader } from './types';

export type ParseTestHeaderResult =
  | { readonly success: true; readonly header: TestHeader; readonly bytesConsumed: number }
  | { readonly success: false; readonly error: ParseTestHeaderError };

export type ParseTestHeaderError = 'buffer_too_small' | 'invalid_designator' | 'invalid_version';

export function parseTestHeader(buffer: Buffer, offset: number = 0): ParseTestHeaderResult {
  if (buffer.length < offset + 8) {
    return { success: false, error: 'buffer_too_small' };
  }

  if (buffer[offset + 0] !== 0xAE) {
    return { success: false, error: 'invalid_designator' };
  }
  if (buffer[offset + 1] !== 1) {
    return { success: false, error: 'invalid_version' };
  }

  const header: TestHeader = {
    designator: 0xAE,
    version: 1,
    slot: buffer.readUInt16BE(offset + 2),
    length: buffer.readUInt32BE(offset + 4),
  };

  return {
    success: true,
    header,
    bytesConsumed: 8,
  };
}

export function isBinaryHeaderDesignator(byte: number): boolean {
  return byte === BINHDR.DESIGNATOR;
}

export function startsWithBinaryHeader(buffer: Buffer, offset: number = 0): boolean {
  return buffer.length > offset && isBinaryHeaderDesignator(buffer[offset]);
}

export function extractCommandCount(flagsByte: number): number {
  return flagsByte & BINHDR.COMMAND_COUNT_MASK;
}

export function hasProtocolError(flagsByte: number): boolean {
  return (flagsByte & BINHDR.PROTOCOL_ERROR_BIT) !== 0;
}`);
    });
  });

  describe('bitfield schema', () => {
    const bitfieldSchema = protocol(
      'BitfieldProtocol',
      1,
      [
        constant('DESIGNATOR', 0xAE),
        constant('HEADER_SIZE', 16),
        constant('COMMAND_COUNT_MASK', 0x7F),
        constant('PROTOCOL_ERROR_BIT', 0x80),
      ],
      [
        message('ResponseHeader', 16, [
          fixed('designator', 'uint8', 0, 0xAE),
          fixed('version', 'uint8', 1, 0x01),
          padding(2, 2),
          field('length', 'uint32', 4, { endian: 'big' }),
          bitfield('flags', 8, [
            { name: 'commandCount', bits: 7, mask: 0x7F },
            { name: 'protocolError', bits: 1, mask: 0x80 },
          ]),
          field('requestId', 'uint32', 9, { endian: 'big' }),
          padding(13, 3),
        ], 'Response header with bitfields'),
      ],
    );

    const output = generateFromSchema(bitfieldSchema);

    it('generates constants with hex formatting', () => {
      assert.equal(output.constants, `\
export const BINHDR = {
  DESIGNATOR: 0xAE,
  HEADER_SIZE: 0x10,
  COMMAND_COUNT_MASK: 0x7F,
  PROTOCOL_ERROR_BIT: 0x80,
} as const;

export type BINHDR = typeof BINHDR;`);
    });

    it('generates types with boolean for 1-bit bitfield', () => {
      assert.equal(output.types, `\
// Generated from BitfieldProtocol protocol v1
//

/**
 * Response header with bitfields
 * Wire format:
 * - Byte 0: designator
 * - Byte 1: version
 * - Bytes 2-3: Reserved
 * - Bytes 4-7: length
 * - Byte 8: Flags (commandCount, protocolError)
 * - Bytes 9-12: requestId
 * - Bytes 13-15: Reserved
 */
export interface ResponseHeader {
  readonly designator: number;
  readonly version: number;
  readonly length: number;
  readonly commandCount: number;
  readonly protocolError: boolean;
  readonly requestId: number;
}
`);
    });

    it('generates encoder with bitfield encoding', () => {
      assert.equal(output.encoder, `\
// Generated from BitfieldProtocol protocol v1

import { BINHDR } from './constants';
import type { ResponseHeader } from './types';

export type CreateResponseHeaderError =
  | 'invalid_commandCount';

export type CreateResponseHeaderResult =
  | { readonly success: true; readonly header: ResponseHeader }
  | { readonly success: false; readonly error: CreateResponseHeaderError };

export function createResponseHeader(length: number, commandCount: number, protocolError: boolean, requestId: number): CreateResponseHeaderResult {
  if (!Number.isInteger(commandCount) || commandCount < 0 || commandCount > 0x7F) {
    return { success: false, error: 'invalid_commandCount' };
  }


  const header: ResponseHeader = {
    designator: 0xAE,
    version: 1,
    length,
    commandCount,
    protocolError,
    requestId,
  };

  return { success: true, header };
}

export function encodeResponseHeader(header: ResponseHeader): Buffer {
  const buffer = Buffer.allocUnsafe(16);

  buffer[0] = 0xAE;
  buffer[1] = 1;
  buffer[2] = 0;
  buffer[3] = 0;
  buffer.writeUInt32BE(header.length, 4);
  buffer[8] = (header.commandCount & 0x7F) | (header.protocolError ? 0x80 : 0);
  buffer.writeUInt32BE(header.requestId, 9);
  buffer[13] = 0;
  buffer[14] = 0;
  buffer[15] = 0;

  return buffer;
}

export type EncodeResponseHeaderIntoResult =
  | { readonly success: true; readonly bytesWritten: number }
  | { readonly success: false; readonly error: 'buffer_too_small' };

export function encodeResponseHeaderInto(header: ResponseHeader, buffer: Buffer, offset: number): EncodeResponseHeaderIntoResult {
  if (buffer.length < offset + 16) {
    return { success: false, error: 'buffer_too_small' };
  }

  buffer[offset + 0] = 0xAE;
  buffer[offset + 1] = 1;
  buffer[offset + 2] = 0;
  buffer[offset + 3] = 0;
  buffer.writeUInt32BE(header.length, offset + 4);
  buffer[offset + 8] = (header.commandCount & 0x7F) | (header.protocolError ? 0x80 : 0);
  buffer.writeUInt32BE(header.requestId, offset + 9);
  buffer[offset + 13] = 0;
  buffer[offset + 14] = 0;
  buffer[offset + 15] = 0;

  return { success: true, bytesWritten: 16 };
}
`);
    });

    it('generates decoder with bitfield decoding', () => {
      assert.equal(output.decoder, `\
// Generated from BitfieldProtocol protocol v1

import { BINHDR } from './constants';
import type { ResponseHeader } from './types';

export type ParseResponseHeaderResult =
  | { readonly success: true; readonly header: ResponseHeader; readonly bytesConsumed: number }
  | { readonly success: false; readonly error: ParseResponseHeaderError };

export type ParseResponseHeaderError = 'buffer_too_small' | 'invalid_designator' | 'invalid_version';

export function parseResponseHeader(buffer: Buffer, offset: number = 0): ParseResponseHeaderResult {
  if (buffer.length < offset + 16) {
    return { success: false, error: 'buffer_too_small' };
  }

  if (buffer[offset + 0] !== 0xAE) {
    return { success: false, error: 'invalid_designator' };
  }
  if (buffer[offset + 1] !== 1) {
    return { success: false, error: 'invalid_version' };
  }

  const header: ResponseHeader = {
    designator: 0xAE,
    version: 1,
    length: buffer.readUInt32BE(offset + 4),
    commandCount: buffer[offset + 8] & 0x7F,
    protocolError: (buffer[offset + 8] & 0x80) !== 0,
    requestId: buffer.readUInt32BE(offset + 9),
  };

  return {
    success: true,
    header,
    bytesConsumed: 16,
  };
}

export function isBinaryHeaderDesignator(byte: number): boolean {
  return byte === BINHDR.DESIGNATOR;
}

export function startsWithBinaryHeader(buffer: Buffer, offset: number = 0): boolean {
  return buffer.length > offset && isBinaryHeaderDesignator(buffer[offset]);
}

export function extractCommandCount(flagsByte: number): number {
  return flagsByte & BINHDR.COMMAND_COUNT_MASK;
}

export function hasProtocolError(flagsByte: number): boolean {
  return (flagsByte & BINHDR.PROTOCOL_ERROR_BIT) !== 0;
}`);
    });
  });
});
