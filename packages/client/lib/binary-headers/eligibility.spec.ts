import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'mocha';
import {
  EligibilityResolver,
  createEligibilityResolver,
  createMockRecordFetcher,
  STATIC_RESOLVER,
  type CommandRecord,
} from './eligibility';

describe('Eligibility', () => {
  describe('EligibilityResolver', () => {
    let resolver: EligibilityResolver;

    beforeEach(() => {
      resolver = STATIC_RESOLVER;
    });

    const eligibleCommands = [
      { args: ['SET', 'key', 'value'], name: 'SET' },
      { args: ['GET', 'key'], name: 'GET' },
      { args: ['HSET', 'key', 'field', 'value'], name: 'HSET' },
      { args: [Buffer.from('SET'), 'key', 'value'], name: 'SET (Buffer)' },
      { args: ['TIME'], name: 'TIME (keyless)' },
      { args: ['PING'], name: 'PING (keyless)' },
      { args: ['OBJECT', 'ENCODING', 'mykey'], name: 'OBJECT ENCODING (subcommand)' },
      { args: ['OBJECT'], name: 'OBJECT (parent only)' },
      { args: ['OBJECT', 'UNKNOWNSUB'], name: 'OBJECT UNKNOWNSUB (uses parent attrs)' },
      { args: ['XREAD', 'STREAMS', 'mystream', '0'], name: 'XREAD without BLOCK' },
      { args: ['XREADGROUP', 'GROUP', 'mygroup', 'myconsumer', 'STREAMS', 'mystream', '>'], name: 'XREADGROUP without BLOCK' },
    ];

    const ineligibleCommands = [
      { args: ['UNKNOWNCOMMAND', 'arg'], name: 'unknown command' },
      { args: [], name: 'empty args' },
      { args: ['XREAD', 'BLOCK', '0', 'STREAMS', 'mystream', '0'], name: 'XREAD with BLOCK' },
      { args: ['XREAD', 'block', '0', 'STREAMS', 'mystream', '0'], name: 'XREAD with lowercase block' },
      { args: ['XREADGROUP', 'GROUP', 'mygroup', 'myconsumer', 'BLOCK', '0', 'STREAMS', 'mystream', '>'], name: 'XREADGROUP with BLOCK' },
    ];

    for (const { args, name } of eligibleCommands) {
      it(`eligible: ${name}`, () => {
        assert.equal(resolver.getEligibility(args).eligible, true);
      });
    }

    for (const { args, name } of ineligibleCommands) {
      it(`ineligible: ${name}`, () => {
        assert.equal(resolver.getEligibility(args).eligible, false);
      });
    }

    describe('slot calculation', () => {
      it('returns valid slot for keyed command', () => {
        const result = resolver.getEligibility(['SET', 'key', 'value']);
        assert.equal(result.eligible, true);
        if (result.eligible) {
          assert.ok(result.slot >= 0 && result.slot <= 16383);
        }
      });

      it('returns SLOT_NO_SLOT (0xFFFF) for keyless command', () => {
        const result = resolver.getEligibility(['PING']);
        assert.equal(result.eligible, true);
        if (result.eligible) {
          assert.equal(result.slot, 0xFFFF);
        }
      });

      it('uses subcommand keyPosition when defined', () => {
        const result = resolver.getEligibility(['OBJECT', 'ENCODING', 'mykey']);
        assert.equal(result.eligible, true);
        if (result.eligible) {
          assert.ok(result.slot >= 0 && result.slot <= 16383);
        }
      });
    });
  });

  describe('createEligibilityResolver', () => {
    it('creates resolver from fetcher', async () => {
      const resolver = await createEligibilityResolver(createMockRecordFetcher());
      assert.equal(resolver.getEligibility(['SET', 'key', 'value']).eligible, true);
    });

    const customRecordTests = [
      {
        name: 'subcommand blocking',
        records: [{
          name: 'PARENT',
          subcommands: [
            { name: 'SUB1' },
            { name: 'SUB2', blocking: { type: 'always' as const } },
          ],
        }],
        cases: [
          { args: ['PARENT', 'SUB1'], eligible: true },
          { args: ['PARENT', 'SUB2'], eligible: false },
        ],
      },
      {
        name: 'keyPosition in subcommand',
        records: [{
          name: 'CMD',
          subcommands: [{ name: 'SUB', keyPosition: { index: 3 } }],
        }],
        cases: [
          { args: ['CMD', 'SUB', 'arg', 'mykey'], eligible: true, hasSlot: true },
        ],
      },
      {
        name: 'keyless command',
        records: [{ name: 'NOKEYS', keyPosition: { keyless: true } }],
        cases: [
          { args: ['NOKEYS'], eligible: true, slot: 0xFFFF },
        ],
      },
      {
        name: 'always blocking',
        records: [{ name: 'BLPOP', blocking: { type: 'always' as const } }],
        cases: [
          { args: ['BLPOP', 'key', '0'], eligible: false },
        ],
      },
      {
        name: 'conditional blocking',
        records: [{ name: 'XREAD', blocking: { type: 'conditional' as const, argName: 'BLOCK' } }],
        cases: [
          { args: ['XREAD', 'STREAMS', 'stream', '0'], eligible: true },
          { args: ['XREAD', 'BLOCK', '0', 'STREAMS', 'stream', '0'], eligible: false },
        ],
      },
    ];

    for (const { name, records, cases } of customRecordTests) {
      it(name, async () => {
        const resolver = await createEligibilityResolver(async () => records as CommandRecord[]);

        for (const testCase of cases) {
          const { args, eligible } = testCase;
          const slot = 'slot' in testCase ? testCase.slot : undefined;
          const hasSlot = 'hasSlot' in testCase ? testCase.hasSlot : undefined;

          const result = resolver.getEligibility(args);
          assert.equal(result.eligible, eligible, `${args.join(' ')} should be ${eligible ? 'eligible' : 'ineligible'}`);

          if (result.eligible) {
            if (slot !== undefined) {
              assert.equal(result.slot, slot);
            }
            if (hasSlot) {
              assert.equal(typeof result.slot, 'number');
            }
          }
        }
      });
    }
  });
});
