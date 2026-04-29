import * as net from 'net';
import { createServer } from 'net';
import { EventEmitter } from 'events';
import {
  DmcPlugin,
  hasDmcStats,
  type DmcProxyConfig,
  type DmcStats,
  type DmcStatsSource,
} from './dmc-plugin';
import {
  composeBufferTransformers,
  composeTransformers,
  type ConnectionBase,
  type ConnectionInfo,
  type BufferTransformer,
  type ProxyPlugin,
  type RespInterceptorFn,
  type RespInterceptorSpec,
  type RespInterceptorState,
  type Sink,
  type Transformer,
} from './transformer';
import RespFramer from './resp-framer';
import RespQueue from './resp-queue';

/**
 * Listen socket, Redis target, and optional proxy plugins.
 */
interface ProxyConfig {
  readonly listenPort: number;
  readonly listenHost?: string;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly timeout?: number;
  readonly enableLogging?: boolean;
  readonly plugins?: readonly ProxyPlugin[];
  readonly dmcBinaryHeadersProxy?: DmcProxyConfig;
}

interface ActiveConnection extends ConnectionBase {
  readonly clientSocket: net.Socket;
  readonly serverSocket: net.Socket;
  interceptors: Interceptor[];
}

type SendResult =
  | { readonly success: true; readonly connectionId: string }
  | { readonly success: false; readonly error: string; readonly connectionId: string };

type Direction = 'client->server' | 'server->client';

interface ProxyStats {
  readonly activeConnections: number;
  readonly totalConnections: number;
  readonly connections: readonly ConnectionInfo[];
  readonly globalInterceptors: RespInterceptorState[];
}

interface ProxyEvents {
  /** Emitted after the Redis-side socket connects for a client. */
  'connection': (connectionInfo: ConnectionInfo) => void;
  /** Emitted after connection cleanup removes the socket pair. */
  'disconnect': (connectionInfo: ConnectionInfo) => void;
  /** Emitted for bytes written toward Redis or toward the client. */
  'data': (connectionId: string, direction: Direction, data: Buffer) => void;
  /** Emitted for client, Redis-side, or proxy server socket errors. */
  'error': (error: Error, connectionId?: string) => void;
  /** Emitted after the proxy listen socket is bound. */
  'listening': (host: string, port: number) => void;
  /** Emitted after the proxy listen socket closes. */
  'close': () => void;
}

interface Interceptor {
  name: string;
  state: RespInterceptorState;
  fn: RespInterceptorFn;
}

type ResolvedProxyConfig = Omit<Required<ProxyConfig>, 'dmcBinaryHeadersProxy'> & {
  readonly dmcBinaryHeadersProxy?: DmcProxyConfig;
};

function countRespMessages(data: Buffer): number {
  let count = 0;
  const framer = new RespFramer();
  framer.on('message', () => count++);
  framer.write(data);

  return count || 1;
}

/**
 * Default parser for client byte streams that contain plain RESP only.
 */
class RespPlugin implements ProxyPlugin {
  public createTransformer(): BufferTransformer {
    const framer = new RespFramer();
    return {
      transform: async (chunk, next) => {
        const frames: Buffer[] = [];
        const onMessage = (frame: Buffer) => frames.push(frame);
        framer.on('message', onMessage);

        try {
          framer.write(chunk);
        } finally {
          framer.off('message', onMessage);
        }

        const responses: Buffer[] = [];
        for (const frame of frames) {
          responses.push(await next(frame));
        }
        return responses;
      },
    };
  }
}

/**
 * TCP proxy between node-redis and a Redis test server.
 *
 * Client bytes pass through a built-in parser, configured proxy plugins,
 * public RESP interceptors, then the Redis sink. Enabling the DMC config
 * swaps the built-in RESP parser for the DMC parser.
 */
export class RedisProxy extends EventEmitter {
  private readonly server: net.Server;
  public readonly config: ResolvedProxyConfig;
  private readonly connections: Map<string, ActiveConnection>;
  private isRunning: boolean;
  private globalInterceptors: Interceptor[] = [];
  private readonly plugins: readonly ProxyPlugin[];

  constructor(config: ProxyConfig) {
    super();

    const enableLogging = config.enableLogging ?? config.dmcBinaryHeadersProxy?.enableLogging ?? false;

    this.config = {
      listenHost: '127.0.0.1',
      timeout: 30000,
      plugins: [],
      ...config,
      enableLogging
    };

    this.connections = new Map();
    this.isRunning = false;
    this.plugins = this.createPlugins();
    this.server = this.createServer();
  }

  /**
   * Initialize plugins before accepting client sockets.
   */
  public async start(): Promise<void> {
    await this.initializePlugins();

    return new Promise((resolve, reject) => {
      if (this.isRunning) {
        reject(new Error('Proxy is already running'));
        return;
      }

      this.server.listen(this.config.listenPort, this.config.listenHost, () => {
        this.isRunning = true;
        this.log(`Proxy listening on ${this.config.listenHost}:${this.config.listenPort}`);
        this.log(`Forwarding to Redis server at ${this.config.targetHost}:${this.config.targetPort}`);
        this.emit('listening', this.config.listenHost, this.config.listenPort);
        resolve();
      });

      this.server.on('error', (error) => {
        this.emit('error', error);
        reject(error);
      });
    });
  }

  private createPlugins(): readonly ProxyPlugin[] {
    const parserPlugin = this.config.dmcBinaryHeadersProxy === undefined
      ? new RespPlugin()
      : new DmcPlugin(this.config.dmcBinaryHeadersProxy);

    return [
      parserPlugin,
      ...(this.config.plugins ?? []),
    ];
  }

  private async initializePlugins(): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.initialize?.();
    }
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.isRunning) {
        resolve();
        return;
      }

      Array.from(this.connections.keys()).forEach((connectionId) => {
        this.closeConnection(connectionId);
      });

      this.server.close(() => {
        this.isRunning = false;
        this.log('Proxy server stopped');
        this.emit('close');
        resolve();
      });
    });
  }

  private makeInterceptor(spec: RespInterceptorSpec): Interceptor {
    const { name, fn, matchLimit } = spec;
    return {
      name,
      fn,
      state: {
        name,
        matchCount: 0,
        invokeCount: 0,
        matchLimit,
      },
    };
  }

  /**
   * Existing connections use the new list on their next request.
   */
  public setGlobalInterceptors(
    interceptorSpecs: Array<RespInterceptorSpec>,
  ) {
    const interceptors: Interceptor[] = interceptorSpecs.map(this.makeInterceptor);
    this.globalInterceptors = interceptors;
  }

  public addGlobalInterceptor(
    interceptorSpec: RespInterceptorSpec,
  ) {
    const interceptor = this.makeInterceptor(interceptorSpec);
    this.globalInterceptors = [interceptor, ...this.globalInterceptors.filter(i => i.name !== interceptor.name)];
  }

  public getStats(): ProxyStats {
    const connections = Array.from(this.connections.values());

    return {
      activeConnections: connections.length,
      totalConnections: connections.length,
      globalInterceptors: this.globalInterceptors.map(i => i.state),
      connections: connections.map((conn) => ({
        id: conn.id,
        clientAddress: conn.clientAddress,
        clientPort: conn.clientPort,
        connectedAt: conn.connectedAt,
        interceptors: conn.interceptors.map(i => i.state)
      })),
    };
  }

  /**
   * DMC request records live on the parser plugin.
   */
  public getDmcStats(): DmcStats {
    return this.getDmcStatsSource()?.getDmcStats() ?? {
      connections: [],
      requests: [],
    };
  }

  public clearDmcStats(): void {
    this.getDmcStatsSource()?.clearDmcStats();
  }

  private getDmcStatsSource(): DmcStatsSource | undefined {
    return this.plugins.find(hasDmcStats);
  }

  private cleanupPlugins(connectionId: string): void {
    for (const plugin of this.plugins) {
      plugin.cleanupConnection?.(connectionId);
    }
  }

  public closeConnection(connectionId: string): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return false;
    }

    connection.clientSocket.destroy();
    connection.serverSocket.destroy();
    this.connections.delete(connectionId);
    this.cleanupPlugins(connectionId);
    this.emit('disconnect', connection);
    return true;
  }

  public sendToClient(connectionId: string, data: Buffer): SendResult {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return {
        success: false,
        error: 'Connection not found',
        connectionId
      };
    }

    if (connection.clientSocket.destroyed || !connection.clientSocket.writable) {
      return {
        success: false,
        error: 'Client socket is not writable',
        connectionId
      };
    }

    try {
      connection.clientSocket.write(data);

      this.log(`Sent ${data.length} bytes to client ${connectionId}`);
      this.emit('data', connectionId, 'server->client', data);

      return {
        success: true,
        connectionId
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.log(`Failed to send data to client ${connectionId}: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
        connectionId
      };
    }
  }

  public sendToAllClients(data: Buffer): readonly SendResult[] {
    const connectionIds = Array.from(this.connections.keys());
    const results = connectionIds.map((connectionId) =>
      this.sendToClient(connectionId, data)
    );

    const successCount = results.filter((result) => result.success).length;
    const totalCount = results.length;

    this.log(`Sent ${data.length} bytes to ${successCount}/${totalCount} clients`);

    return results;
  }

  public sendToClients(connectionIds: readonly string[], data: Buffer): readonly SendResult[] {
    const results = connectionIds.map((connectionId) =>
      this.sendToClient(connectionId, data)
    );

    const successCount = results.filter((result) => result.success).length;
    const totalCount = results.length;

    this.log(`Sent ${data.length} bytes to ${successCount}/${totalCount} specified clients`);

    return results;
  }

  public getActiveConnectionIds(): readonly string[] {
    return Array.from(this.connections.keys());
  }

  private createServer(): net.Server {
    return net.createServer((clientSocket) => {
      this.handleClientConnection(clientSocket);
    });
  }

  /**
   * Do not read client bytes until the Redis socket exists and the stream
   * handlers are installed.
   */
  private handleClientConnection(clientSocket: net.Socket): void {
    clientSocket.pause();
    const serverSocket = this.createTargetSocket();
    serverSocket.once('connect', clientSocket.resume.bind(clientSocket));

    const connectionInfo = this.createConnectionInfo(clientSocket, serverSocket);
    this.connections.set(connectionInfo.id, connectionInfo);
    this.log(`New connection ${connectionInfo.id} from ${connectionInfo.clientAddress}:${connectionInfo.clientPort}`);

    clientSocket.setTimeout(this.config.timeout);

    serverSocket.on('connect', () => {
      this.log(`Connected to Redis server for connection ${connectionInfo.id}`);
      this.emit('connection', connectionInfo);
    });

    const respQueue = new RespQueue(serverSocket);
    const proxyTransformer = this.createProxyTransformer(connectionInfo);
    const interceptorTransformer = this.createInterceptorTransformer(connectionInfo);
    const redisSink = this.createRedisSink(connectionInfo, respQueue);

    this.attachStream(connectionInfo, proxyTransformer, interceptorTransformer, redisSink);
    this.attachPushHandler(connectionInfo, respQueue);
    this.attachSocketLifecycleHandlers(connectionInfo);
  }

  private createTargetSocket(): net.Socket {
    return net.createConnection({
      host: this.config.targetHost,
      port: this.config.targetPort
    });
  }

  private createConnectionInfo(
    clientSocket: net.Socket,
    serverSocket: net.Socket
  ): ActiveConnection {
    return {
      id: this.generateConnectionId(),
      clientAddress: clientSocket.remoteAddress || 'unknown',
      clientPort: clientSocket.remotePort || 0,
      connectedAt: new Date(),
      clientSocket,
      serverSocket,
      interceptors: [],
    };
  }

  private getConnectionInfo(connection: ActiveConnection): ConnectionInfo {
    return {
      id: connection.id,
      clientAddress: connection.clientAddress,
      clientPort: connection.clientPort,
      connectedAt: connection.connectedAt,
      interceptors: connection.interceptors.map((interceptor) => interceptor.state),
    };
  }

  /**
   * Build this connection's byte transformer chain.
   */
  private createProxyTransformer(connection: ActiveConnection): BufferTransformer {
    const connectionInfo = this.getConnectionInfo(connection);
    return composeBufferTransformers(
      this.plugins.map((plugin) => plugin.createTransformer(connectionInfo))
    );
  }

  /**
   * Run public RESP interceptors after proxy plugins.
   */
  private createInterceptorTransformer(connection: ActiveConnection): Transformer<Buffer, Buffer> {
    return {
      transform: async (data, next) => {
        const interceptorChain = connection.interceptors.concat(this.globalInterceptors).reduceRight<Sink<Buffer, Buffer>>(
          (nextInterceptor, interceptor) => (data) =>
            interceptor.fn(
              data,
              nextInterceptor,
              interceptor.state,
            ),
          next,
        );

        return [await interceptorChain(data)];
      },
    };
  }

  /**
   * Write RESP bytes to Redis. Reply count is derived after interceptors run.
   */
  private createRedisSink(
    connection: ActiveConnection,
    respQueue: RespQueue
  ): Sink<Buffer, Buffer> {
    return async (data) => {
      this.emit('data', connection.id, 'client->server', data);
      return respQueue.request(data, countRespMessages(data));
    };
  }

  /**
   * Keep response order equal to request read order.
   */
  private attachStream(
    connection: ActiveConnection,
    proxyTransformer: BufferTransformer,
    interceptorTransformer: Transformer<Buffer, Buffer>,
    redisSink: Sink<Buffer, Buffer>
  ): void {
    const requestTransformer = composeTransformers(proxyTransformer, interceptorTransformer);
    let responseChain = Promise.resolve();

    connection.clientSocket.on('data', (chunk) => {
      responseChain = responseChain.then(async () => {
        const responses = await requestTransformer.transform(chunk, redisSink);
        for (const response of responses) {
          this.writeResponseToClient(connection, response);
        }
      }).catch((err) => {
        this.handleProxyError(connection, err);
      });
    });
  }

  private attachPushHandler(
    connection: ActiveConnection,
    respQueue: RespQueue
  ): void {
    respQueue.on('push', (data) => {
      this.writeResponseToClient(connection, data);
    });
  }

  private writeResponseToClient(connection: ActiveConnection, response: Buffer): void {
    this.emit('data', connection.id, 'server->client', response);
    connection.clientSocket.write(response);
  }

  private handleProxyError(connection: ActiveConnection, error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.log(`Proxy error for connection ${connection.id}: ${err.message}`);
    this.emit('error', err, connection.id);
    connection.clientSocket.destroy();
    connection.serverSocket.destroy();
    this.cleanupConnection(connection.id);
  }

  private attachSocketLifecycleHandlers(connection: ActiveConnection): void {
    connection.clientSocket.on('close', () => {
      this.log(`Client disconnected for connection ${connection.id}`);
      connection.serverSocket.destroy();
      this.cleanupConnection(connection.id);
    });

    connection.serverSocket.on('close', () => {
      this.log(`Server disconnected for connection ${connection.id}`);
      connection.clientSocket.destroy();
      this.cleanupConnection(connection.id);
    });

    connection.clientSocket.on('error', (error) => {
      this.log(`Client error for connection ${connection.id}: ${error.message}`);
      this.emit('error', error, connection.id);
      connection.serverSocket.destroy();
      this.cleanupConnection(connection.id);
    });

    connection.serverSocket.on('error', (error) => {
      this.log(`Server error for connection ${connection.id}: ${error.message}`);
      this.emit('error', error, connection.id);
      connection.clientSocket.destroy();
      this.cleanupConnection(connection.id);
    });

    connection.clientSocket.on('timeout', () => {
      this.log(`Connection ${connection.id} timed out`);
      connection.clientSocket.destroy();
      connection.serverSocket.destroy();
      this.cleanupConnection(connection.id);
    });
  }

  private cleanupConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      this.connections.delete(connectionId);
      this.cleanupPlugins(connectionId);
      this.emit('disconnect', connection);
    }
  }

  private generateConnectionId(): string {
    return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private log(message: string): void {
    if (this.config.enableLogging) {
      console.log(`[RedisProxy] ${new Date().toISOString()} - ${message}`);
    }
  }
}

export function getFreePortNumber(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.listen(0, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        }
      });
    });

    server.on('error', reject);
  });
}

export { RedisProxy as RedisTransparentProxy };
export type { DmcConnection, DmcProxyConfig, DmcRequest, DmcStats } from './dmc-plugin';
export type {
  ConnectionInfo,
  BufferTransformer,
  ProxyPlugin,
  RespInterceptorFn,
  RespInterceptorNext,
  RespInterceptorSpec,
  RespInterceptorState,
  Sink,
  Transformer,
} from './transformer';
export type { ProxyConfig, ProxyEvents, SendResult, Direction, ProxyStats };
