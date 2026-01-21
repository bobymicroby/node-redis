import type {
  CommandCodec,
  OutboundCommand,
  OutboundInterceptor,
  InboundInterceptor,
} from '../client/commands-queue';
import type { RedisArgument } from '../RESP/types';
import { EligibilityResolver } from './eligibility-resolver';
import { createDefaultResolver } from './eligibility-static-data';
import { createBinhdrInterceptor } from './interceptor';
import {
  CommandPacker,
  createBufferedCommand,
  type Scheduler,
  type Cancellable,
} from './packing';
import type { ResponseHeader } from './generated/types';

export interface OutboundCodecOptions {
  readonly resolver?: EligibilityResolver | null;
}

export interface InboundCodecOptions {
  readonly onProtocolError?: (requestId: number) => void;
}

export interface TimeBoundedOptions {
  readonly maxWaitMs: number;
  readonly scheduler: Scheduler;
}

export interface CodecOptions extends OutboundCodecOptions, InboundCodecOptions {
  readonly timeBounded?: TimeBoundedOptions;
}

export type FlushSink = (encoded: ReadonlyArray<RedisArgument>) => void;

export interface BinhdrCodec extends CommandCodec {
  setFlushSink(sink: FlushSink): void;
  destroy(): void;
}

interface SchedulerState {
  readonly scheduler: Scheduler;
  readonly maxWaitMs: number;
  pendingFlush: Cancellable | null;
  flushSink: FlushSink | null;
}

function cancelPendingFlush(state: SchedulerState): void {
  if (state.pendingFlush !== null) {
    state.pendingFlush.cancel();
    state.pendingFlush = null;
  }
}

function scheduleFlush(state: SchedulerState, packer: CommandPacker): void {
  if (state.pendingFlush !== null || state.flushSink === null || packer.bufferSize === 0) {
    return;
  }

  state.pendingFlush = state.scheduler.schedule(state.maxWaitMs, () => {
    state.pendingFlush = null;
    const packed = packer.drain();
    if (packed !== null && state.flushSink !== null) {
      state.flushSink(packed);
    }
  });
}

export function createBinhdrOutboundInterceptor(
  getResolver: () => EligibilityResolver | null,
  packer: CommandPacker = new CommandPacker(),
  schedulerState?: SchedulerState
): OutboundInterceptor {
  return {
    process(command: OutboundCommand): OutboundCommand | null {
      const resolver = getResolver();
      if (!resolver) {
        return command;
      }

      const eligibility = resolver.getEligibility(command.args);
      if (!eligibility.eligible) {
        return command;
      }

      const buffered = createBufferedCommand(command.args, command.encoded, eligibility);
      const wasEmpty = packer.bufferSize === 0;
      const packed = packer.add(buffered);

      if (packed !== null) {
        if (schedulerState) {
          cancelPendingFlush(schedulerState);
        }
        return { args: command.args, encoded: packed };
      }

      if (schedulerState && wasEmpty && packer.bufferSize > 0) {
        scheduleFlush(schedulerState, packer);
      }

      return null;
    },

    drain(): OutboundCommand | null {
      if (schedulerState) {
        cancelPendingFlush(schedulerState);
      }

      const packed = packer.drain();
      if (packed === null) {
        return null;
      }
      return { args: [], encoded: packed };
    }
  };
}

export function createBinhdrInboundInterceptor(options: InboundCodecOptions = {}): InboundInterceptor {
  const { onProtocolError } = options;

  return createBinhdrInterceptor({
    onProtocolError: onProtocolError
      ? (header: ResponseHeader) => onProtocolError(header.requestId)
      : undefined,
  });
}

export function createBinhdrCodec(options: CodecOptions = {}): BinhdrCodec {
  const { onProtocolError, timeBounded } = options;

  let resolver: EligibilityResolver | null = null;

  createDefaultResolver()
    .then((r) => { resolver = r; })
    .catch(() => { /* resolver stays null, commands pass through */ });

  const schedulerState: SchedulerState | undefined = timeBounded
    ? {
        scheduler: timeBounded.scheduler,
        maxWaitMs: timeBounded.maxWaitMs,
        pendingFlush: null,
        flushSink: null,
      }
    : undefined;

  const packer = new CommandPacker(timeBounded ? { maxWaitMs: timeBounded.maxWaitMs } : {});
  const outbound = createBinhdrOutboundInterceptor(() => resolver, packer, schedulerState);
  const inbound = createBinhdrInboundInterceptor({ onProtocolError });

  return {
    outbound,
    inbound,

    setFlushSink(sink: FlushSink): void {
      if (schedulerState) {
        schedulerState.flushSink = sink;
      }
    },

    destroy(): void {
      if (schedulerState) {
        cancelPendingFlush(schedulerState);
        schedulerState.flushSink = null;
      }
    },
  };
}
