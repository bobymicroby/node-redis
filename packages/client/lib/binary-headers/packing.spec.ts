import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  CommandPacker,
  createDefaultPackingStrategy,
  createBufferedCommand,
  calculatePayloadLength,
  packCommands,
  type BufferedCommand,
  type PackingStrategy,
} from './packing';
import { BINHDR } from './constants';
import { parseRequestHeader } from './decoder';
import type { EligibilityResult } from './eligibility-types';

// Shared test helper for creating buffered commands
function makeBuffered(
  slot: number,
  resp: string[] = ['*1\r\n$4\r\nPING\r\n'],
  command: string[] = ['PING']
): BufferedCommand {
  return {
    command,
    resp,
    slot,
    payloadLength: calculatePayloadLength(resp),
  };
}

describe('Packing', () => {
  describe('calculatePayloadLength', () => {
    it('calculates length for string parts', () => {
      const resp = ['*1\r\n$4\r\nPING\r\n'];
      assert.equal(calculatePayloadLength(resp), 14);
    });

    it('calculates length for buffer parts', () => {
      const resp = [Buffer.from('*1\r\n$4\r\nPING\r\n')];
      assert.equal(calculatePayloadLength(resp), 14);
    });

    it('calculates length for mixed string and buffer parts', () => {
      const resp = ['*3\r\n$3\r\nSET\r\n$3\r\n', Buffer.from('key'), '\r\n$5\r\nvalue\r\n'];
      // 18 bytes + 3 bytes + 12 bytes = 33 bytes
      const expected = Buffer.byteLength('*3\r\n$3\r\nSET\r\n$3\r\n') + 3 + Buffer.byteLength('\r\n$5\r\nvalue\r\n');
      assert.equal(calculatePayloadLength(resp), expected);
    });

    it('returns 0 for empty array', () => {
      assert.equal(calculatePayloadLength([]), 0);
    });
  });

  describe('createBufferedCommand', () => {
    it('creates buffered command with provided slot for eligible command', () => {
      const command = ['SET', 'key', 'value'];
      const resp = ['*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$5\r\nvalue\r\n'];
      const eligibility: EligibilityResult = { eligible: true, slot: 5000 };

      const buffered = createBufferedCommand(command, resp, eligibility);

      assert.deepEqual(buffered.command, command);
      assert.deepEqual(buffered.resp, resp);
      assert.equal(buffered.slot, 5000);
      assert.equal(buffered.payloadLength, calculatePayloadLength(resp));
    });

    it('creates buffered command with SLOT_NO_SLOT for keyless command', () => {
      const command = ['PING'];
      const resp = ['*1\r\n$4\r\nPING\r\n'];
      const eligibility: EligibilityResult = { eligible: true, slot: BINHDR.SLOT_NO_SLOT };

      const buffered = createBufferedCommand(command, resp, eligibility);

      assert.equal(buffered.slot, BINHDR.SLOT_NO_SLOT);
    });
  });

  describe('createDefaultPackingStrategy', () => {
    const strategy = createDefaultPackingStrategy();

    it('can add when slots are compatible (same slot)', () => {
      const incoming = makeBuffered(1000);
      assert.equal(strategy.canAdd(1, 1000, 14, incoming), true);
    });

    it('can add when incoming is SLOT_NO_SLOT', () => {
      const incoming = makeBuffered(BINHDR.SLOT_NO_SLOT);
      assert.equal(strategy.canAdd(1, 1000, 14, incoming), true);
    });

    it('can add when current slot is SLOT_NO_SLOT and incoming has known slot', () => {
      const incoming = makeBuffered(1000);
      assert.equal(strategy.canAdd(1, BINHDR.SLOT_NO_SLOT, 14, incoming), true);
    });

    it('cannot add when slots are incompatible', () => {
      const incoming = makeBuffered(2000);
      assert.equal(strategy.canAdd(1, 1000, 14, incoming), false);
    });

    it('cannot add when count reaches max commands', () => {
      const incoming = makeBuffered(1000);
      assert.equal(strategy.canAdd(BINHDR.MAX_COMMANDS_PER_PACK, 1000, 14, incoming), false);
    });

    it('can add at max commands - 1', () => {
      const incoming = makeBuffered(1000);
      assert.equal(strategy.canAdd(BINHDR.MAX_COMMANDS_PER_PACK - 1, 1000, 14, incoming), true);
    });

    it('cannot add when payload would exceed max length', () => {
      const largePayload = 1000000; // 1MB
      const incomingPayload = BINHDR.MAX_PAYLOAD_LENGTH - largePayload + 1;
      const incoming = { ...makeBuffered(1000), payloadLength: incomingPayload };
      assert.equal(strategy.canAdd(1, 1000, largePayload, incoming), false);
    });
  });

  describe('packCommands', () => {
    it('returns null for empty buffer', () => {
      assert.equal(packCommands([], BINHDR.SLOT_NO_SLOT, 0), null);
    });

    it('packs single command', () => {
      const pingResp = ['*1\r\n$4\r\nPING\r\n'];
      const buffer = [makeBuffered(BINHDR.SLOT_NO_SLOT, pingResp)];
      const totalPayload = calculatePayloadLength(pingResp);

      const packed = packCommands(buffer, BINHDR.SLOT_NO_SLOT, totalPayload, 123);

      assert.ok(packed !== null);
      assert.equal(packed.length, 2); // header + resp
      assert.ok(packed[0] instanceof Buffer);

      const header = parseRequestHeader(packed[0] as Buffer);
      assert.ok(header.success);
      if (header.success) {
        assert.equal(header.header.commandCount, 1);
        assert.equal(header.header.slot, BINHDR.SLOT_NO_SLOT);
        assert.equal(header.header.clientIdx, 123);
        assert.equal(header.header.length, totalPayload);
      }
    });

    it('packs multiple commands', () => {
      const pingResp = ['*1\r\n$4\r\nPING\r\n'];
      const timeResp = ['*1\r\n$4\r\nTIME\r\n'];
      const buffer = [
        makeBuffered(BINHDR.SLOT_NO_SLOT, pingResp),
        makeBuffered(BINHDR.SLOT_NO_SLOT, timeResp),
      ];
      const totalPayload = calculatePayloadLength(pingResp) + calculatePayloadLength(timeResp);

      const packed = packCommands(buffer, BINHDR.SLOT_NO_SLOT, totalPayload, 0);

      assert.ok(packed !== null);
      assert.equal(packed.length, 3); // header + 2 payloads

      const header = parseRequestHeader(packed[0] as Buffer);
      assert.ok(header.success);
      if (header.success) {
        assert.equal(header.header.commandCount, 2);
        assert.equal(header.header.length, totalPayload);
      }
    });

    it('uses provided slot', () => {
      const buffer = [
        makeBuffered(BINHDR.SLOT_NO_SLOT, ['*1\r\n$4\r\nPING\r\n']),
        makeBuffered(5000, ['*2\r\n$3\r\nGET\r\n$3\r\nkey\r\n'], ['GET', 'key']),
        makeBuffered(BINHDR.SLOT_NO_SLOT, ['*1\r\n$4\r\nTIME\r\n'], ['TIME']),
      ];
      const totalPayload = buffer.reduce((sum, b) => sum + b.payloadLength, 0);

      const packed = packCommands(buffer, 5000, totalPayload, 0);

      assert.ok(packed !== null);
      const header = parseRequestHeader(packed[0] as Buffer);
      assert.ok(header.success);
      if (header.success) {
        assert.equal(header.header.slot, 5000);
      }
    });
  });

  describe('CommandPacker', () => {
    it('buffers first command and returns null', () => {
      const packer = new CommandPacker();
      const result = packer.add(makeBuffered(1000));

      assert.equal(result, null);
      assert.equal(packer.bufferSize, 1);
    });

    it('buffers compatible commands', () => {
      const packer = new CommandPacker();

      assert.equal(packer.add(makeBuffered(1000)), null);
      assert.equal(packer.add(makeBuffered(1000)), null);
      assert.equal(packer.add(makeBuffered(BINHDR.SLOT_NO_SLOT)), null);

      assert.equal(packer.bufferSize, 3);
    });

    it('flushes on incompatible slot and returns packed frame', () => {
      const packer = new CommandPacker();

      packer.add(makeBuffered(1000));
      packer.add(makeBuffered(1000));
      const flushed = packer.add(makeBuffered(2000));

      assert.ok(flushed !== null);
      assert.equal(packer.bufferSize, 1); // new command is buffered

      // Verify flushed contains 2 commands
      const header = parseRequestHeader(flushed![0] as Buffer);
      assert.ok(header.success);
      if (header.success) {
        assert.equal(header.header.commandCount, 2);
        assert.equal(header.header.slot, 1000);
      }
    });

    it('drain returns packed commands and empties buffer', () => {
      const packer = new CommandPacker();

      packer.add(makeBuffered(1000));
      packer.add(makeBuffered(1000));

      const drained = packer.drain();

      assert.ok(drained !== null);
      assert.equal(packer.bufferSize, 0);

      const header = parseRequestHeader(drained![0] as Buffer);
      assert.ok(header.success);
      if (header.success) {
        assert.equal(header.header.commandCount, 2);
      }
    });

    it('drain returns null when buffer is empty', () => {
      const packer = new CommandPacker();
      assert.equal(packer.drain(), null);
    });

    it('uses custom strategy', () => {
      // Strategy that allows max 2 commands (cannot add when count >= 2)
      const customStrategy: PackingStrategy = {
        canAdd(count) {
          return count < 2;
        },
      };

      const packer = new CommandPacker(customStrategy);

      assert.equal(packer.add(makeBuffered(1000)), null); // 1st command buffered
      assert.equal(packer.add(makeBuffered(1000)), null); // 2nd command buffered
      const flushed = packer.add(makeBuffered(1000)); // 3rd triggers flush

      assert.ok(flushed !== null);
      assert.equal(packer.bufferSize, 1);
    });

    it('handles max commands flush', () => {
      const packer = new CommandPacker();

      // Add MAX_COMMANDS_PER_PACK commands
      for (let i = 0; i < BINHDR.MAX_COMMANDS_PER_PACK; i++) {
        packer.add(makeBuffered(1000));
      }

      assert.equal(packer.bufferSize, BINHDR.MAX_COMMANDS_PER_PACK);

      // Adding one more should flush
      const flushed = packer.add(makeBuffered(1000));

      assert.ok(flushed !== null);
      assert.equal(packer.bufferSize, 1);

      const header = parseRequestHeader(flushed![0] as Buffer);
      assert.ok(header.success);
      if (header.success) {
        assert.equal(header.header.commandCount, BINHDR.MAX_COMMANDS_PER_PACK);
      }
    });
  });
});
