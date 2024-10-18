import { strict as assert } from 'node:assert';
import testUtils, { GLOBAL } from '../../test-utils';
import RESERVE from './RESERVE';

describe('CF.RESERVE', () => {
  describe('transformArguments', () => {
    it('simple', () => {
      assert.deepEqual(
        RESERVE.transformArguments('key', 4),
        ['CF.RESERVE', 'key', '4']
      );
    });

    it('with EXPANSION', () => {
      assert.deepEqual(
        RESERVE.transformArguments('key', 4, {
          EXPANSION: 1
        }),
        ['CF.RESERVE', 'key', '4', 'EXPANSION', '1']
      );
    });

    it('with BUCKETSIZE', () => {
      assert.deepEqual(
        RESERVE.transformArguments('key', 4, {
          BUCKETSIZE: 2
        }),
        ['CF.RESERVE', 'key', '4', 'BUCKETSIZE', '2']
      );
    });

    it('with MAXITERATIONS', () => {
      assert.deepEqual(
        RESERVE.transformArguments('key', 4, {
          MAXITERATIONS: 1
        }),
        ['CF.RESERVE', 'key', '4', 'MAXITERATIONS', '1']
      );
    });
  });

  testUtils.testWithClient('client.cf.reserve', async client => {
    assert.equal(
      await client.cf.reserve('key', 4),
      'OK'
    );
  }, GLOBAL.SERVERS.OPEN);
});
