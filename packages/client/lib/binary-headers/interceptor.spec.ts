import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { RequestHeaderDecoder } from './generated/request-header-codec';
import { parseRespCommands } from './test-utils';
import {
  createBaseQueue,
  createBinhdrQueue,
  createPassthroughQueue,
  collectYielded,
  type TestableQueue,
} from './queue-test-factories';

describe('Queue + Codec Integration [codec-queue]', function () {

  function collectYieldedParsed(queue: TestableQueue): unknown[][] {
    const results: unknown[][] = [];
    for (const encoded of queue.commandsToWrite()) {
      results.push(parseRespCommands((encoded as string[]).join('')) as unknown[][]);
    }
    return results;
  }

  describe('queue without codec (baseline)', function () {
    const queueCases = [
      { name: 'single command', commands: [['PING']], expected: [[['PING']]] },
      { name: 'multiple commands', commands: [['SET', 'a', '1'], ['GET', 'a']], expected: [[['SET', 'a', '1']], [['GET', 'a']]] },
      { name: 'empty queue', commands: [], expected: [] },
    ];

    for (const { name, commands, expected } of queueCases) {
      it(name, function () {
        const queue = createBaseQueue();
        commands.forEach((cmd) => queue.addCommand(cmd));
        assert.deepEqual(collectYieldedParsed(queue), expected);
      });
    }
  });

  describe('queue with binhdr codec (passthrough resolver)', function () {
    const passthroughCases = [
      { name: 'single command', commands: [['PING']], expected: [[['PING']]] },
      { name: 'multiple commands', commands: [['SET', 'a', '1'], ['GET', 'a']], expected: [[['SET', 'a', '1']], [['GET', 'a']]] },
    ];

    for (const { name, commands, expected } of passthroughCases) {
      it(name, function () {
        const queue = createPassthroughQueue();
        commands.forEach((cmd) => queue.addCommand(cmd));
        assert.deepEqual(collectYieldedParsed(queue), expected);
      });
    }
  });

  describe('queue with binhdr codec (static resolver)', function () {
    const binhdrCases = [
      { name: 'single command', commands: [['PING']], expectedYields: 1, expectedCommandCount: 1 },
      { name: 'multiple commands batched', commands: [['PING'], ['PING'], ['PING']], expectedYields: 1, expectedCommandCount: 3 },
    ];

    for (const { name, commands, expectedYields, expectedCommandCount } of binhdrCases) {
      it(name, function () {
        const queue = createBinhdrQueue();
        commands.forEach((cmd) => queue.addCommand(cmd));

        const results = collectYielded(queue);

        assert.equal(results.length, expectedYields);
        const decoder = new RequestHeaderDecoder().wrap(results[0][0] as Buffer, 0);
        assert.ok(decoder.isValid());
        assert.equal(decoder.commandCount(), expectedCommandCount);
      });
    }
  });
});
