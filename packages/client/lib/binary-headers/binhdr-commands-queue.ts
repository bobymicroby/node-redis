import RedisCommandsQueue, {
  OnShardedChannelMoved,
} from '../client/commands-queue';
import type { RedisArgument, RespVersions } from '../RESP/types';
import type { EligibilityResolver } from './eligibility-resolver';
import { SLOT_INELIGIBLE, NOOP_RESOLVER } from './eligibility-resolver';
import { CommandPacker, calculatePayloadLength } from './packing';
import { BinhdrInboundDecoder } from './interceptor';
import type { Cancellable, Scheduler } from './packing';

export type TimerFlushCallback = (encoded: ReadonlyArray<RedisArgument>) => void;

const NOOP_FLUSH_CALLBACK: TimerFlushCallback = () => {};

export interface BinhdrQueueOptions {
  readonly resolver?: EligibilityResolver;
  readonly onProtocolError?: (requestId: number) => void;
  readonly timeBounded?: {
    readonly maxWaitMs: number;
    readonly scheduler: Scheduler;
  };
}

export default class BinhdrCommandsQueue extends RedisCommandsQueue {
  readonly #resolver: EligibilityResolver;
  readonly #packer: CommandPacker;
  readonly #inboundDecoder: BinhdrInboundDecoder;
  readonly #scheduler: Scheduler | null;
  readonly #maxWaitMs: number;
  #pendingFlush: Cancellable | null = null;
  #timerFlushCallback: TimerFlushCallback = NOOP_FLUSH_CALLBACK;

  constructor(
    respVersion: RespVersions,
    maxLength: number | null | undefined,
    onShardedChannelMoved: OnShardedChannelMoved,
    options: BinhdrQueueOptions = {}
  ) {
    super(respVersion, maxLength, onShardedChannelMoved);

    const { resolver = NOOP_RESOLVER, onProtocolError, timeBounded } = options;

    this.#resolver = resolver;
    this.#packer = new CommandPacker(timeBounded?.maxWaitMs ?? null);
    this.#inboundDecoder = new BinhdrInboundDecoder({
      onProtocolError: onProtocolError !== undefined
        ? header => onProtocolError(header.requestId)
        : undefined
    });
    this.#scheduler = timeBounded?.scheduler ?? null;
    this.#maxWaitMs = timeBounded?.maxWaitMs ?? 0;
  }

  setTimerFlushCallback(callback: TimerFlushCallback): void {
    this.#timerFlushCallback = callback;
  }

  get maxWaitMs(): number {
    return this.#maxWaitMs;
  }

  destroy(): void {
    this.#cancelPendingFlush();
    this.#timerFlushCallback = NOOP_FLUSH_CALLBACK;
  }

  protected override transformOutbound(
    encoded: ReadonlyArray<RedisArgument>,
    args: ReadonlyArray<RedisArgument>
  ): ReadonlyArray<RedisArgument> | null {
    const slot = this.#resolver.getSlot(args);

    if (slot === SLOT_INELIGIBLE) {
      this.#cancelPendingFlush();
      return encoded;
    }

    const wasEmpty = this.#packer.bufferSize === 0;
    const packed = this.#packer.add(encoded, slot, calculatePayloadLength(encoded));

    if (packed !== null) {
      this.#cancelPendingFlush();
      return packed;
    }

    if (this.#scheduler !== null && wasEmpty && this.#packer.bufferSize > 0) {
      this.#scheduleFlush();
    }

    return null;
  }

  protected override drainOutbound(): ReadonlyArray<RedisArgument> | null {
    this.#cancelPendingFlush();
    return this.#packer.drain();
  }

  override processIncomingData(chunk: Buffer): void {
    this.#inboundDecoder.writeToDecoder(chunk, this.decoder);
  }

  #scheduleFlush(): void {
    if (this.#pendingFlush !== null || this.#scheduler === null) {
      return;
    }

    this.#pendingFlush = this.#scheduler.schedule(this.#maxWaitMs, () => {
      this.#pendingFlush = null;
      const packed = this.#packer.drain();
      if (packed !== null) {
        this.#timerFlushCallback(packed);
      }
    });
  }

  #cancelPendingFlush(): void {
    if (this.#pendingFlush !== null) {
      this.#pendingFlush.cancel();
      this.#pendingFlush = null;
    }
  }
}
