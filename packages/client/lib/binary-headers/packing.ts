import type { RedisArgument } from '../RESP/types';
import type { EligibilityResult } from './eligibility-types';
import { BINHDR } from './generated/constants';
import { createRequestHeader, encodeRequestHeader } from './generated/encoder';

/**
 * Represents a single command ready for packing.
 * Contains both the original command and its RESP-encoded form.
 */
export interface BufferedCommand {
  readonly command: ReadonlyArray<RedisArgument>;
  readonly resp: ReadonlyArray<RedisArgument>;
  readonly slot: number;
  readonly payloadLength: number;
}

/**
 * Represents the accumulated state of commands currently buffered in a pack.
 * This is separate from individual commands - it tracks totals across all buffered commands.
 */
export interface PackState {
  /** Number of commands currently in the pack */
  readonly commandCount: number;
  /** The resolved slot for the pack (first non-NO_SLOT seen, or NO_SLOT if all commands are slotless) */
  readonly resolvedSlot: number;
  /** Total payload length in bytes of all commands in the pack */
  readonly totalPayloadLength: number;
}

/**
 * Strategy interface for deciding when to flush a pack and start a new one.
 *
 * Called only when the buffer already contains at least one command.
 * The first command always goes into an empty buffer without consulting the strategy.
 */
export interface PackingStrategy {
  /**
   * Determines whether an incoming command can be added to the current pack.
   *
   * @param currentPack - The accumulated state of commands already in the pack
   * @param incoming - The command being considered for addition
   * @returns true if the command fits in the current pack, false to trigger a flush first
   */
  canAdd(currentPack: PackState, incoming: BufferedCommand): boolean;
}

/**
 * Creates the default packing strategy that enforces binary header protocol limits:
 * - Maximum commands per pack (127)
 * - Slot compatibility (all keyed commands must target the same slot)
 * - Maximum payload length
 */
export function createDefaultPackingStrategy(): PackingStrategy {
  return {
    canAdd(currentPack: PackState, incoming: BufferedCommand): boolean {
      if (currentPack.commandCount >= BINHDR.MAX_COMMANDS_PER_PACK) return false;
      if (!areSlotsCompatible(currentPack.resolvedSlot, incoming.slot)) return false;
      if (currentPack.totalPayloadLength + incoming.payloadLength > BINHDR.MAX_PAYLOAD_LENGTH) return false;
      return true;
    }
  };
}

/**
 * Calculates the byte length of a RESP-encoded command.
 */
export function calculatePayloadLength(resp: ReadonlyArray<RedisArgument>): number {
  let length = 0;
  for (let i = 0; i < resp.length; i++) {
    const part = resp[i];
    length += typeof part === 'string' ? Buffer.byteLength(part) : part.length;
  }
  return length;
}

/**
 * Checks if two slots can coexist in the same pack.
 * NO_SLOT is compatible with any slot (slotless commands can be packed with keyed commands).
 */
function areSlotsCompatible(slotA: number, slotB: number): boolean {
  if (slotA === BINHDR.SLOT_NO_SLOT || slotB === BINHDR.SLOT_NO_SLOT) return true;
  return slotA === slotB;
}

/**
 * Creates a BufferedCommand from raw command data and eligibility result.
 */
export function createBufferedCommand(
  command: ReadonlyArray<RedisArgument>,
  resp: ReadonlyArray<RedisArgument>,
  eligibility: EligibilityResult & { eligible: true }
): BufferedCommand {
  return {
    command,
    resp,
    slot: eligibility.slot,
    payloadLength: calculatePayloadLength(resp),
  };
}

/**
 * Converts SLOT_NO_SLOT sentinel to wire-valid slot value (0).
 */
function toWireSlot(slot: number): number {
  return slot === BINHDR.SLOT_NO_SLOT ? 0 : slot;
}

/**
 * Packs multiple buffered commands into a single binary header frame.
 *
 * @param buffer - Commands to pack
 * @param slot - Resolved slot for the pack
 * @param totalPayload - Pre-calculated total payload length
 * @param requestId - Correlation ID for request-response tracking
 * @returns Packed frame as array of arguments, or null if buffer is empty or header creation fails
 */
export function packCommands(
  buffer: ReadonlyArray<BufferedCommand>,
  slot: number,
  totalPayload: number,
  requestId: number = 0
): ReadonlyArray<RedisArgument> | null {
  if (buffer.length === 0) return null;

  const wireSlot = toWireSlot(slot);
  const headerResult = createRequestHeader(wireSlot, totalPayload, buffer.length, requestId);

  if (!headerResult.success) return null;

  const headerBuffer = encodeRequestHeader(headerResult.header);

  let totalParts = 1;
  for (let i = 0; i < buffer.length; i++) {
    totalParts += buffer[i].resp.length;
  }

  const result = new Array<RedisArgument>(totalParts);
  result[0] = headerBuffer;

  let idx = 1;
  for (let i = 0; i < buffer.length; i++) {
    const resp = buffer[i].resp;
    for (let j = 0; j < resp.length; j++) {
      result[idx++] = resp[j];
    }
  }

  return result;
}

/**
 * Buffers commands and packs them into binary header frames.
 *
 * Slot resolution: the pack's slot is the first non-NO_SLOT value seen.
 * Commands with incompatible slots trigger a flush before buffering.
 */
export class CommandPacker {
  readonly #strategy: PackingStrategy;
  readonly #buffer: BufferedCommand[] = [];
  #resolvedSlot: number = BINHDR.SLOT_NO_SLOT;
  #totalPayloadLength: number = 0;

  constructor(strategy: PackingStrategy = createDefaultPackingStrategy()) {
    this.#strategy = strategy;
  }

  /**
   * Attempts to add a command to the current pack.
   *
   * @returns Packed frame if the command triggered a flush, null otherwise
   */
  add(command: BufferedCommand): ReadonlyArray<RedisArgument> | null {
    const currentPack = this.#getCurrentPackState();

    if (currentPack.commandCount > 0 && !this.#strategy.canAdd(currentPack, command)) {
      const packed = this.#flush();
      this.#push(command);
      return packed;
    }

    this.#push(command);
    return null;
  }

  /**
   * Returns a snapshot of the current pack's accumulated state.
   */
  #getCurrentPackState(): PackState {
    return {
      commandCount: this.#buffer.length,
      resolvedSlot: this.#resolvedSlot,
      totalPayloadLength: this.#totalPayloadLength,
    };
  }

  /**
   * Adds a command to the buffer and updates accumulated state.
   * First keyed command determines the pack's slot.
   */
  #push(command: BufferedCommand): void {
    this.#buffer.push(command);
    this.#totalPayloadLength += command.payloadLength;
    if (command.slot !== BINHDR.SLOT_NO_SLOT) {
      this.#resolvedSlot = command.slot;
    }
  }

  #flush(): ReadonlyArray<RedisArgument> | null {
    const packed = packCommands(this.#buffer, this.#resolvedSlot, this.#totalPayloadLength);
    this.#buffer.length = 0;
    this.#resolvedSlot = BINHDR.SLOT_NO_SLOT;
    this.#totalPayloadLength = 0;
    return packed;
  }

  /**
   * Flushes any remaining buffered commands.
   *
   * @returns Packed frame if there were buffered commands, null otherwise
   */
  drain(): ReadonlyArray<RedisArgument> | null {
    if (this.#buffer.length === 0) return null;
    return this.#flush();
  }

  get bufferSize(): number {
    return this.#buffer.length;
  }
}
