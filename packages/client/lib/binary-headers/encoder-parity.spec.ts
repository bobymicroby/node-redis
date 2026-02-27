import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import encodeCommand, { encodeCommandWithLength } from '../RESP/encoder';
import type { RedisArgument } from '../RESP/types';

/**
 * Computes the total byte length of encoded chunks.
 */
function computeByteLength(encoded: ReadonlyArray<RedisArgument>): number {
  let total = 0;
  for (const chunk of encoded) {
    if (typeof chunk === 'string') {
      total += Buffer.byteLength(chunk);
    } else {
      total += chunk.length;
    }
  }
  return total;
}

/**
 * Materializes encoded chunks into a single Buffer for wire-level assertions.
 */
function materializeEncoded(encoded: ReadonlyArray<RedisArgument>): Buffer {
  const chunks = new Array<Buffer>(encoded.length);
  for (let i = 0; i < encoded.length; i++) {
    const chunk = encoded[i];
    chunks[i] = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
  }
  return Buffer.concat(chunks);
}

/**
 * Compares two encoded outputs for equality.
 * Handles both string and Buffer chunks.
 */
function encodedEqual(a: ReadonlyArray<RedisArgument>, b: ReadonlyArray<RedisArgument>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const chunkA = a[i];
    const chunkB = b[i];
    if (typeof chunkA === 'string' && typeof chunkB === 'string') {
      if (chunkA !== chunkB) return false;
    } else if (Buffer.isBuffer(chunkA) && Buffer.isBuffer(chunkB)) {
      if (!chunkA.equals(chunkB)) return false;
    } else {
      return false;
    }
  }
  return true;
}

describe('Encoder Parity (encodeCommand vs encodeCommandWithLength)', function () {
  describe('encoded output equality', function () {
    const cases: Array<{ name: string; args: ReadonlyArray<RedisArgument> }> = [
      // Basic commands - strings only
      { name: 'PING (no args)', args: ['PING'] },
      { name: 'GET key', args: ['GET', 'mykey'] },
      { name: 'SET key value', args: ['SET', 'mykey', 'myvalue'] },
      { name: 'HSET hash field value', args: ['HSET', 'myhash', 'field1', 'value1'] },
      { name: 'MSET multiple keys', args: ['MSET', 'k1', 'v1', 'k2', 'v2', 'k3', 'v3'] },

      // Unicode strings (multi-byte characters)
      { name: 'Hebrew chars (2 bytes each)', args: ['SET', 'key', 'אבגד'] },
      { name: 'Emoji (4 bytes each)', args: ['SET', 'key', '🐣🐤🐥'] },
      { name: 'Mixed ASCII and Unicode', args: ['SET', 'hello', 'world🌍'] },

      // Empty and whitespace
      { name: 'empty string value', args: ['SET', 'key', ''] },
      { name: 'whitespace value', args: ['SET', 'key', '   '] },
      { name: 'newlines in value', args: ['SET', 'key', 'line1\r\nline2'] },

      // Large strings
      { name: '1KB value', args: ['SET', 'key', 'x'.repeat(1024)] },
      { name: '10KB value', args: ['SET', 'key', 'y'.repeat(10240)] },

      // Buffer arguments
      { name: 'single Buffer arg', args: [Buffer.from('PING')] },
      { name: 'SET with Buffer value', args: ['SET', 'key', Buffer.from('binary-data')] },
      { name: 'SET with Buffer key and value', args: ['SET', Buffer.from('binkey'), Buffer.from('binval')] },
      { name: 'multiple Buffers', args: ['MSET', Buffer.from('k1'), Buffer.from('v1'), Buffer.from('k2'), Buffer.from('v2')] },

      // Mixed strings and Buffers
      { name: 'string then Buffer', args: ['SET', 'strkey', Buffer.from('bufval')] },
      { name: 'Buffer then string', args: ['SET', Buffer.from('bufkey'), 'strval'] },
      { name: 'alternating string/Buffer', args: ['MSET', 'k1', Buffer.from('v1'), Buffer.from('k2'), 'v2'] },

      // Large Buffers
      { name: '1KB Buffer', args: ['SET', 'key', Buffer.alloc(1024, 0xAB)] },
      { name: '10KB Buffer', args: ['SET', 'key', Buffer.alloc(10240, 0xCD)] },

      // Edge cases for argument counts
      { name: 'many string args (10)', args: ['CMD', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] },
      { name: 'many string args (100)', args: ['CMD', ...Array.from({ length: 100 }, (_, i) => `arg${i}`)] },

      // Special characters in strings
      { name: 'null bytes in string', args: ['SET', 'key', 'before\x00after'] },
      { name: 'binary-like string', args: ['SET', 'key', '\x00\x01\x02\x03'] },

      // Numeric-looking strings
      { name: 'numeric string value', args: ['SET', 'key', '12345'] },
      { name: 'float string value', args: ['SET', 'key', '3.14159'] },
      { name: 'negative number string', args: ['SET', 'key', '-999'] },

      // Hash tag keys (cluster)
      { name: 'hash tag key', args: ['SET', '{user:1000}.profile', 'data'] },
      { name: 'multiple hash tag keys', args: ['MSET', '{tag}k1', 'v1', '{tag}k2', 'v2'] },
    ];

    for (const tc of cases) {
      it(tc.name, function () {
        const encoded = encodeCommand(tc.args);
        const { encoded: encodedWithLen } = encodeCommandWithLength(tc.args);

        assert.ok(
          encodedEqual(encoded, encodedWithLen),
          `Encoded outputs differ:\n  encodeCommand: ${JSON.stringify(encoded)}\n  encodeCommandWithLength: ${JSON.stringify(encodedWithLen)}`
        );
      });
    }
  });

  describe('wire-level correctness (golden fixtures)', function () {
    const cases: Array<{ name: string; args: ReadonlyArray<RedisArgument>; expected: Buffer }> = [
      {
        name: 'PING',
        args: ['PING'],
        expected: Buffer.from('*1\r\n$4\r\nPING\r\n')
      },
      {
        name: 'SET key value',
        args: ['SET', 'key', 'value'],
        expected: Buffer.from('*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$5\r\nvalue\r\n')
      },
      {
        name: 'SET with UTF-8 payload',
        args: ['SET', 'key', '🐣'],
        expected: Buffer.from('*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$4\r\n🐣\r\n')
      },
      {
        name: 'SET with empty payload',
        args: ['SET', 'key', ''],
        expected: Buffer.from('*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$0\r\n\r\n')
      },
      {
        name: 'SET with binary Buffer payload',
        args: ['SET', 'bin', Buffer.from([0x00, 0xFF, 0x41])],
        expected: Buffer.concat([
          Buffer.from('*3\r\n$3\r\nSET\r\n$3\r\nbin\r\n$3\r\n'),
          Buffer.from([0x00, 0xFF, 0x41]),
          Buffer.from('\r\n')
        ])
      }
    ];

    for (const tc of cases) {
      it(tc.name, function () {
        const encoded = encodeCommand(tc.args);
        const withLen = encodeCommandWithLength(tc.args);

        assert.deepEqual(
          materializeEncoded(encoded),
          tc.expected,
          'encodeCommand should match golden RESP bytes'
        );
        assert.deepEqual(
          materializeEncoded(withLen.encoded),
          tc.expected,
          'encodeCommandWithLength should match golden RESP bytes'
        );
        assert.equal(
          withLen.byteLength,
          tc.expected.length,
          'byteLength should match golden RESP payload length'
        );
      });
    }
  });

  describe('byteLength correctness', function () {
    const cases: Array<{ name: string; args: ReadonlyArray<RedisArgument> }> = [
      // ASCII strings - easy to verify
      { name: 'PING', args: ['PING'] },
      { name: 'GET key', args: ['GET', 'key'] },
      { name: 'SET key value', args: ['SET', 'key', 'value'] },

      // Multi-byte UTF-8
      { name: 'Hebrew (2 bytes/char)', args: ['SET', 'k', 'אב'] }, // 2 chars * 2 bytes = 4 bytes
      { name: 'Emoji (4 bytes/char)', args: ['SET', 'k', '🐣'] }, // 1 char * 4 bytes = 4 bytes

      // Buffers
      { name: 'Buffer value', args: ['SET', 'key', Buffer.from('test')] },
      { name: 'multiple Buffers', args: ['MSET', Buffer.from('k1'), Buffer.from('v1')] },

      // Large payloads
      { name: '1KB string', args: ['SET', 'k', 'x'.repeat(1024)] },
      { name: '1KB Buffer', args: ['SET', 'k', Buffer.alloc(1024)] },

      // Empty values
      { name: 'empty string', args: ['SET', 'k', ''] },
      { name: 'empty Buffer', args: ['SET', 'k', Buffer.alloc(0)] },
    ];

    for (const tc of cases) {
      it(tc.name, function () {
        const { encoded, byteLength } = encodeCommandWithLength(tc.args);
        const computedLength = computeByteLength(encoded);

        assert.equal(
          byteLength,
          computedLength,
          `byteLength mismatch: reported ${byteLength}, computed ${computedLength}`
        );
      });
    }
  });

  describe('byteLength matches encodeCommand output', function () {
    const cases: Array<{ name: string; args: ReadonlyArray<RedisArgument> }> = [
      { name: 'simple command', args: ['PING'] },
      { name: 'with string args', args: ['SET', 'key', 'value'] },
      { name: 'with Buffer args', args: ['SET', 'key', Buffer.from('data')] },
      { name: 'mixed args', args: ['MSET', 'k1', Buffer.from('v1'), Buffer.from('k2'), 'v2'] },
      { name: 'unicode', args: ['SET', 'key', '你好世界'] },
      { name: 'large payload', args: ['SET', 'key', 'x'.repeat(10000)] },
    ];

    for (const tc of cases) {
      it(tc.name, function () {
        const encoded = encodeCommand(tc.args);
        const { byteLength } = encodeCommandWithLength(tc.args);
        const encodedByteLength = computeByteLength(encoded);

        assert.equal(
          byteLength,
          encodedByteLength,
          `byteLength from encodeCommandWithLength (${byteLength}) doesn't match computed length from encodeCommand output (${encodedByteLength})`
        );
      });
    }
  });

  describe('error handling parity', function () {
    const errorCases: Array<{ name: string; args: ReadonlyArray<unknown>; expectedError: string }> = [
      { name: 'number argument', args: ['SET', 'key', 123], expectedError: 'must be of type' },
      { name: 'null argument', args: ['SET', 'key', null], expectedError: 'must be of type' },
      { name: 'undefined argument', args: ['SET', 'key', undefined], expectedError: 'must be of type' },
      { name: 'object argument', args: ['SET', 'key', { foo: 'bar' }], expectedError: 'must be of type' },
      { name: 'array argument', args: ['SET', 'key', ['nested']], expectedError: 'must be of type' },
    ];

    for (const tc of errorCases) {
      it(`${tc.name}: both functions throw`, function () {
        let encodeError: Error | null = null;
        let encodeWithLenError: Error | null = null;

        try {
          encodeCommand(tc.args as ReadonlyArray<RedisArgument>);
        } catch (e) {
          encodeError = e as Error;
        }

        try {
          encodeCommandWithLength(tc.args as ReadonlyArray<RedisArgument>);
        } catch (e) {
          encodeWithLenError = e as Error;
        }

        assert.ok(encodeError, 'encodeCommand should throw');
        assert.ok(encodeWithLenError, 'encodeCommandWithLength should throw');
        assert.ok(
          encodeError.message.includes(tc.expectedError),
          `encodeCommand error should contain "${tc.expectedError}"`
        );
        assert.ok(
          encodeWithLenError.message.includes(tc.expectedError),
          `encodeCommandWithLength error should contain "${tc.expectedError}"`
        );
      });
    }
  });

  describe('determinism', function () {
    it('multiple calls produce identical results', function () {
      const args: ReadonlyArray<RedisArgument> = ['SET', 'key', 'value'];

      const results = Array.from({ length: 10 }, () => ({
        encoded: encodeCommand(args),
        withLen: encodeCommandWithLength(args),
      }));

      for (let i = 1; i < results.length; i++) {
        assert.ok(
          encodedEqual(results[0].encoded, results[i].encoded),
          'encodeCommand should be deterministic'
        );
        assert.ok(
          encodedEqual(results[0].withLen.encoded, results[i].withLen.encoded),
          'encodeCommandWithLength.encoded should be deterministic'
        );
        assert.equal(
          results[0].withLen.byteLength,
          results[i].withLen.byteLength,
          'encodeCommandWithLength.byteLength should be deterministic'
        );
      }
    });

    it('documents buffer aliasing (no defensive copy of argument Buffers)', function () {
      const buf = Buffer.from('original');
      const args: ReadonlyArray<RedisArgument> = ['SET', 'key', buf];
      const encoded = encodeCommand(args);
      const withLen = encodeCommandWithLength(args);

      const before1 = materializeEncoded(encoded);
      const before2 = materializeEncoded(withLen.encoded);
      buf.write('MODIFIED');
      const after1 = materializeEncoded(encoded);
      const after2 = materializeEncoded(withLen.encoded);

      assert.notDeepEqual(after1, before1, 'encodeCommand output should reflect buffer mutation');
      assert.notDeepEqual(after2, before2, 'encodeCommandWithLength output should reflect buffer mutation');
      assert.equal(after1.includes(Buffer.from('MODIFIED')), true);
      assert.equal(after2.includes(Buffer.from('MODIFIED')), true);
      assert.equal(withLen.byteLength, before2.length, 'byteLength should stay stable for same-size mutation');
      assert.equal(withLen.byteLength, after2.length, 'byteLength should stay stable for same-size mutation');
    });
  });
});
