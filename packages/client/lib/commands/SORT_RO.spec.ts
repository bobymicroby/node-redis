import { strict as assert } from 'node:assert';
import testUtils, { GLOBAL } from '../test-utils';
import SORT_RO from './SORT_RO';

describe('SORT_RO', () => {
  testUtils.isVersionGreaterThanHook([7]);

  describe('transformArguments', () => {
    it('simple', () => {
      assert.deepEqual(
        SORT_RO.transformArguments('key'),
        ['SORT_RO', 'key']
      );
    });

    it('with BY', () => {
      assert.deepEqual(
        SORT_RO.transformArguments('key', {
          BY: 'pattern'
        }),
        ['SORT_RO', 'key', 'BY', 'pattern']
      );
    });

    it('with LIMIT', () => {
      assert.deepEqual(
        SORT_RO.transformArguments('key', {
          LIMIT: {
            offset: 0,
            count: 1
          }
        }),
        ['SORT_RO', 'key', 'LIMIT', '0', '1']
      );
    });

    describe('with GET', () => {
      it('string', () => {
        assert.deepEqual(
          SORT_RO.transformArguments('key', {
            GET: 'pattern'
          }),
          ['SORT_RO', 'key', 'GET', 'pattern']
        );
      });

      it('array', () => {
        assert.deepEqual(
          SORT_RO.transformArguments('key', {
            GET: ['1', '2']
          }),
          ['SORT_RO', 'key', 'GET', '1', 'GET', '2']
        );
      });
    });

    it('with DIRECTION', () => {
      assert.deepEqual(
        SORT_RO.transformArguments('key', {
          DIRECTION: 'ASC'
        }),
        ['SORT_RO', 'key', 'ASC']
      );
    });

    it('with ALPHA', () => {
      assert.deepEqual(
        SORT_RO.transformArguments('key', {
          ALPHA: true
        }),
        ['SORT_RO', 'key', 'ALPHA']
      );
    });

    it('with BY, LIMIT, GET, DIRECTION, ALPHA', () => {
      assert.deepEqual(
        SORT_RO.transformArguments('key', {
          BY: 'pattern',
          LIMIT: {
            offset: 0,
            count: 1
          },
          GET: 'pattern',
          DIRECTION: 'ASC',
          ALPHA: true,
        }),
        ['SORT_RO', 'key', 'BY', 'pattern', 'LIMIT', '0', '1', 'GET', 'pattern', 'ASC', 'ALPHA']
      );
    });
  });

  testUtils.testAll('sortRo', async client => {
    assert.deepEqual(
      await client.sortRo('key'),
      []
    );
  }, {
    client: GLOBAL.SERVERS.OPEN,
    cluster: GLOBAL.CLUSTERS.OPEN
  });
});
