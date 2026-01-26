/**
 * Binary Headers Codec Implementation
 *
 * Standalone codec that can be passed to RedisCommandsQueue.
 */

import type { RedisArgument } from '../RESP/types';
import type { Decoder } from '../RESP/decoder';
import type { OutboundCodec, InboundCodec, CommandCodec } from './codec-queue';
import type { EligibilityResolver } from './eligibility-resolver';
import { SLOT_INELIGIBLE, NOOP_RESOLVER } from './eligibility-resolver';
import { CommandPacker, calculatePayloadLength } from './packing';
import { BinhdrInboundDecoder } from './interceptor';

// ============================================================================
// Options
// ============================================================================

export interface BinaryHeadersOutboundOptions {
  readonly resolver?: EligibilityResolver;
  readonly maxWaitMs?: number;
}

export interface BinaryHeadersInboundOptions {
  readonly onProtocolError?: (requestId: number) => void;
}

export interface BinaryHeadersCodecOptions {
  readonly outbound?: BinaryHeadersOutboundOptions;
  readonly inbound?: BinaryHeadersInboundOptions;
}

// ============================================================================
// Outbound Codec
// ============================================================================

export class BinaryHeadersOutboundCodec implements OutboundCodec {
  readonly #resolver: EligibilityResolver;
  readonly #packer: CommandPacker;

  constructor(options: BinaryHeadersOutboundOptions = {}) {
    this.#resolver = options.resolver ?? NOOP_RESOLVER;
    this.#packer = new CommandPacker(options.maxWaitMs ?? null);
  }

  transform(
    encoded: ReadonlyArray<RedisArgument>,
    args: ReadonlyArray<RedisArgument>
  ): ReadonlyArray<RedisArgument> | null {
    const slot = this.#resolver.getSlot(args);

    // Ineligible commands pass through unchanged
    if (slot === SLOT_INELIGIBLE) {
      return encoded;
    }

    // Try to add to batch
    return this.#packer.add(encoded, slot, calculatePayloadLength(encoded));
  }

  drain(): ReadonlyArray<RedisArgument> | null {
    return this.#packer.drain();
  }

  hasPending(): boolean {
    return this.#packer.bufferSize > 0;
  }
}

// ============================================================================
// Inbound Codec
// ============================================================================

export class BinaryHeadersInboundCodec implements InboundCodec {
  readonly #decoder: BinhdrInboundDecoder;

  constructor(options: BinaryHeadersInboundOptions = {}) {
    this.#decoder = new BinhdrInboundDecoder({
      onProtocolError: options.onProtocolError !== undefined
        ? header => options.onProtocolError!(header.requestId)
        : undefined
    });
  }

  process(chunk: Buffer, decoder: Decoder): void {
    this.#decoder.writeToDecoder(chunk, decoder);
  }
}

// ============================================================================
// Combined Codec
// ============================================================================

export class BinaryHeadersCodec implements CommandCodec {
  readonly outbound: BinaryHeadersOutboundCodec;
  readonly inbound: BinaryHeadersInboundCodec;

  constructor(options: BinaryHeadersCodecOptions = {}) {
    this.outbound = new BinaryHeadersOutboundCodec(options.outbound);
    this.inbound = new BinaryHeadersInboundCodec(options.inbound);
  }
}

export function createBinaryHeadersCodec(options: BinaryHeadersCodecOptions = {}): BinaryHeadersCodec {
  return new BinaryHeadersCodec(options);
}
