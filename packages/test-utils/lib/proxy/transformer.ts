/**
 * Stable connection metadata passed to per-connection operator factories.
 */
export interface ConnectionBase {
  readonly id: string;
  readonly clientAddress: string;
  readonly clientPort: number;
  readonly connectedAt: Date;
}

/**
 * Mutable state passed to one installed RESP interceptor.
 *
 * The proxy creates the object and exposes it through stats. Interceptor code
 * owns the counters: `matchLimit` is carried here, but the proxy does not
 * increment or enforce it.
 */
export interface RespInterceptorState {
  name: string;
  matchLimit?: number;
  invokeCount: number;
  matchCount: number;
}

/**
 * Connection view exposed to plugin operator factories.
 */
export interface ConnectionInfo extends ConnectionBase {
  readonly interceptors: RespInterceptorState[];
}

/**
 * Downstream continuation for a RESP interceptor.
 *
 * Pass request bytes to the next RESP interceptor, or to the Redis sink when
 * this is the last interceptor. Resolves with the matching RESP reply bytes.
 */
export type RespInterceptorNext = (data: Buffer) => Promise<Buffer>;

/**
 * RESP request/reply hook.
 *
 * Interceptors run after plugin operators and before the Redis sink. `data` is
 * a complete RESP request buffer emitted by the plugin stream. It may contain
 * one command or a grouped set of command arrays.
 *
 * Call `next(data)` to continue, call `next(modifiedData)` to rewrite the
 * request, await `next` and return different bytes to rewrite the reply, or
 * return a RESP reply without calling `next` to handle the request locally.
 */
export type RespInterceptorFn = (
  data: Buffer,
  next: RespInterceptorNext,
  state: RespInterceptorState
) => Promise<Buffer>;

/**
 * RESP interceptor registration.
 */
export interface RespInterceptorSpec {
  name: string;
  matchLimit?: number;
  fn: RespInterceptorFn;
}

/**
 * Function an operator calls to pass one item downstream.
 */
export type Sink<I, R = Buffer> = (input: I) => Promise<R>;

/**
 * One operator in the proxy byte stream.
 *
 * `transform` is called once for each item emitted by the previous operator.
 * It calls `next(output)` for each item it wants to emit downstream and returns
 * the replies produced while handling the input.
 *
 * Code shapes:
 *
 * ```ts
 * // Buffering: no complete item to emit yet.
 * transform: async () => []
 *
 * // One input emits one downstream item.
 * transform: async (input, next) => [await next(input)]
 *
 * // One input emits several downstream items.
 * transform: async (input, next) => {
 *   const outputs = splitIntoMessages(input);
 *   const replies = [];
 *   for (const output of outputs) {
 *     replies.push(await next(output));
 *   }
 *   return replies;
 * }
 *
 * // Local handling: produce a reply without calling downstream.
 * transform: async () => [localReply]
 * ```
 */
export interface Transformer<I, O, R = Buffer> {
  transform(input: I, next: Sink<O, R>): Promise<readonly R[]>;
}

/**
 * Byte-buffer operator shape accepted by the proxy host.
 *
 * A proxy plugin receives buffers from the previous operator and emits buffers
 * to the next plugin, the RESP interceptor adapter, or the Redis sink.
 */
export type BufferTransformer = Transformer<Buffer, Buffer>;

/**
 * Factory for per-connection stream operators.
 *
 * Each accepted client socket gets its own transformer instance, so plugins can
 * keep parser buffers and connection-local state without sharing them across
 * sockets.
 */
export interface ProxyPlugin {
  initialize?(): Promise<void> | void;

  createTransformer(connection: ConnectionInfo): BufferTransformer;

  cleanupConnection?(connectionId: string): void;
}

/**
 * Compose two operators whose output and input types match.
 */
export function composeTransformers<A, B, C>(
  first: Transformer<A, B>,
  second: Transformer<B, C>
): Transformer<A, C> {
  return {
    transform: (input, next) => first.transform(input, async (middle) => {
      const responses = await second.transform(middle, next);
      return Buffer.concat(responses);
    }),
  };
}

/**
 * Compose byte-buffer operators from left to right.
 */
export function composeBufferTransformers(transformers: readonly BufferTransformer[]): BufferTransformer {
  if (transformers.length === 0) {
    return {
      transform: async (input, next) => [await next(input)],
    };
  }

  let transformer = transformers[0];
  for (let i = 1; i < transformers.length; i++) {
    transformer = composeTransformers(transformer, transformers[i]);
  }
  return transformer;
}
