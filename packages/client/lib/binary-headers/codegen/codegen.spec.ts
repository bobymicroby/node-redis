import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  field,
  fixed,
  bitfield,
  message,
  protocol,
} from './schema';

describe('Schema Helper Functions', () => {
  describe('field()', () => {
    const cases = [
      { name: 'basic uint8', args: ['count', 'uint8', 0] as const, opts: undefined, expected: { kind: 'variable', name: 'count', type: 'uint8', offset: 0, endian: undefined, validation: undefined, nullValue: undefined, sinceVersion: undefined } },
      { name: 'uint16 big-endian', args: ['slot', 'uint16', 2] as const, opts: { endian: 'big' as const }, expected: { kind: 'variable', name: 'slot', type: 'uint16', offset: 2, endian: 'big', validation: undefined, nullValue: undefined, sinceVersion: undefined } },
      { name: 'with min', args: ['value', 'uint8', 0] as const, opts: { min: 1 }, expected: { kind: 'variable', name: 'value', type: 'uint8', offset: 0, endian: undefined, validation: { min: 1 }, nullValue: undefined, sinceVersion: undefined } },
      { name: 'with max', args: ['value', 'uint8', 0] as const, opts: { max: 127 }, expected: { kind: 'variable', name: 'value', type: 'uint8', offset: 0, endian: undefined, validation: { max: 127 }, nullValue: undefined, sinceVersion: undefined } },
      { name: 'with min and max', args: ['cmd', 'uint8', 8] as const, opts: { min: 1, max: 127 }, expected: { kind: 'variable', name: 'cmd', type: 'uint8', offset: 8, endian: undefined, validation: { min: 1, max: 127 }, nullValue: undefined, sinceVersion: undefined } },
      { name: 'with nullValue', args: ['slot', 'uint16', 2] as const, opts: { nullValue: 0xFFFF }, expected: { kind: 'variable', name: 'slot', type: 'uint16', offset: 2, endian: undefined, validation: undefined, nullValue: 0xFFFF, sinceVersion: undefined } },
      { name: 'with sinceVersion', args: ['newField', 'uint32', 4] as const, opts: { sinceVersion: 2 }, expected: { kind: 'variable', name: 'newField', type: 'uint32', offset: 4, endian: undefined, validation: undefined, nullValue: undefined, sinceVersion: 2 } },
    ];

    for (const { name, args, opts, expected } of cases) {
      it(name, () => assert.deepEqual(field(args[0], args[1], args[2], opts), expected));
    }
  });

  describe('fixed()', () => {
    const cases = [
      { name: 'uint8', args: ['designator', 'uint8', 0, 0xAE] as const, opts: undefined, expected: { kind: 'fixed', name: 'designator', type: 'uint8', offset: 0, value: 0xAE, endian: undefined, sinceVersion: undefined } },
      { name: 'uint16 big-endian', args: ['magic', 'uint16', 0, 0xCAFE] as const, opts: { endian: 'big' as const }, expected: { kind: 'fixed', name: 'magic', type: 'uint16', offset: 0, value: 0xCAFE, endian: 'big', sinceVersion: undefined } },
      { name: 'with sinceVersion', args: ['version', 'uint8', 1, 0x02] as const, opts: { sinceVersion: 2 }, expected: { kind: 'fixed', name: 'version', type: 'uint8', offset: 1, value: 0x02, endian: undefined, sinceVersion: 2 } },
    ];

    for (const { name, args, opts, expected } of cases) {
      it(name, () => assert.deepEqual(fixed(args[0], args[1], args[2], args[3], opts), expected));
    }
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
        sinceVersion: undefined,
      });
    });

    it('with sinceVersion', () => {
      const result = bitfield('newFlags', 10, [{ name: 'value', bits: 8, mask: 0xFF }], 2);
      assert.equal(result.sinceVersion, 2);
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
      const result = protocol('Test', 1, [], 'Description');
      assert.equal(result.name, 'Test');
      assert.equal(result.version, 1);
      assert.equal(result.description, 'Description');
      assert.equal(result.messages.length, 0);
    });
  });
});
