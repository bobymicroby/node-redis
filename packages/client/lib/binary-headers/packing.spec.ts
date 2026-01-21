import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  CommandPacker,
  createDefaultPackingStrategy,
  createTimeBoundedPackingStrategy,
  createTimeoutScheduler,
  createImmediateScheduler,
  createBufferedCommand,
  calculatePayloadLength,
  packCommands,
  type BufferedCommand,
  type PackingStrategy,
  type PackState,
} from './packing';
import { BINHDR } from './generated/constants';
import { parseRequestHeader } from './generated/decoder';
import type { EligibilityResult } from './eligibility-types';

// =============================================================================
// Test Helpers
// =============================================================================

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

function makePackState(
  commandCount: number,
  resolvedSlot: number,
  totalPayloadLength: number,
  bufferStartTime: number | null = null
): PackState {
  return { commandCount, resolvedSlot, totalPayloadLength, bufferStartTime };
}

function assertPackedHeader(
  packed: ReadonlyArray<unknown> | null,
  expected: { commandCount?: number; slot?: number; requestId?: number }
): void {
  assert.ok(packed !== null, 'Expected packed data to be non-null');
  assert.ok(packed[0] instanceof Buffer, 'Expected first element to be a Buffer');

  const header = parseRequestHeader(packed[0] as Buffer);
  assert.ok(header.success, 'Expected header parsing to succeed');

  if (header.success) {
    if (expected.commandCount !== undefined) {
      assert.equal(header.header.commandCount, expected.commandCount);
    }
    if (expected.slot !== undefined) {
      assert.equal(header.header.slot, expected.slot);
    }
    if (expected.requestId !== undefined) {
      assert.equal(header.header.requestId, expected.requestId);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// Tests
// =============================================================================

describe('Packing', () => {
  describe('calculatePayloadLength', () => {
    const tests = [
      { name: 'string parts', resp: ['*1\r\n$4\r\nPING\r\n'], expected: 14 },
      { name: 'buffer parts', resp: [Buffer.from('*1\r\n$4\r\nPING\r\n')], expected: 14 },
      { name: 'empty array', resp: [] as string[], expected: 0 },
    ];

    for (const tt of tests) {
      it(tt.name, () => {
        assert.equal(calculatePayloadLength(tt.resp), tt.expected);
      });
    }

    it('mixed string and buffer parts', () => {
      const resp = ['*3\r\n$3\r\nSET\r\n$3\r\n', Buffer.from('key'), '\r\n$5\r\nvalue\r\n'];
      const expected = Buffer.byteLength('*3\r\n$3\r\nSET\r\n$3\r\n') + 3 + Buffer.byteLength('\r\n$5\r\nvalue\r\n');
      assert.equal(calculatePayloadLength(resp), expected);
    });
  });

  describe('createBufferedCommand', () => {
    const tests = [
      {
        name: 'with slot for eligible command',
        command: ['SET', 'key', 'value'],
        resp: ['*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$5\r\nvalue\r\n'],
        eligibility: { eligible: true as const, slot: 5000 },
        expectedSlot: 5000,
      },
      {
        name: 'with SLOT_NO_SLOT for keyless command',
        command: ['PING'],
        resp: ['*1\r\n$4\r\nPING\r\n'],
        eligibility: { eligible: true as const, slot: BINHDR.SLOT_NO_SLOT },
        expectedSlot: BINHDR.SLOT_NO_SLOT,
      },
    ];

    for (const tt of tests) {
      it(tt.name, () => {
        const buffered = createBufferedCommand(tt.command, tt.resp, tt.eligibility);
        assert.deepEqual(buffered.command, tt.command);
        assert.deepEqual(buffered.resp, tt.resp);
        assert.equal(buffered.slot, tt.expectedSlot);
        assert.equal(buffered.payloadLength, calculatePayloadLength(tt.resp));
      });
    }
  });

  describe('createDefaultPackingStrategy', () => {
    const strategy = createDefaultPackingStrategy();

    const tests = [
      {
        name: 'can add when slots are compatible (same slot)',
        packState: makePackState(1, 1000, 14),
        incoming: makeBuffered(1000),
        expected: true,
      },
      {
        name: 'can add when incoming is SLOT_NO_SLOT',
        packState: makePackState(1, 1000, 14),
        incoming: makeBuffered(BINHDR.SLOT_NO_SLOT),
        expected: true,
      },
      {
        name: 'can add when current slot is SLOT_NO_SLOT',
        packState: makePackState(1, BINHDR.SLOT_NO_SLOT, 14),
        incoming: makeBuffered(1000),
        expected: true,
      },
      {
        name: 'cannot add when slots are incompatible',
        packState: makePackState(1, 1000, 14),
        incoming: makeBuffered(2000),
        expected: false,
      },
      {
        name: 'cannot add when count reaches max commands',
        packState: makePackState(BINHDR.MAX_COMMANDS_PER_PACK, 1000, 14),
        incoming: makeBuffered(1000),
        expected: false,
      },
      {
        name: 'can add at max commands - 1',
        packState: makePackState(BINHDR.MAX_COMMANDS_PER_PACK - 1, 1000, 14),
        incoming: makeBuffered(1000),
        expected: true,
      },
    ];

    for (const tt of tests) {
      it(tt.name, () => {
        assert.equal(strategy.canAdd(tt.packState, tt.incoming), tt.expected);
      });
    }

    it('cannot add when payload would exceed max length', () => {
      const largePayload = 1000000;
      const incomingPayload = BINHDR.MAX_PAYLOAD_LENGTH - largePayload + 1;
      const incoming = { ...makeBuffered(1000), payloadLength: incomingPayload };
      assert.equal(strategy.canAdd(makePackState(1, 1000, largePayload), incoming), false);
    });
  });

  describe('createTimeBoundedPackingStrategy', () => {
    const strategy = createTimeBoundedPackingStrategy(100);

    it('allows add when buffer is not stale', () => {
      const now = performance.now();
      const packState = makePackState(1, 1000, 14, now - 50); // 50ms ago
      assert.equal(strategy.canAdd(packState, makeBuffered(1000)), true);
    });

    it('denies add when buffer is stale', () => {
      const now = performance.now();
      const packState = makePackState(1, 1000, 14, now - 150); // 150ms ago
      assert.equal(strategy.canAdd(packState, makeBuffered(1000)), false);
    });

    it('allows add when bufferStartTime is null', () => {
      const packState = makePackState(1, 1000, 14, null);
      assert.equal(strategy.canAdd(packState, makeBuffered(1000)), true);
    });

    it('still enforces protocol limits (incompatible slot)', () => {
      const now = performance.now();
      const packState = makePackState(1, 1000, 14, now);
      assert.equal(strategy.canAdd(packState, makeBuffered(2000)), false);
    });

    it('still enforces protocol limits (max commands)', () => {
      const now = performance.now();
      const packState = makePackState(BINHDR.MAX_COMMANDS_PER_PACK, 1000, 14, now);
      assert.equal(strategy.canAdd(packState, makeBuffered(1000)), false);
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
      assertPackedHeader(packed, { commandCount: 1, slot: 0, requestId: 123 });
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
      assertPackedHeader(packed, { commandCount: 2 });
    });

    it('uses provided slot', () => {
      const buffer = [
        makeBuffered(BINHDR.SLOT_NO_SLOT, ['*1\r\n$4\r\nPING\r\n']),
        makeBuffered(5000, ['*2\r\n$3\r\nGET\r\n$3\r\nkey\r\n'], ['GET', 'key']),
      ];
      const totalPayload = buffer.reduce((sum, b) => sum + b.payloadLength, 0);

      const packed = packCommands(buffer, 5000, totalPayload, 0);
      assertPackedHeader(packed, { slot: 5000 });
    });
  });

  describe('CommandPacker', () => {
    describe('basic operations', () => {
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

      it('flushes on incompatible slot', () => {
        const packer = new CommandPacker();
        packer.add(makeBuffered(1000));
        packer.add(makeBuffered(1000));

        const flushed = packer.add(makeBuffered(2000));
        assertPackedHeader(flushed, { commandCount: 2, slot: 1000 });
        assert.equal(packer.bufferSize, 1);
      });

      it('drain returns packed commands and empties buffer', () => {
        const packer = new CommandPacker();
        packer.add(makeBuffered(1000));
        packer.add(makeBuffered(1000));

        const drained = packer.drain();
        assertPackedHeader(drained, { commandCount: 2 });
        assert.equal(packer.bufferSize, 0);
      });

      it('drain returns null when buffer is empty', () => {
        const packer = new CommandPacker();
        assert.equal(packer.drain(), null);
      });

      it('handles max commands flush', () => {
        const packer = new CommandPacker();

        for (let i = 0; i < BINHDR.MAX_COMMANDS_PER_PACK; i++) {
          packer.add(makeBuffered(1000));
        }
        assert.equal(packer.bufferSize, BINHDR.MAX_COMMANDS_PER_PACK);

        const flushed = packer.add(makeBuffered(1000));
        assertPackedHeader(flushed, { commandCount: BINHDR.MAX_COMMANDS_PER_PACK });
        assert.equal(packer.bufferSize, 1);
      });
    });

    describe('custom strategy', () => {
      it('uses custom strategy', () => {
        const customStrategy: PackingStrategy = {
          canAdd(currentPack) {
            return currentPack.commandCount < 2;
          },
        };

        const packer = new CommandPacker({ strategy: customStrategy });

        assert.equal(packer.add(makeBuffered(1000)), null);
        assert.equal(packer.add(makeBuffered(1000)), null);

        const flushed = packer.add(makeBuffered(1000));
        assert.ok(flushed !== null);
        assert.equal(packer.bufferSize, 1);
      });
    });

    describe('buffer timing', () => {
      it('tracks bufferStartTime', () => {
        const packer = new CommandPacker();

        assert.equal(packer.bufferStartTime, null);

        packer.add(makeBuffered(1000));
        const startTime = packer.bufferStartTime;
        assert.ok(startTime !== null && startTime > 0);

        packer.add(makeBuffered(1000));
        assert.equal(packer.bufferStartTime, startTime);

        packer.drain();
        assert.equal(packer.bufferStartTime, null);
      });

      it('getStaleTime returns correct time', () => {
        const packer = new CommandPacker({ maxWaitMs: 100 });

        assert.equal(packer.getStaleTime(), null);

        packer.add(makeBuffered(1000));
        const staleTime = packer.getStaleTime();
        const bufferStart = packer.bufferStartTime;

        assert.ok(staleTime !== null && bufferStart !== null);
        assert.equal(staleTime, bufferStart + 100);
      });

      it('getStaleTime returns null when maxWaitMs not configured', () => {
        const packer = new CommandPacker();
        packer.add(makeBuffered(1000));
        assert.equal(packer.getStaleTime(), null);
      });
    });

    describe('time-bounded flushing', () => {
      it('flushIfStale returns null when buffer is empty', () => {
        const packer = new CommandPacker({ maxWaitMs: 10 });
        assert.equal(packer.flushIfStale(), null);
      });

      it('flushIfStale returns null when buffer is not stale', () => {
        const packer = new CommandPacker({ maxWaitMs: 1000 });
        packer.add(makeBuffered(1000));
        assert.equal(packer.flushIfStale(), null);
        assert.equal(packer.bufferSize, 1);
      });

      it('flushIfStale returns packed data when buffer is stale', async () => {
        const packer = new CommandPacker({ maxWaitMs: 5 });
        packer.add(makeBuffered(1000));

        await delay(10);

        const packed = packer.flushIfStale();
        assert.ok(packed !== null);
        assert.equal(packer.bufferSize, 0);
      });

      it('inline staleness check triggers flush on add', async () => {
        const packer = new CommandPacker({ maxWaitMs: 5 });

        packer.add(makeBuffered(1000));
        assert.equal(packer.bufferSize, 1);

        await delay(10);

        const flushed = packer.add(makeBuffered(1000));
        assert.ok(flushed !== null);
        assert.equal(packer.bufferSize, 1);
      });
    });
  });

  describe('Scheduler implementations', () => {
    describe('createTimeoutScheduler', () => {
      it('schedules and executes', async () => {
        const scheduler = createTimeoutScheduler();
        let executed = false;

        scheduler.schedule(5, () => { executed = true; });

        assert.equal(executed, false);
        await delay(10);
        assert.equal(executed, true);
      });

      it('cancel prevents execution', async () => {
        const scheduler = createTimeoutScheduler();
        let executed = false;

        const handle = scheduler.schedule(5, () => { executed = true; });
        handle.cancel();

        await delay(10);
        assert.equal(executed, false);
      });
    });

    describe('createImmediateScheduler', () => {
      it('schedules for next tick (ignores delay)', async () => {
        const scheduler = createImmediateScheduler();
        let executed = false;

        scheduler.schedule(1000, () => { executed = true; });

        assert.equal(executed, false);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(executed, true);
      });

      it('cancel prevents execution', async () => {
        const scheduler = createImmediateScheduler();
        let executed = false;

        const handle = scheduler.schedule(0, () => { executed = true; });
        handle.cancel();

        await new Promise(resolve => setImmediate(resolve));
        assert.equal(executed, false);
      });
    });
  });
});
