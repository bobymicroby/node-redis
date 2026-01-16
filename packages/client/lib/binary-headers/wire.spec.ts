import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { once } from 'node:events';
import net from 'node:net';
import { createClient, RedisClientType } from '../..';
import { BINHDR } from './constants';
import { createRequestHeader, encodeRequestHeader, encodeRequestHeaderInto, encodeResponseHeader } from './encoder';
import { parseRequestHeader, parseResponseHeader, isBinaryHeaderDesignator } from './decoder';
import { createResponseHeader, createBinhdrResponse } from './test-utils';
import type { BinaryResponseHeader } from './types';

// ============================================================================
// Test Helpers
// ============================================================================

interface ParsedRequest {
  hasBinaryHeader: boolean;
  header?: {
    designator: number;
    length: number;
    commandCount: number;
    slot: number;
    clientIdx: number;
  };
  payload: Buffer;
}

function parseClientRequest(data: Buffer): ParsedRequest {
  if (data.length >= BINHDR.REQUEST_HEADER_SIZE && isBinaryHeaderDesignator(data[0])) {
    const result = parseRequestHeader(data, 0);
    if (result.success) {
      return {
        hasBinaryHeader: true,
        header: result.header,
        payload: data.subarray(BINHDR.REQUEST_HEADER_SIZE),
      };
    }
  }
  return { hasBinaryHeader: false, payload: data };
}

function countRespCommands(payload: Buffer): number {
  let count = 0;
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] === 0x2a) count++; // '*'
  }
  return count;
}

// ============================================================================
// Unit Tests: Header Encode/Decode Round-trips
// ============================================================================

describe('Binary Headers Wire Format', () => {
  describe('Request Header Round-trip', () => {
    const requestTestCases = [
      { name: 'minimum values', length: 0, commandCount: 1, slot: 0, clientIdx: 0 },
      { name: 'maximum values', length: BINHDR.MAX_PAYLOAD_LENGTH, commandCount: 127, slot: BINHDR.SLOT_MAX_VALID, clientIdx: BINHDR.MAX_CLIENT_IDX },
      { name: 'SLOT_NO_SLOT', length: 100, commandCount: 5, slot: BINHDR.SLOT_NO_SLOT, clientIdx: 42 },
      { name: 'spec example', length: 159, commandCount: 6, slot: 16287, clientIdx: 100 },
      { name: 'single command', length: 10, commandCount: 1, slot: 0, clientIdx: 1 },
      { name: 'max commands', length: 5000, commandCount: 127, slot: 8192, clientIdx: 255 },
      { name: 'slot boundaries', length: 50, commandCount: 3, slot: 16383, clientIdx: 100 },
      { name: 'clientIdx boundary', length: 100, commandCount: 1, slot: 1000, clientIdx: 65535 },
      { name: 'mid-range', length: 0x12345678, commandCount: 64, slot: 8000, clientIdx: 32768 },
      { name: 'length near max', length: 0x7FFFFFFE, commandCount: 10, slot: 12345, clientIdx: 54321 },
    ];

    function testRequestHeaderRoundTrip(
      name: string,
      length: number,
      commandCount: number,
      slot: number,
      clientIdx: number
    ) {
      const createResult = createRequestHeader(length, commandCount, slot, clientIdx);
      assert.equal(createResult.success, true, `Failed to create header for ${name}`);
      if (!createResult.success) return;

      const encoded = encodeRequestHeader(createResult.header);
      const parseResult = parseRequestHeader(encoded);

      assert.equal(parseResult.success, true, `Failed to parse header for ${name}`);
      if (parseResult.success) {
        assert.deepEqual(parseResult.header, createResult.header);
      }
    }

    for (const { name, length, commandCount, slot, clientIdx } of requestTestCases) {
      it(`encodeRequestHeader round-trips: ${name}`, () => {
        testRequestHeaderRoundTrip(name, length, commandCount, slot, clientIdx);
      });

      it(`encodeRequestHeaderInto round-trips: ${name}`, () => {
        const createResult = createRequestHeader(length, commandCount, slot, clientIdx);
        assert.equal(createResult.success, true);
        if (!createResult.success) return;

        const buffer = Buffer.alloc(BINHDR.REQUEST_HEADER_SIZE);
        const encodeResult = encodeRequestHeaderInto(createResult.header, buffer, 0);
        assert.equal(encodeResult.success, true);

        const parseResult = parseRequestHeader(buffer, 0);
        assert.equal(parseResult.success, true);
        if (parseResult.success) {
          assert.deepEqual(parseResult.header, createResult.header);
        }
      });

      it(`encodeRequestHeaderInto with offset round-trips: ${name}`, () => {
        const createResult = createRequestHeader(length, commandCount, slot, clientIdx);
        assert.equal(createResult.success, true);
        if (!createResult.success) return;

        const offset = 5;
        const buffer = Buffer.alloc(offset + BINHDR.REQUEST_HEADER_SIZE + 3);
        encodeRequestHeaderInto(createResult.header, buffer, offset);

        const parseResult = parseRequestHeader(buffer, offset);
        assert.equal(parseResult.success, true);
        if (parseResult.success) {
          assert.deepEqual(parseResult.header, createResult.header);
        }
      });
    }

    describe('bytes round-trip (decode → encode)', () => {
      const bytesCases = [
        { name: 'minimum', bytes: [0x80, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00] },
        { name: 'spec example', bytes: [0x80, 0x00, 0x00, 0x00, 0x9F, 0x06, 0x3F, 0x9F, 0x00, 0x64] },
        { name: 'SLOT_NO_SLOT', bytes: [0x80, 0x00, 0x00, 0x00, 0x64, 0x05, 0xFF, 0xFF, 0x00, 0x2A] },
        { name: 'max values', bytes: [0x80, 0x7F, 0xFF, 0xFF, 0xFF, 0x7F, 0x3F, 0xFF, 0xFF, 0xFF] },
        { name: 'big-endian length', bytes: [0x80, 0x12, 0x34, 0x56, 0x78, 0x01, 0x00, 0x00, 0x00, 0x00] },
        { name: 'big-endian slot', bytes: [0x80, 0x00, 0x00, 0x00, 0x00, 0x01, 0x12, 0x34, 0x00, 0x00] },
        { name: 'big-endian clientIdx', bytes: [0x80, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0xAB, 0xCD] },
      ];

      for (const { name, bytes } of bytesCases) {
        it(`round-trips bytes: ${name}`, () => {
          const buffer = Buffer.from(bytes);
          const parseResult = parseRequestHeader(buffer);
          assert.equal(parseResult.success, true);
          if (!parseResult.success) return;

          const reEncoded = encodeRequestHeader(parseResult.header);
          assert.deepEqual(reEncoded, buffer);
        });
      }
    });
  });

  describe('Response Header Round-trip', () => {
    const responseTestCases: Array<{ name: string; header: BinaryResponseHeader }> = [
      { name: 'minimum values', header: createResponseHeader(0, 1, 0, false) },
      { name: 'maximum values', header: createResponseHeader(BINHDR.MAX_PAYLOAD_LENGTH, 127, BINHDR.MAX_CLIENT_IDX, false) },
      { name: 'typical without error', header: createResponseHeader(159, 6, 100, false) },
      { name: 'typical with error', header: createResponseHeader(50, 3, 42, true) },
      { name: 'single command', header: createResponseHeader(10, 1, 1, false) },
      { name: 'max commands', header: createResponseHeader(5000, 127, 255, false) },
      { name: 'error max commands', header: createResponseHeader(100, 127, 1000, true) },
      { name: 'zero length', header: createResponseHeader(0, 5, 500, false) },
      { name: 'large length', header: createResponseHeader(0x7FFFFFFE, 10, 12345, false) },
      { name: 'clientIdx boundaries', header: createResponseHeader(100, 1, 65535, false) },
      { name: 'mid-range', header: createResponseHeader(0x12345678, 64, 0x8000, false) },
    ];

    for (const { name, header } of responseTestCases) {
      it(`round-trips: ${name}`, () => {
        const encoded = encodeResponseHeader(header);
        const result = parseResponseHeader(encoded);
        assert.equal(result.success, true);
        if (result.success) {
          assert.deepEqual(result.header, header);
        }
      });
    }

    describe('bytes round-trip (decode → encode)', () => {
      const bytesCases = [
        { name: 'minimum', bytes: [0x80, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00] },
        { name: 'spec example', bytes: [0x80, 0x00, 0x00, 0x00, 0x32, 0x03, 0x00, 0x2A] },
        { name: 'with error bit', bytes: [0x80, 0x00, 0x00, 0x00, 0x64, 0x83, 0x00, 0x05] },
        { name: 'max count', bytes: [0x80, 0x00, 0x00, 0x00, 0x00, 0x7F, 0x00, 0x00] },
        { name: 'max count + error', bytes: [0x80, 0x00, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00] },
        { name: 'big-endian length', bytes: [0x80, 0x12, 0x34, 0x56, 0x78, 0x01, 0xAB, 0xCD] },
        { name: 'max length', bytes: [0x80, 0x7F, 0xFF, 0xFF, 0xFF, 0x01, 0xFF, 0xFF] },
      ];

      for (const { name, bytes } of bytesCases) {
        it(`round-trips bytes: ${name}`, () => {
          const buffer = Buffer.from(bytes);
          const result = parseResponseHeader(buffer);
          assert.equal(result.success, true);
          if (!result.success) return;

          const reEncoded = encodeResponseHeader(result.header);
          assert.deepEqual(reEncoded, buffer);
        });
      }
    });
  });

  describe('Field Preservation', () => {
    it('preserves all length values', () => {
      const lengths = [0, 1, 255, 256, 65535, 65536, 0x00FFFFFF, 0x7FFFFFFF];
      for (const length of lengths) {
        const result = createRequestHeader(length, 1, 0, 0);
        assert.equal(result.success, true);
        if (!result.success) continue;

        const encoded = encodeRequestHeader(result.header);
        const parsed = parseRequestHeader(encoded);
        assert.equal(parsed.success, true);
        if (parsed.success) {
          assert.equal(parsed.header.length, length, `length 0x${length.toString(16)}`);
        }
      }
    });

    it('preserves all slot values', () => {
      const slots = [0, 1, 8191, 8192, 16383, BINHDR.SLOT_NO_SLOT];
      for (const slot of slots) {
        const result = createRequestHeader(100, 1, slot, 0);
        assert.equal(result.success, true);
        if (!result.success) continue;

        const encoded = encodeRequestHeader(result.header);
        const parsed = parseRequestHeader(encoded);
        assert.equal(parsed.success, true);
        if (parsed.success) {
          assert.equal(parsed.header.slot, slot, `slot 0x${slot.toString(16)}`);
        }
      }
    });

    it('preserves all commandCount values (1-127)', () => {
      for (let count = 1; count <= 127; count++) {
        // Request header
        const reqResult = createRequestHeader(100, count, 0, 0);
        assert.equal(reqResult.success, true);
        if (reqResult.success) {
          const reqEncoded = encodeRequestHeader(reqResult.header);
          const reqParsed = parseRequestHeader(reqEncoded);
          assert.equal(reqParsed.success, true);
          if (reqParsed.success) {
            assert.equal(reqParsed.header.commandCount, count);
          }
        }

        // Response header
        const respHeader = createResponseHeader(100, count, 0, false);
        const respEncoded = encodeResponseHeader(respHeader);
        const respParsed = parseResponseHeader(respEncoded);
        assert.equal(respParsed.success, true);
        if (respParsed.success) {
          assert.equal(respParsed.header.commandCount, count);
        }
      }
    });

    it('preserves protocolError independently of commandCount', () => {
      for (let count = 1; count <= 127; count++) {
        const noError = createResponseHeader(100, count, 0, false);
        const withError = createResponseHeader(100, count, 0, true);

        const parsedNoError = parseResponseHeader(encodeResponseHeader(noError));
        const parsedWithError = parseResponseHeader(encodeResponseHeader(withError));

        assert.equal(parsedNoError.success, true);
        assert.equal(parsedWithError.success, true);

        if (parsedNoError.success && parsedWithError.success) {
          assert.equal(parsedNoError.header.commandCount, count);
          assert.equal(parsedNoError.header.protocolError, false);
          assert.equal(parsedWithError.header.commandCount, count);
          assert.equal(parsedWithError.header.protocolError, true);
        }
      }
    });
  });

  // ==========================================================================
  // Integration Tests: Client Wire Format with Mock Server
  // ==========================================================================

  describe('Client Wire Format (Integration)', function () {
    this.timeout(10000);

    let server: net.Server;
    let port: number;
    let receivedRequests: ParsedRequest[];
    let client: RedisClientType;

    async function getFreePort(): Promise<number> {
      return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, () => {
          const addr = srv.address();
          if (addr && typeof addr === 'object') {
            srv.close(() => resolve(addr.port));
          } else {
            reject(new Error('Could not get port'));
          }
        });
      });
    }

    type ResponseMode = 'smart' | 'ok-only' | 'pong-only';

    function createMockServer(mode: ResponseMode = 'smart'): net.Server {
      return net.createServer((socket) => {
        socket.on('data', (data) => {
          const parsed = parseClientRequest(data);
          receivedRequests.push(parsed);

          const cmdCount = parsed.header?.commandCount ?? 1;
          const payloadStr = parsed.payload.toString();

          for (let i = 0; i < cmdCount; i++) {
            const resp = mode === 'pong-only' ? '+PONG\r\n'
              : mode === 'ok-only' ? '+OK\r\n'
              : payloadStr.includes('PING') ? '+PONG\r\n' : '+OK\r\n';
            socket.write(createBinhdrResponse(resp));
          }
        });
      });
    }

    async function createConnectedClient(): Promise<RedisClientType> {
      client = createClient({
        socket: { host: 'localhost', port },
        binaryHeaders: true,
        disableClientInfo: true,
      });
      client.on('error', () => {});
      await client.connect();
      return client;
    }

    function findRequest(predicate: (payload: string) => boolean): ParsedRequest | undefined {
      return receivedRequests.find(req => predicate(req.payload.toString()));
    }

    function assertValidBinaryHeader(req: ParsedRequest): void {
      assert(req.hasBinaryHeader, 'Should have binary header');
      assert.equal(req.header!.designator, BINHDR.DESIGNATOR);
      assert(req.header!.length > 0);
      assert(req.header!.commandCount >= 1 && req.header!.commandCount <= 127);
      assert.equal(req.payload.length, req.header!.length);
    }

    beforeEach(async function () {
      port = await getFreePort();
      receivedRequests = [];
    });

    afterEach(function () {
      client?.destroy();
      server?.close();
    });

    it('sends binary header with correct structure', async function () {
      server = createMockServer('pong-only');
      await once(server.listen(port), 'listening');
      await createConnectedClient();

      await client.ping();

      assert(receivedRequests.length >= 1);
      const req = receivedRequests[receivedRequests.length - 1];
      assertValidBinaryHeader(req);
      assert.equal(req.header!.commandCount, 1);
    });

    it('packs multiple commands with same slot', async function () {
      server = createMockServer('ok-only');
      await once(server.listen(port), 'listening');
      await createConnectedClient();

      await Promise.all([
        client.sendCommand(['SET', '{x}key1', 'value1']),
        client.sendCommand(['SET', '{x}key2', 'value2']),
        client.sendCommand(['SET', '{x}key3', 'value3']),
      ]);

      const packedReq = receivedRequests.find(r => r.hasBinaryHeader && r.header!.commandCount > 1);
      if (packedReq) {
        assert(packedReq.header!.commandCount >= 2);
        assert.equal(countRespCommands(packedReq.payload), packedReq.header!.commandCount);
        assert(packedReq.header!.slot !== BINHDR.SLOT_NO_SLOT);
      }
    });

    it('sets correct slot for keyed commands', async function () {
      server = createMockServer('ok-only');
      await once(server.listen(port), 'listening');
      await createConnectedClient();

      await client.sendCommand(['SET', 'mykey', 'myvalue']);

      const setReq = findRequest(p => p.includes('mykey'));
      assert(setReq);
      assertValidBinaryHeader(setReq);
      assert(setReq.header!.slot !== BINHDR.SLOT_NO_SLOT);
      assert(setReq.header!.slot <= BINHDR.SLOT_MAX_VALID);
    });

    it('handles chunked response correctly', async function () {
      server = net.createServer((socket) => {
        socket.on('data', (data) => {
          receivedRequests.push(parseClientRequest(data));
          const response = createBinhdrResponse('+PONG\r\n');
          socket.write(response.subarray(0, 4));
          setTimeout(() => socket.write(response.subarray(4)), 20);
        });
      });
      await once(server.listen(port), 'listening');
      await createConnectedClient();

      assert.equal(await client.ping(), 'PONG');

      const pingReq = findRequest(p => p.includes('PING'));
      assert(pingReq);
      assertValidBinaryHeader(pingReq);
    });

    it('client works normally with binary headers disabled', async function () {
      server = net.createServer((socket) => {
        socket.on('data', () => socket.write('+PONG\r\n'));
      });
      await once(server.listen(port), 'listening');

      client = createClient({
        socket: { host: 'localhost', port },
        binaryHeaders: false,
        disableClientInfo: true,
      });
      client.on('error', () => {});
      await client.connect();

      assert.equal(await client.ping(), 'PONG');
    });
  });
});
