import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'mocha';
import {
  EligibilityResolver,
  createEligibilityResolver,
  createMockRecordFetcher,
  createDefaultResolver,
  type CommandRecord,
} from './eligibility';

describe('Eligibility', () => {
  describe('EligibilityResolver', () => {
    let resolver: EligibilityResolver;

    beforeEach(async () => {
      resolver = await createDefaultResolver();
    });

    describe('simple commands', () => {
      it('returns eligible true for SET command', () => {
        assert.equal(resolver.getEligibility(['SET', 'key', 'value']).eligible, true);
      });

      it('returns eligible true for GET command', () => {
        assert.equal(resolver.getEligibility(['GET', 'key']).eligible, true);
      });

      it('returns eligible true for HSET command', () => {
        assert.equal(resolver.getEligibility(['HSET', 'key', 'field', 'value']).eligible, true);
      });

      it('handles Buffer command names', () => {
        assert.equal(resolver.getEligibility([Buffer.from('SET'), 'key', 'value']).eligible, true);
      });

      it('returns false for unknown command', () => {
        assert.equal(resolver.getEligibility(['UNKNOWNCOMMAND', 'arg']).eligible, false);
      });

      it('returns false for empty args', () => {
        assert.equal(resolver.getEligibility([]).eligible, false);
      });
    });

    describe('keyless commands', () => {
      it('returns eligible true for TIME', () => {
        assert.equal(resolver.getEligibility(['TIME']).eligible, true);
      });

      it('returns eligible true for PING', () => {
        assert.equal(resolver.getEligibility(['PING']).eligible, true);
      });
    });

    describe('commands with subcommands', () => {
      it('returns eligible true for OBJECT ENCODING', () => {
        assert.equal(resolver.getEligibility(['OBJECT', 'ENCODING', 'mykey']).eligible, true);
      });

      it('returns eligible for parent command without subcommand', () => {
        const result = resolver.getEligibility(['OBJECT']);
        assert.equal(result.eligible, true);
      });

      it('returns eligible for unknown subcommand (uses parent attrs)', () => {
        const result = resolver.getEligibility(['OBJECT', 'UNKNOWNSUB']);
        assert.equal(result.eligible, true);
      });
    });

    describe('getEligibility with slot', () => {
      it('returns slot for SET command', () => {
        const result = resolver.getEligibility(['SET', 'key', 'value']);
        assert.equal(result.eligible, true);
        if (result.eligible) {
          assert.equal(typeof result.slot, 'number');
          assert.ok(result.slot >= 0 && result.slot <= 16383);
        }
      });

      it('returns SLOT_NO_SLOT (0xFFFF) for keyless PING', () => {
        const result = resolver.getEligibility(['PING']);
        assert.equal(result.eligible, true);
        if (result.eligible) {
          assert.equal(result.slot, 0xFFFF);
        }
      });

      it('returns slot for OBJECT ENCODING using key at index 2', () => {
        const result = resolver.getEligibility(['OBJECT', 'ENCODING', 'mykey']);
        assert.equal(result.eligible, true);
        if (result.eligible) {
          assert.equal(typeof result.slot, 'number');
          assert.ok(result.slot >= 0 && result.slot <= 16383);
        }
      });
    });

    describe('blocking commands', () => {
      it('returns eligible true for XREAD without BLOCK', () => {
        const result = resolver.getEligibility(['XREAD', 'STREAMS', 'mystream', '0']);
        assert.equal(result.eligible, true);
      });

      it('returns eligible false for XREAD with BLOCK', () => {
        const result = resolver.getEligibility(['XREAD', 'BLOCK', '0', 'STREAMS', 'mystream', '0']);
        assert.equal(result.eligible, false);
      });

      it('returns eligible false for XREAD with lowercase block', () => {
        const result = resolver.getEligibility(['XREAD', 'block', '0', 'STREAMS', 'mystream', '0']);
        assert.equal(result.eligible, false);
      });

      it('returns eligible true for XREADGROUP without BLOCK', () => {
        const result = resolver.getEligibility(['XREADGROUP', 'GROUP', 'mygroup', 'myconsumer', 'STREAMS', 'mystream', '>']);
        assert.equal(result.eligible, true);
      });

      it('returns eligible false for XREADGROUP with BLOCK', () => {
        const result = resolver.getEligibility(['XREADGROUP', 'GROUP', 'mygroup', 'myconsumer', 'BLOCK', '0', 'STREAMS', 'mystream', '>']);
        assert.equal(result.eligible, false);
      });
    });
  });

  describe('createEligibilityResolver', () => {
    it('creates resolver from fetcher', async () => {
      const resolver = await createEligibilityResolver(createMockRecordFetcher());
      assert.equal(resolver.getEligibility(['SET', 'key', 'value']).eligible, true);
    });

    it('builds structure for subcommands', async () => {
      const records: CommandRecord[] = [
        {
          name: 'PARENT',
          subcommands: [
            { name: 'SUB1' },
            { name: 'SUB2', blocking: { type: 'always' } },
          ],
        },
      ];

      const resolver = await createEligibilityResolver(async () => records);

      assert.equal(resolver.getEligibility(['PARENT', 'SUB1']).eligible, true);
      assert.equal(resolver.getEligibility(['PARENT', 'SUB2']).eligible, false);
    });

    it('handles keyPosition in subcommands', async () => {
      const records: CommandRecord[] = [
        {
          name: 'CMD',
          subcommands: [
            { name: 'SUB', keyPosition: { index: 3 } },
          ],
        },
      ];

      const resolver = await createEligibilityResolver(async () => records);

      const result = resolver.getEligibility(['CMD', 'SUB', 'arg', 'mykey']);
      assert.equal(result.eligible, true);
      if (result.eligible) {
        assert.equal(typeof result.slot, 'number');
      }
    });

    it('handles keyless commands', async () => {
      const records: CommandRecord[] = [
        { name: 'NOKEYS', keyPosition: { keyless: true } },
      ];

      const resolver = await createEligibilityResolver(async () => records);

      const result = resolver.getEligibility(['NOKEYS']);
      assert.equal(result.eligible, true);
      if (result.eligible) {
        assert.equal(result.slot, 0xFFFF);
      }
    });

    it('handles always blocking commands', async () => {
      const records: CommandRecord[] = [
        { name: 'BLPOP', blocking: { type: 'always' } },
      ];

      const resolver = await createEligibilityResolver(async () => records);

      assert.equal(resolver.getEligibility(['BLPOP', 'key', '0']).eligible, false);
    });

    it('handles conditional blocking commands', async () => {
      const records: CommandRecord[] = [
        { name: 'XREAD', blocking: { type: 'conditional', argName: 'BLOCK' } },
      ];

      const resolver = await createEligibilityResolver(async () => records);

      assert.equal(resolver.getEligibility(['XREAD', 'STREAMS', 'stream', '0']).eligible, true);
      assert.equal(resolver.getEligibility(['XREAD', 'BLOCK', '0', 'STREAMS', 'stream', '0']).eligible, false);
    });

    it('handles blocking in subcommands', async () => {
      const records: CommandRecord[] = [
        {
          name: 'PARENT',
          subcommands: [
            { name: 'BLOCKING', blocking: { type: 'always' } },
            { name: 'NONBLOCKING' },
          ],
        },
      ];

      const resolver = await createEligibilityResolver(async () => records);

      assert.equal(resolver.getEligibility(['PARENT', 'BLOCKING', 'arg']).eligible, false);
      assert.equal(resolver.getEligibility(['PARENT', 'NONBLOCKING', 'arg']).eligible, true);
    });
  });
});
