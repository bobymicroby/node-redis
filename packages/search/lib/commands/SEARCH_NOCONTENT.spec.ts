import { strict as assert } from 'assert';
import testUtils, { GLOBAL } from '../test-utils';
import SEARCH_NOCONTENT from './SEARCH_NOCONTENT';

describe('FT.SEARCH NOCONTENT', () => {
  describe('transformArguments', () => {
    it('without options', () => {
      assert.deepEqual(
        SEARCH_NOCONTENT.transformArguments('index', 'query'),
        ['FT.SEARCH', 'index', 'query', 'NOCONTENT']
      );
    });
  });

  describe('client.ft.searchNoContent', () => {
    testUtils.testWithClient('returns total and keys', async client => {
      await Promise.all([
        client.ft.create('index', {
          field: 'TEXT'
        }),
        client.hSet('1', 'field', 'field1'),
        client.hSet('2', 'field', 'field2')
      ]);

      assert.deepEqual(
        await client.ft.searchNoContent('index', '*'),
        {
          total: 2,
          documents: ['1', '2']
        }
      );
    }, GLOBAL.SERVERS.OPEN);
  });
});
