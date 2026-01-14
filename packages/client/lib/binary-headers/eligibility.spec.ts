import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'mocha';
import {
  EligibilityResolver,
  DynamicEligibilityResolverFactory,
  createMockBinhdrFetcher,
  createDefaultResolver,
  type CommandBinhdrRawReply,
} from './eligibility';

describe('Eligibility', () => {
  describe('EligibilityResolver', () => {
    let resolver: EligibilityResolver;

    beforeEach(async () => {
      resolver = await createDefaultResolver();
    });

    describe('simple commands', () => {
      it('returns true for eligible SET command', () => {
        assert.equal(resolver.isEligible(['SET', 'key', 'value']), true);
      });

      it('returns true for eligible GET command', () => {
        assert.equal(resolver.isEligible(['GET', 'key']), true);
      });

      it('returns true for eligible HSET command', () => {
        assert.equal(resolver.isEligible(['HSET', 'key', 'field', 'value']), true);
      });

      it('handles Buffer command names', () => {
        assert.equal(resolver.isEligible([Buffer.from('SET'), 'key', 'value']), true);
      });

      it('returns false for unknown command', () => {
        assert.equal(resolver.isEligible(['UNKNOWNCOMMAND', 'arg']), false);
      });

      it('returns false for empty args', () => {
        assert.equal(resolver.isEligible([]), false);
      });
    });

    describe('keyless commands', () => {
      it('returns true for TIME', () => {
        assert.equal(resolver.isEligible(['TIME']), true);
      });

      it('returns true for PING', () => {
        assert.equal(resolver.isEligible(['PING']), true);
      });
    });

    describe('commands with subcommands', () => {
      it('returns true for eligible OBJECT ENCODING', () => {
        assert.equal(resolver.isEligible(['OBJECT', 'ENCODING', 'mykey']), true);
      });

      it('returns false when subcommand not found (falls back to parent)', () => {
        // OBJECT itself is not eligible, so unknown subcommand returns false
        assert.equal(resolver.isEligible(['OBJECT', 'UNKNOWNSUB']), false);
      });

      it('returns false for parent command without subcommand', () => {
        assert.equal(resolver.isEligible(['OBJECT']), false);
      });
    });

    describe('getEligibility with firstKeyIndex', () => {
      it('returns firstKeyIndex 1 for SET', () => {
        const result = resolver.getEligibility(['SET', 'key', 'value']);
        assert.equal(result.eligible, true);
        if (result.eligible) {
          assert.equal(result.firstKeyIndex, 1);
        }
      });

      it('returns firstKeyIndex null for keyless PING', () => {
        const result = resolver.getEligibility(['PING']);
        assert.equal(result.eligible, true);
        if (result.eligible) {
          assert.equal(result.firstKeyIndex, null);
        }
      });

      it('returns firstKeyIndex 2 for OBJECT ENCODING', () => {
        const result = resolver.getEligibility(['OBJECT', 'ENCODING', 'mykey']);
        assert.equal(result.eligible, true);
        if (result.eligible) {
          assert.equal(result.firstKeyIndex, 2);
        }
      });
    });
  });

  describe('DynamicEligibilityResolverFactory', () => {
    it('creates resolver from fetcher', async () => {
      const resolver = await DynamicEligibilityResolverFactory.create(
        createMockBinhdrFetcher()
      );

      assert.equal(resolver.isEligible(['SET', 'key', 'value']), true);
    });

    it('builds structure for subcommands', async () => {
      const records: CommandBinhdrRawReply[] = [
        {
          name: 'PARENT',
          binhdrFlag: false,
          subcommands: [
            { name: 'SUB1', binhdrFlag: true },
            { name: 'SUB2', binhdrFlag: false },
          ],
        },
      ];

      const resolver = await DynamicEligibilityResolverFactory.create(
        async () => records
      );

      assert.equal(resolver.isEligible(['PARENT', 'SUB1']), true);
      assert.equal(resolver.isEligible(['PARENT', 'SUB2']), false);
      assert.equal(resolver.isEligible(['PARENT', 'UNKNOWN']), false);
    });

    it('only stores eligible commands', async () => {
      const records: CommandBinhdrRawReply[] = [
        { name: 'ELIGIBLE', binhdrFlag: true },
        { name: 'NOTELIGIBLE', binhdrFlag: false },
      ];

      const resolver = await DynamicEligibilityResolverFactory.create(
        async () => records
      );

      assert.equal(resolver.isEligible(['ELIGIBLE']), true);
      assert.equal(resolver.isEligible(['NOTELIGIBLE']), false);
    });

    it('handles keyPosition in subcommands', async () => {
      const records: CommandBinhdrRawReply[] = [
        {
          name: 'CMD',
          binhdrFlag: false,
          subcommands: [
            { name: 'SUB', binhdrFlag: true, keyPosition: 3 },
          ],
        },
      ];

      const resolver = await DynamicEligibilityResolverFactory.create(
        async () => records
      );

      const result = resolver.getEligibility(['CMD', 'SUB', 'arg', 'mykey']);
      assert.equal(result.eligible, true);
      if (result.eligible) {
        assert.equal(result.firstKeyIndex, 3);
      }
    });

    it('handles keyless commands', async () => {
      const records: CommandBinhdrRawReply[] = [
        { name: 'NOKEYS', binhdrFlag: true, keyless: true },
      ];

      const resolver = await DynamicEligibilityResolverFactory.create(
        async () => records
      );

      const result = resolver.getEligibility(['NOKEYS']);
      assert.equal(result.eligible, true);
      if (result.eligible) {
        assert.equal(result.firstKeyIndex, null);
      }
    });
  });
});
