import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { once } from 'node:events';
import net from 'node:net';
import { createClient } from '../..';
import { encodeResponseHeader } from './encoder';
import { BINHDR } from './constants';
import type { BinaryResponseHeader } from './types';

describe('Binary Headers Client Integration', function () {
  this.timeout(5000);

  async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          const port = addr.port;
          server.close(() => resolve(port));
        } else {
          reject(new Error('Could not get port'));
        }
      });
    });
  }

  function createBinhdrResponse(respPayload: string): Buffer {
    const payload = Buffer.from(respPayload);
    const header: BinaryResponseHeader = {
      designator: BINHDR.DESIGNATOR,
      length: payload.length,
      commandCount: 1,
      clientIdx: 0,
      protocolError: false,
    };
    return Buffer.concat([encodeResponseHeader(header), payload]);
  }

  it('client receives response through binary header interceptor', async function () {
    const port = await getFreePort();

    // Mock server that responds with binary headers
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        // Respond with binary header wrapped RESP
        const response = createBinhdrResponse('+PONG\r\n');
        socket.write(response);
      });
    });

    await once(server.listen(port), 'listening');

    try {
      const client = createClient({
        socket: { host: 'localhost', port },
        binaryHeaders: true,
        disableClientInfo: true,
      });

      // Suppress errors during test
      client.on('error', (e) => {console.log(e)});

      await client.connect();
      const result = await client.ping();

      assert.equal(result, 'PONG');

      client.destroy();
    } finally {
      server.close();
    }
  });

  it('client works normally without binary headers', async function () {
    const port = await getFreePort();

    // Mock server that responds with plain RESP
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        socket.write('+PONG\r\n');
      });
    });

    await once(server.listen(port), 'listening');

    try {
      const client = createClient({
        socket: { host: 'localhost', port },
        binaryHeaders: false,
        disableClientInfo: true,
      });

      client.on('error', () => {});

      await client.connect();
      const result = await client.ping();

      assert.equal(result, 'PONG');

      client.destroy();
    } finally {
      server.close();
    }
  });
});
