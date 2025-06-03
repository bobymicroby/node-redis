import { strict as assert } from 'node:assert';
import testUtils, { GLOBAL } from '../test-utils';
import { parseArgs, transformCommandReply, CommandFlags, CommandCategories } from './generic-transformers';
import COMMAND from './COMMAND';

describe('COMMAND', () => {
  it('transformArguments', () => {
    assert.deepEqual(
      parseArgs(COMMAND),
      ['COMMAND']
    );
  });

  describe('transformCommandReply', () => {
    const testCases = [
      {
        name: 'without policies',
        input: ['ping', -1, [CommandFlags.STALE], 0, 0, 0, [CommandCategories.FAST], [], []],
        expected: {
          name: 'ping',
          arity: -1,
          flags: new Set([CommandFlags.STALE]),
          firstKeyIndex: 0,
          lastKeyIndex: 0,
          step: 0,
          categories: new Set([CommandCategories.FAST]),
          policies: { request: undefined, response: undefined },
          keySpecification: []
        }
      },
      {
        name: 'with valid policies',
        input: ['dbsize', 1, [], 0, 0, 0, [], ['request_policy:all_shards', 'response_policy:agg_sum'], []],
        expected: {
          name: 'dbsize',
          arity: 1,
          flags: new Set([]),
          firstKeyIndex: 0,
          lastKeyIndex: 0,
          step: 0,
          categories: new Set([]),
          policies: { request: 'all_shards', response: 'agg_sum' },
          keySpecification: []
        }
      },
      {
        name: 'with invalid policies',
        input: ['test', 0, [], 0, 0, 0, [], ['request_policy:invalid', 'response_policy:invalid'], []],
        expected: {
          name: 'test',
          arity: 0,
          flags: new Set([]),
          firstKeyIndex: 0,
          lastKeyIndex: 0,
          step: 0,
          categories: new Set([]),
          policies: { request: undefined, response: undefined },
          keySpecification: []
        }
      },
      {
        name: 'with request policy only',
        input: ['test', 0, [], 0, 0, 0, [], ['request_policy:all_nodes'], []],
        expected: {
          name: 'test',
          arity: 0,
          flags: new Set([]),
          firstKeyIndex: 0,
          lastKeyIndex: 0,
          step: 0,
          categories: new Set([]),
          policies: { request: 'all_nodes', response: undefined },
          keySpecification: []
        }
      },
      {
        name: 'with response policy only',
        input: ['test', 0, [], 0, 0, 0, [], [undefined, 'response_policy:agg_max'], []],
        expected: {
          name: 'test',
          arity: 0,
          flags: new Set([]),
          firstKeyIndex: 0,
          lastKeyIndex: 0,
          step: 0,
          categories: new Set([]),
          policies: { request: undefined, response: 'agg_max' },
          keySpecification: []
        }
      },
      {
        name: 'with response policy only',
        input: ['test', 0, [], 0, 0, 0, [], ['', 'response_policy:agg_max'], []],
        expected: {
          name: 'test',
          arity: 0,
          flags: new Set([]),
          firstKeyIndex: 0,
          lastKeyIndex: 0,
          step: 0,
          categories: new Set([]),
          policies: { request: undefined, response: 'agg_max' },
          keySpecification: []
        }
      }
    ];

    testCases.forEach(testCase => {
      it(testCase.name, () => {
        assert.deepEqual(
          transformCommandReply(testCase.input as any),
          testCase.expected
        );
      });
    });
  });

  testUtils.testWithClient('client.command', async client => {
    const result = ((await client.command()).find(command => command.name === 'dbsize'));
    assert.equal(result?.name, 'dbsize');
    assert.equal(result?.arity, 1);
    assert.equal(result?.policies?.request, 'all_shards');
    assert.equal(result?.policies?.response, 'agg_sum');
     //this command have doesnt have keyspec
    assert.equal(result?.keySpecification.length, 0);
   
  }, GLOBAL.SERVERS.OPEN);

  testUtils.testWithClient('client.command', async client => {
    const result = ((await client.command()).find(command => command.name === 'ssubscribe'));

    //this command have key spec
    assert.equal(result?.keySpecification.length, 1);
  }, GLOBAL.SERVERS.OPEN);
});
