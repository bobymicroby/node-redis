import RedisCommandsQueue, { CommandOptions, CommandsQueueOptions } from '../client/commands-queue';
import { ChannelListeners, PubSubType, PubSubListener, PubSubTypeListeners } from '../client/pub-sub';
import { MonitorCallback } from '../client';
import { TypeMapping, RedisArgument } from '../RESP/types';
import { BinhdrStateMachine } from './state';
import { packSingleCommand, calculateSlotFromKeys } from './packing';

export interface BinhdrCommandsQueueOptions extends CommandsQueueOptions {
  binhdrStateMachine: BinhdrStateMachine;
  getKeys?: (args: ReadonlyArray<RedisArgument>) => ReadonlyArray<RedisArgument>;
}

/**
 * A commands queue wrapper that adds binary header packing for eligible commands.
 * Uses composition to wrap the original RedisCommandsQueue.
 */
export class BinhdrCommandsQueue {
  readonly #inner: RedisCommandsQueue;
  readonly #binhdrStateMachine: BinhdrStateMachine;
  readonly #getKeys: (args: ReadonlyArray<RedisArgument>) => ReadonlyArray<RedisArgument>;

  constructor(options: BinhdrCommandsQueueOptions) {
    this.#inner = new RedisCommandsQueue(options);
    this.#binhdrStateMachine = options.binhdrStateMachine;
    this.#getKeys = options.getKeys ?? (() => []);
  }

  // Expose decoder for socket data handling
  get decoder() {
    return this.#inner.decoder;
  }

  get isPubSubActive() {
    return this.#inner.isPubSubActive;
  }

  // Delegate methods to inner queue
  setMaintenanceCommandTimeout(ms: number | undefined) {
    return this.#inner.setMaintenanceCommandTimeout(ms);
  }

  addPushHandler(handler: (pushItems: Array<any>) => boolean) {
    return this.#inner.addPushHandler(handler);
  }

  waitForInflightCommandsToComplete() {
    return this.#inner.waitForInflightCommandsToComplete();
  }

  addCommand<T>(args: ReadonlyArray<RedisArgument>, options?: CommandOptions) {
    return this.#inner.addCommand<T>(args, options);
  }

  subscribe<T extends boolean>(
    type: PubSubType,
    channels: string | Array<string>,
    listener: PubSubListener<T>,
    returnBuffers?: T
  ) {
    return this.#inner.subscribe(type, channels, listener, returnBuffers);
  }

  unsubscribe<T extends boolean>(
    type: PubSubType,
    channels?: string | Array<string>,
    listener?: PubSubListener<T>,
    returnBuffers?: T
  ) {
    return this.#inner.unsubscribe(type, channels, listener, returnBuffers);
  }

  removeAllPubSubListeners() {
    return this.#inner.removeAllPubSubListeners();
  }

  resubscribe(chainId?: symbol) {
    return this.#inner.resubscribe(chainId);
  }

  extendPubSubChannelListeners(
    type: PubSubType,
    channel: string,
    listeners: ChannelListeners
  ) {
    return this.#inner.extendPubSubChannelListeners(type, channel, listeners);
  }

  extendPubSubListeners(type: PubSubType, listeners: PubSubTypeListeners) {
    return this.#inner.extendPubSubListeners(type, listeners);
  }

  getPubSubListeners(type: PubSubType) {
    return this.#inner.getPubSubListeners(type);
  }

  monitor(callback: MonitorCallback, options?: CommandOptions) {
    return this.#inner.monitor(callback, options);
  }

  resetDecoder() {
    return this.#inner.resetDecoder();
  }

  reset<T extends TypeMapping>(chainId: symbol, typeMapping?: T) {
    return this.#inner.reset(chainId, typeMapping);
  }

  isWaitingToWrite() {
    return this.#inner.isWaitingToWrite();
  }

  flushWaitingForReply(err: Error) {
    return this.#inner.flushWaitingForReply(err);
  }

  flushAll(err: Error) {
    return this.#inner.flushAll(err);
  }

  isEmpty() {
    return this.#inner.isEmpty();
  }

  /**
   * Override commandsToWrite to add binary header packing for eligible commands.
   * Falls back to normal RESP encoding for ineligible commands.
   */
  *commandsToWrite(): Generator<ReadonlyArray<RedisArgument>> {
    const state = this.#binhdrStateMachine.getState();

    // If binary headers are not enabled, delegate to inner queue
    if (state.state !== 'enabled') {
      yield* this.#inner.commandsToWrite();
      return;
    }

    const resolver = state.resolver;

    // Get commands from inner queue and potentially wrap with binary headers
    for (const encoded of this.#inner.commandsToWrite()) {
      // Check eligibility using the resolver
      const eligibility = resolver.resolveEligibility(encoded);

      // Command is eligible if resolution succeeded and binhdrFlag is true
      if (eligibility.ok && eligibility.value.binhdrFlag) {
        // Get keys for slot calculation
        const keys = this.#getKeys(encoded);
        const slot = calculateSlotFromKeys(keys);

        // Pack with binary header
        const result = packSingleCommand(encoded, slot);
        if (result.success) {
          yield result.packed;
        } else {
          // Packing failed, fall back to normal RESP
          yield encoded;
        }
      } else {
        // Not eligible, yield as-is
        yield encoded;
      }
    }
  }
}
