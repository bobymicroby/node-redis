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

    function makeBuffered(slot: number, payloadLength: number = 100): BufferedCommand {
      return {
        command: ['SET', 'key', 'value'],
        resp: ['x'], // placeholder, we use payloadLength directly
        slot,
        payloadLength,
      };
    }

    it('does not flush empty buffer', () => {
      const incoming = makeBuffered(1000);
      assert.equal(strategy.shouldFlush([], incoming), false);
    });

    it('does not flush when slots are compatible (same slot)', () => {
      const buffer = [makeBuffered(1000)];
      const incoming = makeBuffered(1000);
      assert.equal(strategy.shouldFlush(buffer, incoming), false);
    });

    it('does not flush when incoming is SLOT_NO_SLOT', () => {
      const buffer = [makeBuffered(1000)];
      const incoming = makeBuffered(BINHDR.SLOT_NO_SLOT);
      assert.equal(strategy.shouldFlush(buffer, incoming), false);
    });

    it('does not flush when buffer has SLOT_NO_SLOT and incoming has known slot', () => {
      const buffer = [makeBuffered(BINHDR.SLOT_NO_SLOT)];
      const incoming = makeBuffered(1000);
      assert.equal(strategy.shouldFlush(buffer, incoming), false);
    });

    it('flushes when slots are incompatible', () => {
      const buffer = [makeBuffered(1000)];
      const incoming = makeBuffered(2000);
      assert.equal(strategy.shouldFlush(buffer, incoming), true);
    });

    it('flushes when buffer reaches max commands', () => {
      const buffer: BufferedCommand[] = [];
      for (let i = 0; i < BINHDR.MAX_COMMANDS_PER_PACK; i++) {
        buffer.push(makeBuffered(1000));
      }
      const incoming = makeBuffered(1000);
      assert.equal(strategy.shouldFlush(buffer, incoming), true);
    });

    it('does not flush at max commands - 1', () => {
      const buffer: BufferedCommand[] = [];
      for (let i = 0; i < BINHDR.MAX_COMMANDS_PER_PACK - 1; i++) {
        buffer.push(makeBuffered(1000));
      }
      const incoming = makeBuffered(1000);
      assert.equal(strategy.shouldFlush(buffer, incoming), false);
    });

    it('flushes when payload would exceed max length', () => {
      // Use realistic payload sizes that won't cause string length issues
      const largePayload = 1000000; // 1MB each
      const buffer = [makeBuffered(1000, largePayload)];

      // Create incoming with payload that would exceed max when combined
      const incomingPayload = BINHDR.MAX_PAYLOAD_LENGTH - largePayload + 1;
      const incoming = makeBuffered(1000, incomingPayload);
      assert.equal(strategy.shouldFlush(buffer, incoming), true);
    });
  });

  describe('packCommands', () => {
    function makeBuffered(slot: number, resp: string[]): BufferedCommand {
      return {
        command: ['SET', 'key', 'value'],
        resp,
        slot,
        payloadLength: calculatePayloadLength(resp),
      };
    }

    it('returns null for empty buffer', () => {
      assert.equal(packCommands([]), null);
    });

    it('packs single command', () => {
      const resp = ['*1\r\n$4\r\nPING\r\n'];
      const buffer = [makeBuffered(BINHDR.SLOT_NO_SLOT, resp)];

      const packed = packCommands(buffer, 123);

      assert.ok(packed !== null);
      assert.equal(packed.length, 2); // header + resp
      assert.ok(packed[0] instanceof Buffer);

      // Verify header
      const header = parseRequestHeader(packed[0] as Buffer);
      assert.ok(header.success);
      if (header.success) {
        assert.equal(header.header.commandCount, 1);
        assert.equal(header.header.slot, BINHDR.SLOT_NO_SLOT);
        assert.equal(header.header.clientIdx, 123);
        assert.equal(header.header.length, calculatePayloadLength(resp));
      }
    });

    it('packs multiple commands', () => {
      const resp1 = ['*1\r\n$4\r\nPING\r\n'];
      const resp2 = ['*1\r\n$4\r\nTIME\r\n'];
      const buffer = [
        makeBuffered(BINHDR.SLOT_NO_SLOT, resp1),
        makeBuffered(BINHDR.SLOT_NO_SLOT, resp2),
      ];

      const packed = packCommands(buffer, 0);

      assert.ok(packed !== null);
      assert.equal(packed.length, 3); // header + resp1 + resp2

      const header = parseRequestHeader(packed[0] as Buffer);
      assert.ok(header.success);
      if (header.success) {
        assert.equal(header.header.commandCount, 2);
        assert.equal(header.header.length, calculatePayloadLength(resp1) + calculatePayloadLength(resp2));
      }
    });

    it('uses known slot from buffer', () => {
      const buffer = [
        makeBuffered(BINHDR.SLOT_NO_SLOT, ['*1\r\n$4\r\nPING\r\n']),
        makeBuffered(5000, ['*2\r\n$3\r\nGET\r\n$3\r\nkey\r\n']),
        makeBuffered(BINHDR.SLOT_NO_SLOT, ['*1\r\n$4\r\nTIME\r\n']),
      ];

      const packed = packCommands(buffer, 0);

      assert.ok(packed !== null);
      const header = parseRequestHeader(packed[0] as Buffer);
      assert.ok(header.success);
      if (header.success) {
        assert.equal(header.header.slot, 5000);
      }
    });

    it('uses first known slot when multiple commands have slots', () => {
      const buffer = [
        makeBuffered(5000, ['*2\r\n$3\r\nGET\r\n$3\r\nkey\r\n']),
        makeBuffered(5000, ['*2\r\n$3\r\nGET\r\n$4\r\nkey2\r\n']),
      ];

      const packed = packCommands(buffer, 0);

      assert.ok(packed !== null);
      const header = parseRequestHeader(packed[0] as Buffer);
      assert.ok(header.success);
      if (header.success) {
        assert.equal(header.header.slot, 5000);
      }
    });
  });

  describe('CommandPacker', () => {
    function makeBuffered(slot: number): BufferedCommand {
      const resp = ['*1\r\n$4\r\nPING\r\n'];
      return {
        command: ['PING'],
        resp,
        slot,
        payloadLength: calculatePayloadLength(resp),
      };
    }

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

    it('flush returns packed commands and empties buffer', () => {
      const packer = new CommandPacker();

      packer.add(makeBuffered(1000));
      packer.add(makeBuffered(1000));

      const flushed = packer.flush();

      assert.ok(flushed !== null);
      assert.equal(packer.bufferSize, 0);

      const header = parseRequestHeader(flushed![0] as Buffer);
      assert.ok(header.success);
      if (header.success) {
        assert.equal(header.header.commandCount, 2);
      }
    });

    it('flush returns null when buffer is empty', () => {
      const packer = new CommandPacker();
      assert.equal(packer.flush(), null);
    });

    it('uses custom strategy', () => {
      // Strategy that flushes after every 2 commands (flush before adding 3rd)
      const customStrategy: PackingStrategy = {
        shouldFlush(buffer) {
          return buffer.length >= 2;
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
