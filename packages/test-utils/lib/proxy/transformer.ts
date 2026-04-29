/**
 * Client connection data visible to proxy plugins.
 */
export interface ConnectionBase {
  readonly id: string;
  readonly clientAddress: string;
  readonly clientPort: number;
  readonly connectedAt: Date;
}

export interface RespInterceptorState {
  name: string;
  matchLimit?: number;
  invokeCount: number;
  matchCount: number;
}

export interface ConnectionInfo extends ConnectionBase {
  readonly interceptors: RespInterceptorState[];
}

/**
 * Continuation passed to public RESP interceptors.
 *
 * Pass RESP bytes to the next interceptor or Redis sink. Resolves with RESP
 * replies.
 */
export type RespInterceptorNext = (data: Buffer) => Promise<Buffer>;

/**
 * Public RESP interceptor.
 *
 * Runs after proxy plugins and before the Redis sink.
 */
export type RespInterceptorFn = (
  data: Buffer,
  next: RespInterceptorNext,
  state: RespInterceptorState
) => Promise<Buffer>;

export interface RespInterceptorSpec {
  name: string;
  matchLimit?: number;
  fn: RespInterceptorFn;
}

export type Sink<I, R = Buffer> = (input: I) => Promise<R>;

/**
 * Stream transformer used by proxy plugins.
 *
 * One input may call `next` zero or more times. Returned values are the
 * downstream replies produced while handling that input.
 */
export interface Transformer<I, O, R = Buffer> {
  transform(input: I, next: Sink<O, R>): Promise<readonly R[]>;
}

/**
 * Transformer boundary used by installed proxy plugins.
 */
export type BufferTransformer = Transformer<Buffer, Buffer>;

/**
 * Per-connection proxy extension.
 */
export interface ProxyPlugin {
  initialize?(): Promise<void> | void;

  createTransformer(connection: ConnectionInfo): BufferTransformer;

  cleanupConnection?(connectionId: string): void;
}

/**
 * Compose two transformers whose adjacent types match.
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
 * Compose same-boundary transformers from left to right.
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
