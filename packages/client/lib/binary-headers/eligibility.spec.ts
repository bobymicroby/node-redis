import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'mocha';
import {
  EligibilityResolver,
  DynamicEligibilityResolverFactory,
  createMockBinhdrFetcher,
  createDefaultResolver,
  STATIC_BINHDR_RECORDS,
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

    describe('ineligible commands', () => {
      it('returns false for BLPOP (blocking)', () => {
        assert.equal(resolver.isEligible(['BLPOP', 'key', '0']), false);
      });

      it('returns false for DBSIZE', () => {
        assert.equal(resolver.isEligible(['DBSIZE']), false);
      });

      it('returns false for BINDHR', () => {
        assert.equal(resolver.isEligible(['BINDHR', 'ENABLE']), false);
      });
    });

    describe('commands with subcommands', () => {
      it('returns true for eligible CLUSTER SLOTS', () => {
        assert.equal(resolver.isEligible(['CLUSTER', 'SLOTS']), true);
      });

      it('returns true for eligible CLIENT SETINFO', () => {
        assert.equal(resolver.isEligible(['CLIENT', 'SETINFO', 'LIB-NAME', 'node-redis']), true);
      });

      it('returns false for ineligible CLIENT PAUSE', () => {
        assert.equal(resolver.isEligible(['CLIENT', 'PAUSE', '1000']), false);
      });

      it('returns false when subcommand not found (falls back to parent)', () => {
        // CLIENT itself is not eligible, so unknown subcommand returns false
        assert.equal(resolver.isEligible(['CLIENT', 'UNKNOWNSUB']), false);
      });

      it('returns true for eligible CONFIG GET', () => {
        assert.equal(resolver.isEligible(['CONFIG', 'GET', 'maxmemory']), true);
      });

      it('returns true for eligible XGROUP CREATE', () => {
        assert.equal(resolver.isEligible(['XGROUP', 'CREATE', 'stream', 'group', '$']), true);
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
  });

 });
