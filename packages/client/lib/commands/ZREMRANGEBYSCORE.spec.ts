import { strict as assert } from 'node:assert';
import testUtils, { GLOBAL } from '../test-utils';
import ZREMRANGEBYSCORE from './ZREMRANGEBYSCORE';

describe('ZREMRANGEBYSCORE', () => {
  it('transformArguments', () => {
    assert.deepEqual(
      ZREMRANGEBYSCORE.transformArguments('key', 0, 1),
      ['ZREMRANGEBYSCORE', 'key', '0', '1']
    );
  });

  testUtils.testAll('zRemRangeByScore', async client => {
    assert.equal(
      await client.zRemRangeByScore('key', 0, 1),
      0
    );
  }, {
    client: GLOBAL.SERVERS.OPEN,
    cluster: GLOBAL.CLUSTERS.OPEN
  });
});
