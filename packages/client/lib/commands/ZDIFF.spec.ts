import { strict as assert } from 'node:assert';
import testUtils, { GLOBAL } from '../test-utils';
import ZDIFF from './ZDIFF';

describe('ZDIFF', () => {
  testUtils.isVersionGreaterThanHook([6, 2]);

  describe('transformArguments', () => {
    it('string', () => {
      assert.deepEqual(
        ZDIFF.transformArguments('key'),
        ['ZDIFF', '1', 'key']
      );
    });

    it('array', () => {
      assert.deepEqual(
        ZDIFF.transformArguments(['1', '2']),
        ['ZDIFF', '2', '1', '2']
      );
    });
  });

  testUtils.testAll('zDiff', async client => {
    assert.deepEqual(
      await client.zDiff('key'),
      []
    );
  }, {
    client: GLOBAL.SERVERS.OPEN,
    cluster: GLOBAL.CLUSTERS.OPEN
  });
});
