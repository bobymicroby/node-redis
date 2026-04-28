/**
 * Client connection data visible to proxy plugins.
 */
export interface ConnectionBase {
  readonly id: string;
  readonly clientAddress: string;
  readonly clientPort: number;
  readonly connectedAt: Date;
}

export interface InterceptorState {
  name: string;
  matchLimit?: number;
  invokeCount: number;
  matchCount: number;
}

export interface ConnectionInfo extends ConnectionBase {
  readonly interceptors: InterceptorState[];
}

/**
 * Continuation passed to public RESP interceptors.
 *
 * Pass RESP bytes to the next interceptor or Redis writer. Resolves with RESP
 * replies.
 */
export type Next = (data: Buffer) => Promise<Buffer>;

/**
 * Public RESP interceptor.
 *
 * Runs after the proxy byte pipeline and before the Redis writer.
 */
export type InterceptorFn = (data: Buffer, next: Next, state: InterceptorState) => Promise<Buffer>;

export interface InterceptorSpec {
  name: string;
  matchLimit?: number;
  fn: InterceptorFn;
}

export type NextStage<O, R> = (output: O) => Promise<R>;

/**
 * Proxy stage.
 *
 * A stage may emit zero or more values and may change the value type. Returned
 * values are the responses produced while handling the input.
 */
export interface Stage<I, O, R = Buffer> {
  write(input: I, next: NextStage<O, R>): Promise<readonly R[]>;
}

/**
 * Composable proxy stage.
 *
 * A stage can change request bytes before `next()` and response bytes after
 * `next()` resolves.
 */
export type PipelineStage = Stage<Buffer, Buffer>;

/**
 * Proxy plugin.
 *
 * Runs before public RESP interceptors.
 */
export interface PipelinePlugin {
  initialize?(): Promise<void> | void;

  createStage(connection: ConnectionInfo): PipelineStage;

  cleanupConnection?(connectionId: string): void;
}

/**
 * Compose two stages whose adjacent types match.
 */
export function composeStages<A, B, C>(
  first: Stage<A, B>,
  second: Stage<B, C>
): Stage<A, C> {
  return {
    write: (input, next) => first.write(input, async (middle) => {
      const responses = await second.write(middle, next);
      return Buffer.concat(responses);
    }),
  };
}

/**
 * Compose same-boundary proxy stages from left to right.
 */
export function composeBufferStages(stages: readonly PipelineStage[]): PipelineStage {
  if (stages.length === 0) {
    return {
      write: async (input, next) => [await next(input)],
    };
  }

  let stage = stages[0];
  for (let i = 1; i < stages.length; i++) {
    stage = composeStages(stage, stages[i]);
  }
  return stage;
}
