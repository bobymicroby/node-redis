import { strict as assert } from 'node:assert';
import testUtils, { GLOBAL } from '../test-utils';
import FUNCTION_DUMP from './FUNCTION_DUMP';

describe('FUNCTION DUMP', () => {
  testUtils.isVersionGreaterThanHook([7]);

  it('transformArguments', () => {
    assert.deepEqual(
      FUNCTION_DUMP.transformArguments(),
      ['FUNCTION', 'DUMP']
    );
  });

  testUtils.testWithClient('client.functionDump', async client => {
    assert.equal(
      typeof await client.functionDump(),
      'string'
    );
  }, GLOBAL.SERVERS.OPEN);
});
