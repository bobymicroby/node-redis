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

    it('Buffer mutations do not affect subsequent calls', function () {
      const buf = Buffer.from('original');
      const args: ReadonlyArray<RedisArgument> = ['SET', 'key', buf];

      const result1 = encodeCommandWithLength(args);
      buf.write('MODIFIED');
      const result2 = encodeCommandWithLength(args);

      // The encoded output references the same buffer, so mutation affects it
      // This test documents the current behavior (no defensive copy)
      assert.equal(result1.byteLength, result2.byteLength, 'byteLength should be same');
    });
  });
});
