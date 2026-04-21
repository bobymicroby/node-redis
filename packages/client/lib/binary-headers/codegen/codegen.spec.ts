import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { generateFlyweightCodecs } from './flyweight-generator';
import { BinaryHeadersProtocolV0 } from '../schemas/v0';

function generatedFile(name: string): string {
  const output = generateFlyweightCodecs(BinaryHeadersProtocolV0);
  const file = output.files.find(candidate => candidate.filename === name);
  assert.ok(file, `Missing generated file: ${name}`);
  return file.content;
}

describe('Codegen', () => {
  it('generates the v0 request and response codecs', () => {
    const output = generateFlyweightCodecs(BinaryHeadersProtocolV0);
    assert.deepEqual(
      output.files.map(file => file.filename).sort(),
      ['request-header-codec.ts', 'response-header-codec.ts']
    );
  });

  it('emits the v0 request header layout from the schema', () => {
    const requestCodec = generatedFile('request-header-codec.ts');
    assert.match(requestCodec, /Generated from BinaryHeaders protocol v0/);
    assert.match(requestCodec, /static readonly ENCODED_LENGTH = 10;/);
    assert.match(requestCodec, /static designatorConstantValue\(\): number \{\s+return 0x80;/);
    assert.match(requestCodec, /static slotEncodingOffset\(\): number \{\s+return 6;/);
    assert.match(requestCodec, /static clientIdxEncodingOffset\(\): number \{\s+return 8;/);
  });

  it('emits the v0 response header flags and client index fields', () => {
    const responseCodec = generatedFile('response-header-codec.ts');
    assert.match(responseCodec, /Generated from BinaryHeaders protocol v0/);
    assert.match(responseCodec, /static readonly ENCODED_LENGTH = 8;/);
    assert.match(responseCodec, /static protocolErrorEncodingOffset\(\): number \{\s+return 5;/);
    assert.match(responseCodec, /static clientIdxEncodingOffset\(\): number \{\s+return 6;/);
    assert.match(responseCodec, /commandCount\(\): number \{\s+return this\.\#buffer!\[.*\] & 0x7F;/s);
  });
});
