import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'mocha';
import { BINHDR } from './constants';
import {
  StaticEligibilityResolver,
  DynamicEligibilityResolverFactory,
  checkRuntimeEligibility,
  createMockBinhdrFetcher,
  createDefaultResolver,
  STATIC_BINHDR_RECORDS,
  type CommandBinhdrRecords,
  type CommandBinhdrRawReply,
  type EligibilityResolver,
} from './eligibility';

describe('Eligibility', () => {
  describe('StaticEligibilityResolver', () => {
    let resolver: StaticEligibilityResolver;

    beforeEach(async () => {
      resolver = await createDefaultResolver();
    });

    describe('simple commands', () => {
      it('resolves SET command', () => {
        const result = resolver.resolveEligibility(['SET', 'key', 'value']);
        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.value.name, 'SET');
          assert.equal(result.value.binhdrFlag, true);
          assert.equal(result.value.hasKeys, true);
          assert.deepEqual(result.value.blocking, { type: 'never' });
        }
      });

      it('resolves GET command', () => {
        const result = resolver.resolveEligibility(['GET', 'key']);
        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.value.name, 'GET');
          assert.equal(result.value.binhdrFlag, true);
        }
      });

      it('resolves command case-insensitively', () => {
        const result1 = resolver.resolveEligibility(['set', 'key', 'value']);
        const result2 = resolver.resolveEligibility(['SET', 'key', 'value']);
        const result3 = resolver.resolveEligibility(['Set', 'key', 'value']);

        assert.equal(result1.ok, true);
        assert.equal(result2.ok, true);
        assert.equal(result3.ok, true);
      });

      it('resolves Buffer command names', () => {
        const result = resolver.resolveEligibility([Buffer.from('SET'), 'key', 'value']);
        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.value.name, 'SET');
        }
      });

      it('returns error for unknown command', () => {
        const result = resolver.resolveEligibility(['UNKNOWNCOMMAND', 'arg']);
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.error, 'unknown-command');
        }
      });

      it('returns error for empty args', () => {
        const result = resolver.resolveEligibility([]);
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.error, 'unknown-command');
        }
      });
    });

    describe('blocking commands', () => {
      it('resolves always-blocking command (BLPOP)', () => {
        const result = resolver.resolveEligibility(['BLPOP', 'key', '0']);
        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.value.name, 'BLPOP');
          assert.equal(result.value.binhdrFlag, false);
          assert.deepEqual(result.value.blocking, { type: 'always' });
        }
      });

      it('resolves conditionally-blocking command (XREAD)', () => {
        const result = resolver.resolveEligibility(['XREAD', 'STREAMS', 'stream', '0']);
        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.value.name, 'XREAD');
          assert.equal(result.value.binhdrFlag, true);
          assert.deepEqual(result.value.blocking, { type: 'conditional', triggerArg: 'BLOCK' });
        }
      });
    });

    describe('commands with subcommands', () => {
      it('resolves CLUSTER SLOTS', () => {
        const result = resolver.resolveEligibility(['CLUSTER', 'SLOTS']);
        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.value.name, 'SLOTS');
          assert.equal(result.value.binhdrFlag, true);
        }
      });

      it('resolves CLIENT SETINFO', () => {
        const result = resolver.resolveEligibility(['CLIENT', 'SETINFO', 'LIB-NAME', 'node-redis']);
        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.value.name, 'SETINFO');
          assert.equal(result.value.binhdrFlag, true);
        }
      });

      it('resolves subcommand case-insensitively', () => {
        const result1 = resolver.resolveEligibility(['cluster', 'slots']);
        const result2 = resolver.resolveEligibility(['CLUSTER', 'SLOTS']);
        const result3 = resolver.resolveEligibility(['Cluster', 'Slots']);

        assert.equal(result1.ok, true);
        assert.equal(result2.ok, true);
        assert.equal(result3.ok, true);
      });

      it('returns parent command self if subcommand not found', () => {
        const result = resolver.resolveEligibility(['CLIENT', 'UNKNOWNSUB']);
        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.value.name, 'CLIENT');
        }
      });

      it('resolves CONFIG GET', () => {
        const result = resolver.resolveEligibility(['CONFIG', 'GET', 'maxmemory']);
        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.value.name, 'GET');
          assert.equal(result.value.binhdrFlag, true);
        }
      });

      it('resolves XGROUP CREATE', () => {
        const result = resolver.resolveEligibility(['XGROUP', 'CREATE', 'stream', 'group', '$']);
        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.value.name, 'CREATE');
          assert.equal(result.value.binhdrFlag, true);
          assert.equal(result.value.hasKeys, true);
        }
      });
    });

    describe('BINDHR meta-command', () => {
      it('resolves BINDHR as not eligible', () => {
        const result = resolver.resolveEligibility(['BINDHR', 'ENABLE']);
        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.value.name, 'BINDHR');
          assert.equal(result.value.binhdrFlag, false);
        }
      });
    });

    describe('withFallback', () => {
      it('falls back to another resolver on unknown command', async () => {
        const customRecords: CommandBinhdrRawReply[] = [
          { name: 'CUSTOMCMD', binhdrFlag: true, hasKeys: true, blockingType: 'never' },
        ];

        const customResolver = await DynamicEligibilityResolverFactory.create(
          async () => customRecords
        );

        const chainedResolver = resolver.withFallback(customResolver);

        // Known command from primary resolver
        const result1 = chainedResolver.resolveEligibility(['SET', 'key', 'value']);
        assert.equal(result1.ok, true);

        // Unknown in primary, falls back to custom
        const result2 = chainedResolver.resolveEligibility(['CUSTOMCMD', 'arg']);
        assert.equal(result2.ok, true);
        if (result2.ok) {
          assert.equal(result2.value.name, 'CUSTOMCMD');
        }
      });
    });
  });

  describe('DynamicEligibilityResolverFactory', () => {
    it('creates resolver from fetcher', async () => {
      const resolver = await DynamicEligibilityResolverFactory.create(
        createMockBinhdrFetcher()
      );

      const result = resolver.resolveEligibility(['SET', 'key', 'value']);
      assert.equal(result.ok, true);
    });

    it('creates resolver with fallback', async () => {
      const fallbackRecords: CommandBinhdrRawReply[] = [
        { name: 'FALLBACKCMD', binhdrFlag: true, hasKeys: false, blockingType: 'never' },
      ];

      const fallback = await DynamicEligibilityResolverFactory.create(
        async () => fallbackRecords
      );

      const primary = await DynamicEligibilityResolverFactory.create(
        async () => [],
        fallback
      );

      const result = primary.resolveEligibility(['FALLBACKCMD']);
      assert.equal(result.ok, true);
    });

    it('builds nested structure for subcommands', async () => {
      const records: CommandBinhdrRawReply[] = [
        {
          name: 'PARENT',
          binhdrFlag: false,
          hasKeys: false,
          blockingType: 'never',
          subcommands: [
            { name: 'SUB1', binhdrFlag: true, hasKeys: false, blockingType: 'never' },
            { name: 'SUB2', binhdrFlag: true, hasKeys: true, blockingType: 'always' },
          ],
        },
      ];

      const resolver = await DynamicEligibilityResolverFactory.create(
        async () => records
      );

      const result1 = resolver.resolveEligibility(['PARENT', 'SUB1']);
      assert.equal(result1.ok, true);
      if (result1.ok) {
        assert.equal(result1.value.name, 'SUB1');
        assert.equal(result1.value.binhdrFlag, true);
      }

      const result2 = resolver.resolveEligibility(['PARENT', 'SUB2']);
      assert.equal(result2.ok, true);
      if (result2.ok) {
        assert.equal(result2.value.name, 'SUB2');
        assert.deepEqual(result2.value.blocking, { type: 'always' });
      }
    });
  });

  describe('checkRuntimeEligibility', () => {
    let resolver: EligibilityResolver;

    beforeEach(async () => {
      resolver = await createDefaultResolver();
    });

    describe('eligible commands', () => {
      it('returns eligible for simple command with single key', () => {
        const result = checkRuntimeEligibility(
          resolver,
          ['SET', 'mykey', 'value'],
          ['mykey']
        );

        assert.equal(result.eligible, true);
        assert.equal(result.slot !== BINHDR.SLOT_NO_SLOT, true);
        assert.equal(result.reason, undefined);
      });

      it('returns eligible for command with no keys', () => {
        const result = checkRuntimeEligibility(
          resolver,
          ['TIME'],
          []
        );

        assert.equal(result.eligible, true);
        assert.equal(result.slot, BINHDR.SLOT_NO_SLOT);
      });

      it('returns eligible for command with same-slot keys', () => {
        const result = checkRuntimeEligibility(
          resolver,
          ['MSET', '{x}a', '1', '{x}b', '2'],
          ['{x}a', '{x}b']
        );

        assert.equal(result.eligible, true);
        assert.equal(result.reason, undefined);
      });

      it('returns eligible for XREAD without BLOCK', () => {
        const result = checkRuntimeEligibility(
          resolver,
          ['XREAD', 'STREAMS', 'stream', '0'],
          ['stream']
        );

        assert.equal(result.eligible, true);
      });

      it('returns eligible for subcommand', () => {
        const result = checkRuntimeEligibility(
          resolver,
          ['CLUSTER', 'SLOTS'],
          []
        );

        assert.equal(result.eligible, true);
        assert.equal(result.slot, BINHDR.SLOT_NO_SLOT);
      });
    });

    describe('ineligible commands', () => {
      it('returns ineligible for unknown command', () => {
        const result = checkRuntimeEligibility(
          resolver,
          ['UNKNOWNCOMMAND', 'arg'],
          []
        );

        assert.equal(result.eligible, false);
        assert.equal(result.reason, 'unknown_command');
        assert.equal(result.slot, BINHDR.SLOT_NO_SLOT);
      });

      it('returns ineligible for command without binhdr flag', () => {
        const result = checkRuntimeEligibility(
          resolver,
          ['DBSIZE'],
          []
        );

        assert.equal(result.eligible, false);
        assert.equal(result.reason, 'no_binhdr_flag');
      });

      it('returns ineligible for BINDHR command', () => {
        const result = checkRuntimeEligibility(
          resolver,
          ['BINDHR', 'ENABLE'],
          []
        );

        assert.equal(result.eligible, false);
        assert.equal(result.reason, 'binhdr_command');
      });

      it('returns ineligible for always-blocking command', () => {
        const result = checkRuntimeEligibility(
          resolver,
          ['BLPOP', 'key', '0'],
          ['key']
        );

        assert.equal(result.eligible, false);
        // BLPOP has binhdrFlag: false, so it fails on flag check first
        assert.equal(result.reason, 'no_binhdr_flag');
      });

      it('returns ineligible for XREAD with BLOCK', () => {
        const result = checkRuntimeEligibility(
          resolver,
          ['XREAD', 'BLOCK', '1000', 'STREAMS', 'stream', '0'],
          ['stream']
        );

        assert.equal(result.eligible, false);
        assert.equal(result.reason, 'blocking');
      });

      it('returns ineligible for XREAD with lowercase block', () => {
        const result = checkRuntimeEligibility(
          resolver,
          ['XREAD', 'block', '1000', 'STREAMS', 'stream', '0'],
          ['stream']
        );

        assert.equal(result.eligible, false);
        assert.equal(result.reason, 'blocking');
      });

      it('returns ineligible for cross-slot keys', () => {
        const result = checkRuntimeEligibility(
          resolver,
          ['MSET', 'key1', '1', 'key2', '2'],
          ['key1', 'key2'] // Different slots
        );

        assert.equal(result.eligible, false);
        assert.equal(result.reason, 'cross_slot');
      });

      it('returns ineligible for blocking subcommand', () => {
        const result = checkRuntimeEligibility(
          resolver,
          ['CLIENT', 'PAUSE', '1000'],
          []
        );

        assert.equal(result.eligible, false);
        // CLIENT PAUSE has binhdrFlag: false, so it fails on flag check first
        assert.equal(result.reason, 'no_binhdr_flag');
      });

      it('returns ineligible for command with binhdrFlag but always blocking', async () => {
        // Create a custom resolver with a command that has binhdrFlag: true but is always blocking
        const customResolver = await DynamicEligibilityResolverFactory.create(
          async () => [
            { name: 'TESTBLOCKING', binhdrFlag: true, hasKeys: true, blockingType: 'always' as const },
          ]
        );

        const result = checkRuntimeEligibility(
          customResolver,
          ['TESTBLOCKING', 'key'],
          ['key']
        );

        assert.equal(result.eligible, false);
        assert.equal(result.reason, 'blocking');
      });
    });

    describe('slot calculation', () => {
      it('calculates slot for single key', () => {
        const result = checkRuntimeEligibility(
          resolver,
          ['GET', 'mykey'],
          ['mykey']
        );

        assert.equal(result.eligible, true);
        assert.equal(typeof result.slot, 'number');
        assert.equal(result.slot >= 0 && result.slot <= BINHDR.SLOT_MAX_VALID, true);
      });

      it('returns SLOT_NO_SLOT for no keys', () => {
        const result = checkRuntimeEligibility(
          resolver,
          ['PING'],
          []
        );

        assert.equal(result.eligible, true);
        assert.equal(result.slot, BINHDR.SLOT_NO_SLOT);
      });

      it('calculates same slot for hash-tagged keys', () => {
        const result = checkRuntimeEligibility(
          resolver,
          ['MGET', '{user:1}:name', '{user:1}:email'],
          ['{user:1}:name', '{user:1}:email']
        );

        assert.equal(result.eligible, true);
        assert.equal(result.slot >= 0 && result.slot <= BINHDR.SLOT_MAX_VALID, true);
      });
    });
  });

  describe('STATIC_BINHDR_RECORDS', () => {
    it('contains expected commands', () => {
      const names = STATIC_BINHDR_RECORDS.map(r => r.name);

      assert.equal(names.includes('SET'), true);
      assert.equal(names.includes('GET'), true);
      assert.equal(names.includes('BLPOP'), true);
      assert.equal(names.includes('XREAD'), true);
      assert.equal(names.includes('CLUSTER'), true);
      assert.equal(names.includes('BINDHR'), true);
    });

    it('has subcommands for CLUSTER', () => {
      const cluster = STATIC_BINHDR_RECORDS.find(r => r.name === 'CLUSTER');
      assert.notEqual(cluster, undefined);
      assert.equal(Array.isArray(cluster!.subcommands), true);
      assert.equal(cluster!.subcommands!.length > 0, true);
    });

    it('has conditional blocking for XREAD', () => {
      const xread = STATIC_BINHDR_RECORDS.find(r => r.name === 'XREAD');
      assert.notEqual(xread, undefined);
      assert.equal(xread!.blockingType, 'conditional');
      assert.equal(xread!.conditionalBlockingArg, 'BLOCK');
    });
  });
});
