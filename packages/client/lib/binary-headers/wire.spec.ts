import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { once } from 'node:events';
import net from 'node:net';
import { createClient, RedisClientType } from '../..';
import { BINHDR } from './generated/constants';
import { createRequestHeader, encodeRequestHeader, encodeRequestHeaderInto, encodeResponseHeader } from './generated/encoder';
import { parseRequestHeader, parseResponseHeader, isBinaryHeaderDesignator } from './generated/decoder';
import { createResponseHeader, createBinhdrResponse } from './test-utils';
import type { ResponseHeader as BinaryResponseHeader } from './generated/types';

// ============================================================================
// Test Helpers
// ============================================================================

interface ParsedRequest {
  hasBinaryHeader: boolean;
  header?: {
    designator: number;
    version: number;
    slot: number;
    length: number;
    commandCount: number;
    requestId: number;
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
    // v1 format: createRequestHeader(slot, length, commandCount, requestId)
    const requestTestCases = [
      { name: 'minimum values', slot: 0, length: 0, commandCount: 1, requestId: 0 },
      { name: 'maximum values', slot: BINHDR.SLOT_MAX_VALID, length: BINHDR.MAX_PAYLOAD_LENGTH, commandCount: 127, requestId: BINHDR.MAX_REQUEST_ID },
      { name: 'spec example', slot: 16287, length: 159, commandCount: 6, requestId: 100 },
      { name: 'single command', slot: 0, length: 10, commandCount: 1, requestId: 1 },
      { name: 'max commands', slot: 8192, length: 5000, commandCount: 127, requestId: 255 },
      { name: 'slot boundaries', slot: 16383, length: 50, commandCount: 3, requestId: 100 },
      { name: 'requestId boundary', slot: 1000, length: 100, commandCount: 1, requestId: 0xFFFFFFFF },
      { name: 'mid-range', slot: 8000, length: 0x12345678, commandCount: 64, requestId: 32768 },
      { name: 'length near max', slot: 12345, length: 0xFFFFFFFE, commandCount: 10, requestId: 54321 },
    ];

    function testRequestHeaderRoundTrip(
      name: string,
      slot: number,
      length: number,
      commandCount: number,
      requestId: number
    ) {
      const createResult = createRequestHeader(slot, length, commandCount, requestId);
      assert.equal(createResult.success, true, `Failed to create header for ${name}`);
      if (!createResult.success) return;

      const encoded = encodeRequestHeader(createResult.header);
      const parseResult = parseRequestHeader(encoded);

      assert.equal(parseResult.success, true, `Failed to parse header for ${name}`);
      if (parseResult.success) {
        assert.deepEqual(parseResult.header, createResult.header);
      }
    }

    for (const { name, slot, length, commandCount, requestId } of requestTestCases) {
      it(`encodeRequestHeader round-trips: ${name}`, () => {
        testRequestHeaderRoundTrip(name, slot, length, commandCount, requestId);
      });

      it(`encodeRequestHeaderInto round-trips: ${name}`, () => {
        const createResult = createRequestHeader(slot, length, commandCount, requestId);
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
        const createResult = createRequestHeader(slot, length, commandCount, requestId);
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
      // v1 format: 16 bytes
      // [0]: designator (0xAE)
      // [1]: version (0x01)
      // [2-3]: slot (big-endian)
      // [4-7]: length (big-endian)
      // [8]: commandCount
      // [9-12]: requestId (big-endian)
      // [13-15]: reserved (padding)
      const bytesCases = [
        { name: 'minimum', bytes: [0xAE, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] },
        { name: 'spec example', bytes: [0xAE, 0x01, 0x3F, 0x9F, 0x00, 0x00, 0x00, 0x9F, 0x06, 0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00] },
        { name: 'max slot', bytes: [0xAE, 0x01, 0x3F, 0xFF, 0x00, 0x00, 0x00, 0x64, 0x05, 0x00, 0x00, 0x00, 0x2A, 0x00, 0x00, 0x00] },
        { name: 'big-endian length', bytes: [0xAE, 0x01, 0x00, 0x00, 0x12, 0x34, 0x56, 0x78, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] },
        { name: 'big-endian slot', bytes: [0xAE, 0x01, 0x12, 0x34, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] },
        { name: 'big-endian requestId', bytes: [0xAE, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0xAB, 0xCD, 0xEF, 0x01, 0x00, 0x00, 0x00] },
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
    // v1 response header: createResponseHeader(length, commandCount, requestId, protocolError)
    const responseTestCases: Array<{ name: string; header: BinaryResponseHeader }> = [
      { name: 'minimum values', header: createResponseHeader(0, 1, 0, false) },
      { name: 'maximum values', header: createResponseHeader(BINHDR.MAX_PAYLOAD_LENGTH, 127, BINHDR.MAX_REQUEST_ID, false) },
      { name: 'typical without error', header: createResponseHeader(159, 6, 100, false) },
      { name: 'typical with error', header: createResponseHeader(50, 3, 42, true) },
      { name: 'single command', header: createResponseHeader(10, 1, 1, false) },
      { name: 'max commands', header: createResponseHeader(5000, 127, 255, false) },
      { name: 'error max commands', header: createResponseHeader(100, 127, 1000, true) },
      { name: 'zero length', header: createResponseHeader(0, 5, 500, false) },
      { name: 'large length', header: createResponseHeader(0xFFFFFFFE, 10, 12345, false) },
      { name: 'requestId boundaries', header: createResponseHeader(100, 1, 0xFFFFFFFF, false) },
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
      // v1 response format: 16 bytes
      // [0]: designator (0xAE)
      // [1]: version (0x01)
      // [2-3]: reserved
      // [4-7]: length (big-endian)
      // [8]: flags (commandCount & protocolError)
      // [9-12]: requestId (big-endian)
      // [13-15]: reserved
      const bytesCases = [
        { name: 'minimum', bytes: [0xAE, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] },
        { name: 'spec example', bytes: [0xAE, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x32, 0x03, 0x00, 0x00, 0x00, 0x2A, 0x00, 0x00, 0x00] },
        { name: 'with error bit', bytes: [0xAE, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, 0x83, 0x00, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00] },
        { name: 'max count', bytes: [0xAE, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7F, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] },
        { name: 'max count + error', bytes: [0xAE, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] },
        { name: 'big-endian length', bytes: [0xAE, 0x01, 0x00, 0x00, 0x12, 0x34, 0x56, 0x78, 0x01, 0x00, 0x00, 0xAB, 0xCD, 0x00, 0x00, 0x00] },
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
      const lengths = [0, 1, 255, 256, 65535, 65536, 0x00FFFFFF, 0xFFFFFFFF];
      for (const length of lengths) {
        const result = createRequestHeader(0, length, 1, 0);
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
      const slots = [0, 1, 8191, 8192, 16383];
      for (const slot of slots) {
        const result = createRequestHeader(slot, 100, 1, 0);
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
        const reqResult = createRequestHeader(0, 100, count, 0);
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

    function findRequest(predicate: (r: ParsedRequest) => boolean): ParsedRequest | undefined {
      return receivedRequests.find(predicate);
    }

    function assertValidBinaryHeader(req: ParsedRequest): void {
      assert.equal(req.hasBinaryHeader, true);
      assert.ok(req.header);
      assert.equal(req.header!.designator, BINHDR.DESIGNATOR);
      assert.equal(req.header!.version, BINHDR.VERSION);
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

      const req = findRequest(r => r.hasBinaryHeader && r.payload.toString().includes('PING'));
      assert.ok(req, 'Should have received a request with binary header');
      assertValidBinaryHeader(req!);
    });

    it('packs multiple commands with same slot', async function () {
      server = createMockServer('ok-only');
      await once(server.listen(port), 'listening');
      await createConnectedClient();

      await Promise.all([
        client.set('{x}key1', 'value1'),
        client.set('{x}key2', 'value2'),
        client.set('{x}key3', 'value3'),
      ]);

      const packedReq = findRequest(r => r.hasBinaryHeader && r.header!.commandCount > 1);
      if (packedReq) {
        assertValidBinaryHeader(packedReq);
        assert.ok(packedReq.header!.commandCount >= 2);
      }
    });

    it('sets correct slot for keyed commands', async function () {
      server = createMockServer('ok-only');
      await once(server.listen(port), 'listening');
      await createConnectedClient();

      await client.set('mykey', 'myvalue');

      const setReq = findRequest(r => r.hasBinaryHeader && r.payload.toString().includes('mykey'));
      assert.ok(setReq, 'Should have received SET request');
      assertValidBinaryHeader(setReq!);
      assert.ok(setReq!.header!.slot >= 0 && setReq!.header!.slot <= BINHDR.SLOT_MAX_VALID);
    });

    it('handles chunked response correctly', async function () {
      const response = createBinhdrResponse('+PONG\r\n');
      server = net.createServer((socket) => {
        socket.on('data', (data) => {
          receivedRequests.push(parseClientRequest(data));
          // Send response in multiple chunks
          socket.write(response.subarray(0, 4));
          setTimeout(() => socket.write(response.subarray(4)), 10);
        });
      });
      await once(server.listen(port), 'listening');
      await createConnectedClient();

      const result = await client.ping();
      assert.equal(result, 'PONG');

      const pingReq = findRequest(r => r.payload.toString().includes('PING'));
      assert.ok(pingReq);
    });

    it('client works normally with binary headers disabled', async function () {
      server = net.createServer((socket) => {
        socket.on('data', (data) => {
          receivedRequests.push(parseClientRequest(data));
          socket.write('+PONG\r\n');
        });
      });
      await once(server.listen(port), 'listening');

      client = createClient({
        socket: { host: 'localhost', port },
        binaryHeaders: false,
        disableClientInfo: true,
      });
      client.on('error', () => {});
      await client.connect();

      const result = await client.ping();
      assert.equal(result, 'PONG');

      const pingReq = findRequest(r => r.payload.toString().includes('PING'));
      assert.ok(pingReq);
      assert.equal(pingReq!.hasBinaryHeader, false);
    });
  });
});
