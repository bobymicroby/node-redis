import { strict as assert } from 'node:assert';
import net from 'node:net';
import testUtils, { GLOBAL } from '../test-utils';
import encodeCommand from '../RESP/encoder';
import { RequestHeaderEncoder } from './generated/request-header-codec';
import { ResponseHeaderDecoder } from './generated/response-header-codec';
import { STATIC_COMMAND_RECORDS, type CommandRecord } from './eligibility';

function createDmcBinaryHeadersProxyOptions(supportedCommands: ReadonlyArray<CommandRecord> = STATIC_COMMAND_RECORDS) {
  return {
    ...GLOBAL.SERVERS.OPEN,
    clientOptions: {
      disableClientInfo: true,
    },
    dmcBinaryHeadersProxy: {
      supportedCommands,
    },
  } as const;
}

function chunkToBuffer(chunk: ReadonlyArray<string | Buffer>): Buffer {
  return Buffer.concat(chunk.map((part) => typeof part === 'string' ? Buffer.from(part) : part));
}

async function sendFrame(port: number, frame: Buffer): Promise<{ response: Buffer; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];

    socket.once('connect', () => socket.write(frame));
    socket.once('error', reject);
    socket.on('data', (data) => {
      chunks.push(data);
      const response = Buffer.concat(chunks);
      if (response.length < ResponseHeaderDecoder.ENCODED_LENGTH) {
        return;
      }

      const decoder = new ResponseHeaderDecoder().wrap(response, 0);
      const frameLength = ResponseHeaderDecoder.ENCODED_LENGTH + decoder.length();
      if (response.length >= frameLength) {
        resolve({ response: response.subarray(0, frameLength), socket });
      }
    });
  });
}

describe('Binary Headers DMC Proxy E2E', function () {
  this.timeout(30000);

  testUtils.testWithClient('eligible SET/GET go through the proxy as binary-header requests', async (client, context) => {
    assert.ok(context.dmcBinaryHeadersProxy, 'test requires DMC binary-headers proxy');
    const proxy = context.dmcBinaryHeadersProxy;
    proxy.clearDmcBinaryHeadersProxyStats();

    assert.equal(await client.set('dmc-proxy:key', 'value'), 'OK');
    assert.equal(await client.get('dmc-proxy:key'), 'value');

    const requests = proxy.getDmcBinaryHeadersProxyStats().requests;
    const setRequest = requests.find((request) => request.commandNames[0] === 'SET');
    const getRequest = requests.find((request) => request.commandNames[0] === 'GET');

    assert.ok(setRequest, 'SET request should be observed');
    assert.ok(getRequest, 'GET request should be observed');
    assert.equal(setRequest.type, 'binary');
    assert.equal(getRequest.type, 'binary');
    assert.equal(setRequest.commandCount, 1);
    assert.equal(getRequest.commandCount, 1);
    assert.equal(typeof setRequest.clientIdx, 'number');
    assert.equal(typeof getRequest.clientIdx, 'number');
    assert.equal(setRequest.slot, getRequest.slot, 'same key should use same slot');
  }, createDmcBinaryHeadersProxyOptions());

  testUtils.testWithClient('timer-backed auto-pipelining packs same-slot commands through the proxy', async (client, context) => {
    assert.ok(context.dmcBinaryHeadersProxy, 'test requires DMC binary-headers proxy');
    const proxy = context.dmcBinaryHeadersProxy;
    proxy.clearDmcBinaryHeadersProxyStats();

    const replies = await Promise.all([
      client.set('{dmc-proxy-timer}a', '1'),
      client.set('{dmc-proxy-timer}b', '2'),
      client.get('{dmc-proxy-timer}a'),
    ]);

    assert.deepEqual(replies, ['OK', 'OK', '1']);

    const packedRequest = proxy.getDmcBinaryHeadersProxyStats().requests.find(
      (request) => request.type === 'binary' && request.commandCount > 1,
    );
    assert.ok(packedRequest, 'same-slot commands should be packed by the binary-header timer');
    assert.equal(packedRequest.clientIdx, 0);
  }, createDmcBinaryHeadersProxyOptions());

  testUtils.testWithClient('commands outside binary-header eligibility remain raw RESP through the proxy', async (client, context) => {
    assert.ok(context.dmcBinaryHeadersProxy, 'test requires DMC binary-headers proxy');
    const proxy = context.dmcBinaryHeadersProxy;
    proxy.clearDmcBinaryHeadersProxyStats();

    const count = await client.sendCommand(['COMMAND', 'COUNT'] as const);
    assert.equal(typeof count, 'number');

    const commandRequest = proxy.getDmcBinaryHeadersProxyStats().requests.find(
      (request) => request.commandNames[0] === 'COMMAND',
    );
    assert.ok(commandRequest, 'COMMAND COUNT should be observed');
    assert.equal(commandRequest.type, 'raw');
  }, createDmcBinaryHeadersProxyOptions());

  testUtils.testWithClient('mixed raw and binary-header requests preserve reply order', async (client, context) => {
    assert.ok(context.dmcBinaryHeadersProxy, 'test requires DMC binary-headers proxy');
    const proxy = context.dmcBinaryHeadersProxy;
    proxy.clearDmcBinaryHeadersProxyStats();

    const [commandCount, setReply] = await Promise.all([
      client.sendCommand(['COMMAND', 'COUNT'] as const),
      client.set('dmc-proxy:mixed', 'value'),
    ]);

    assert.equal(typeof commandCount, 'number');
    assert.equal(setReply, 'OK');

    const requests = proxy.getDmcBinaryHeadersProxyStats().requests.filter((request) =>
      request.commandNames[0] === 'COMMAND' || request.commandNames[0] === 'SET'
    );
    assert.deepEqual(
      requests.map((request) => request.type),
      ['raw', 'binary'],
    );
  }, createDmcBinaryHeadersProxyOptions());

  testUtils.testWithClient('proxy rejects BINDHR inside binary-header traffic', async (_client, context) => {
    assert.ok(context.dmcBinaryHeadersProxy, 'test requires DMC binary-headers proxy');
    assert.ok(context.proxyPort, 'test requires proxy port');
    const proxy = context.dmcBinaryHeadersProxy;
    proxy.clearDmcBinaryHeadersProxyStats();

    const payload = chunkToBuffer(encodeCommand(['BINDHR', 'STATUS']));
    const frame = Buffer.concat([
      RequestHeaderEncoder.allocateAndEncode(
        payload.length,
        1,
        RequestHeaderEncoder.slotNullValue(),
        7,
      ),
      payload,
    ]);

    const { response, socket } = await sendFrame(context.proxyPort, frame);
    try {
      const decoder = new ResponseHeaderDecoder().wrap(response, 0);
      assert.equal(decoder.protocolError(), true);
      assert.equal(decoder.clientIdx(), 7);
      assert.match(
        response.subarray(ResponseHeaderDecoder.ENCODED_LENGTH).toString(),
        /BINDHR must be sent as raw RESP/,
      );

      const bindhrRequest = proxy.getDmcBinaryHeadersProxyStats().requests.find(
        (request) => request.commandNames[0] === 'BINDHR',
      );
      assert.ok(bindhrRequest, 'BINDHR should be observed');
      assert.equal(bindhrRequest.type, 'binary');
      assert.equal(bindhrRequest.rejected, true);
    } finally {
      socket.destroy();
    }
  }, createDmcBinaryHeadersProxyOptions());

  testUtils.testWithClient('MONITOR RESET can return to normal binary-header commands', async (client) => {
    await Promise.all([
      client.monitor(() => {}),
      client.reset(),
    ]);

    assert.equal(await client.set('dmc-proxy:monitor-reset', 'ok'), 'OK');
    assert.equal(await client.get('dmc-proxy:monitor-reset'), 'ok');
  }, createDmcBinaryHeadersProxyOptions());

  testUtils.testWithClient('proxy rejects binary-header traffic for commands excluded by proxy eligibility', async (client, context) => {
    assert.ok(context.dmcBinaryHeadersProxy, 'test requires DMC binary-headers proxy');
    const proxy = context.dmcBinaryHeadersProxy;
    client.on('error', () => {});
    proxy.clearDmcBinaryHeadersProxyStats();

    await assert.rejects(
      client.sendCommand(['DBSIZE'] as const),
      /DMC binary header proxy rejected request: DBSIZE is not binary-header eligible/,
    );

    const dbsizeRequest = proxy.getDmcBinaryHeadersProxyStats().requests.find(
      (request) => request.commandNames[0] === 'DBSIZE',
    );
    assert.ok(dbsizeRequest, 'DBSIZE should be observed');
    assert.equal(dbsizeRequest.type, 'binary');
    assert.equal(dbsizeRequest.rejected, true);
    assert.match(dbsizeRequest.error ?? '', /DBSIZE is not binary-header eligible/);
  }, createDmcBinaryHeadersProxyOptions([
    { name: 'SET' },
    { name: 'GET' },
  ]));

  testUtils.testWithClient('proxy rejects binary-header traffic for blocking XREAD BLOCK', async (_client, context) => {
    assert.ok(context.dmcBinaryHeadersProxy, 'test requires DMC binary-headers proxy');
    assert.ok(context.proxyPort, 'test requires proxy port');
    const proxy = context.dmcBinaryHeadersProxy;
    proxy.clearDmcBinaryHeadersProxyStats();

    const payload = chunkToBuffer(encodeCommand(['XREAD', 'BLOCK', '1', 'STREAMS', 'stream', '0']));
    const frame = Buffer.concat([
      RequestHeaderEncoder.allocateAndEncode(
        payload.length,
        1,
        RequestHeaderEncoder.slotNullValue(),
        42,
      ),
      payload,
    ]);

    const { response, socket } = await sendFrame(context.proxyPort, frame);
    try {
      const decoder = new ResponseHeaderDecoder().wrap(response, 0);
      assert.equal(decoder.protocolError(), true);
      assert.equal(decoder.clientIdx(), 42);
      assert.match(
        response.subarray(ResponseHeaderDecoder.ENCODED_LENGTH).toString(),
        /XREAD is not binary-header eligible/,
      );

      const xreadRequest = proxy.getDmcBinaryHeadersProxyStats().requests.find(
        (request) => request.commandNames[0] === 'XREAD',
      );
      assert.ok(xreadRequest, 'XREAD should be observed');
      assert.equal(xreadRequest.type, 'binary');
      assert.equal(xreadRequest.rejected, true);
    } finally {
      socket.destroy();
    }
  }, createDmcBinaryHeadersProxyOptions([
    { name: 'XREAD', blocking: { type: 'conditional', argName: 'BLOCK' } },
  ]));

  testUtils.testWithClient('existing non-proxy client setup still works', async (client) => {
    assert.equal(await client.set('dmc-proxy:plain', 'ok'), 'OK');
    assert.equal(await client.get('dmc-proxy:plain'), 'ok');
  }, {
    ...GLOBAL.SERVERS.OPEN,
    clientOptions: {
      disableClientInfo: true,
    },
  });
});
