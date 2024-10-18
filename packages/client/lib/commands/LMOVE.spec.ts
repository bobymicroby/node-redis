import { strict as assert } from 'node:assert';
import testUtils, { GLOBAL } from '../test-utils';
import LMOVE from './LMOVE';

describe('LMOVE', () => {
  testUtils.isVersionGreaterThanHook([6, 2]);

  it('transformArguments', () => {
    assert.deepEqual(
      LMOVE.transformArguments('source', 'destination', 'LEFT', 'RIGHT'),
      ['LMOVE', 'source', 'destination', 'LEFT', 'RIGHT']
    );
  });

  testUtils.testAll('lMove', async client => {
    assert.equal(
      await client.lMove('{tag}source', '{tag}destination', 'LEFT', 'RIGHT'),
      null
    );
  }, {
    client: GLOBAL.SERVERS.OPEN,
    cluster: GLOBAL.CLUSTERS.OPEN
  });
});
