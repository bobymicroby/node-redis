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
import { RequestHeaderDecoder, RequestHeaderEncoder } from './generated/request-header-codec';

function makeBuffered(
  slot: number,
  resp: string[] = ['*1\r\n$4\r\nPING\r\n'],
  command: string[] = ['PING']
): BufferedCommand {
  return { command, resp, slot, payloadLength: calculatePayloadLength(resp) };
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

  const decoder = new RequestHeaderDecoder().wrap(packed[0] as Buffer, 0);
  assert.ok(decoder.isValid(), 'Expected valid header');

  if (expected.commandCount !== undefined) assert.equal(decoder.commandCount(), expected.commandCount);
  if (expected.slot !== undefined) assert.equal(decoder.slot(), expected.slot);
  if (expected.requestId !== undefined) assert.equal(decoder.requestId(), expected.requestId);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Packing', () => {
  describe('calculatePayloadLength', () => {
    const cases = [
      { name: 'string parts', resp: ['*1\r\n$4\r\nPING\r\n'], expected: 14 },
      { name: 'buffer parts', resp: [Buffer.from('*1\r\n$4\r\nPING\r\n')], expected: 14 },
      { name: 'empty array', resp: [] as string[], expected: 0 },
      { name: 'mixed string and buffer', resp: ['abc', Buffer.from('def')], expected: 6 },
    ];

    for (const { name, resp, expected } of cases) {
      it(name, () => assert.equal(calculatePayloadLength(resp), expected));
    }
  });

  describe('createBufferedCommand', () => {
    const cases = [
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
        eligibility: { eligible: true as const, slot: RequestHeaderEncoder.slotNullValue() },
        expectedSlot: RequestHeaderEncoder.slotNullValue(),
      },
    ];

    for (const { name, command, resp, eligibility, expectedSlot } of cases) {
      it(name, () => {
        const buffered = createBufferedCommand(command, resp, eligibility);
        assert.deepEqual(buffered.command, command);
        assert.deepEqual(buffered.resp, resp);
        assert.equal(buffered.slot, expectedSlot);
        assert.equal(buffered.payloadLength, calculatePayloadLength(resp));
      });
    }
  });

  describe('createDefaultPackingStrategy', () => {
    const strategy = createDefaultPackingStrategy();
    const SLOT_NO_SLOT = RequestHeaderEncoder.slotNullValue();
    const MAX_COMMANDS = RequestHeaderEncoder.commandCountMaxValue();

    const canAddCases = [
      { name: 'same slot', packState: makePackState(1, 1000, 14), incoming: makeBuffered(1000), expected: true },
      { name: 'incoming is SLOT_NO_SLOT', packState: makePackState(1, 1000, 14), incoming: makeBuffered(SLOT_NO_SLOT), expected: true },
      { name: 'current slot is SLOT_NO_SLOT', packState: makePackState(1, SLOT_NO_SLOT, 14), incoming: makeBuffered(1000), expected: true },
      { name: 'incompatible slots', packState: makePackState(1, 1000, 14), incoming: makeBuffered(2000), expected: false },
      { name: 'at max commands', packState: makePackState(MAX_COMMANDS, 1000, 14), incoming: makeBuffered(1000), expected: false },
      { name: 'at max commands - 1', packState: makePackState(MAX_COMMANDS - 1, 1000, 14), incoming: makeBuffered(1000), expected: true },
    ];

    for (const { name, packState, incoming, expected } of canAddCases) {
      it(name, () => assert.equal(strategy.canAdd(packState, incoming), expected));
    }

    it('rejects when payload exceeds max length', () => {
      const largePayload = 1000000;
      const incomingPayload = RequestHeaderEncoder.lengthMaxValue() - largePayload + 1;
      const incoming = { ...makeBuffered(1000), payloadLength: incomingPayload };
      assert.equal(strategy.canAdd(makePackState(1, 1000, largePayload), incoming), false);
    });
  });

  describe('createTimeBoundedPackingStrategy', () => {
    const strategy = createTimeBoundedPackingStrategy(100);

    const cases = [
      { name: 'not stale', ageMs: 50, expected: true },
      { name: 'stale', ageMs: 150, expected: false },
      { name: 'null bufferStartTime', bufferStartTime: null as number | null, expected: true },
    ];

    for (const { name, ageMs, bufferStartTime, expected } of cases) {
      it(name, () => {
        const startTime = bufferStartTime === null ? null : performance.now() - (ageMs ?? 0);
        const packState = makePackState(1, 1000, 14, startTime);
        assert.equal(strategy.canAdd(packState, makeBuffered(1000)), expected);
      });
    }

    it('still enforces protocol limits', () => {
      const now = performance.now();
      assert.equal(strategy.canAdd(makePackState(1, 1000, 14, now), makeBuffered(2000)), false);
      assert.equal(strategy.canAdd(makePackState(RequestHeaderEncoder.commandCountMaxValue(), 1000, 14, now), makeBuffered(1000)), false);
    });
  });

  describe('packCommands', () => {
    it('returns null for empty buffer', () => {
      assert.equal(packCommands([], RequestHeaderEncoder.slotNullValue(), 0), null);
    });

    it('packs single command', () => {
      const pingResp = ['*1\r\n$4\r\nPING\r\n'];
      const buffer = [makeBuffered(RequestHeaderEncoder.slotNullValue(), pingResp)];
      const packed = packCommands(buffer, RequestHeaderEncoder.slotNullValue(), calculatePayloadLength(pingResp), 123);

      assert.ok(packed !== null);
      assert.equal(packed.length, 2);
      assertPackedHeader(packed, { commandCount: 1, slot: 0, requestId: 123 });
    });

    it('packs multiple commands', () => {
      const buffer = [
        makeBuffered(RequestHeaderEncoder.slotNullValue(), ['*1\r\n$4\r\nPING\r\n']),
        makeBuffered(RequestHeaderEncoder.slotNullValue(), ['*1\r\n$4\r\nTIME\r\n']),
      ];
      const totalPayload = buffer.reduce((sum, b) => sum + b.payloadLength, 0);
      const packed = packCommands(buffer, RequestHeaderEncoder.slotNullValue(), totalPayload, 0);

      assert.ok(packed !== null);
      assert.equal(packed.length, 3);
      assertPackedHeader(packed, { commandCount: 2 });
    });

    it('uses provided slot', () => {
      const buffer = [
        makeBuffered(RequestHeaderEncoder.slotNullValue(), ['*1\r\n$4\r\nPING\r\n']),
        makeBuffered(5000, ['*2\r\n$3\r\nGET\r\n$3\r\nkey\r\n'], ['GET', 'key']),
      ];
      const totalPayload = buffer.reduce((sum, b) => sum + b.payloadLength, 0);
      assertPackedHeader(packCommands(buffer, 5000, totalPayload, 0), { slot: 5000 });
    });
  });

  describe('CommandPacker', () => {
    describe('basic operations', () => {
      it('buffers first command and returns null', () => {
        const packer = new CommandPacker();
        assert.equal(packer.add(makeBuffered(1000)), null);
        assert.equal(packer.bufferSize, 1);
      });

      it('buffers compatible commands', () => {
        const packer = new CommandPacker();
        packer.add(makeBuffered(1000));
        packer.add(makeBuffered(1000));
        packer.add(makeBuffered(RequestHeaderEncoder.slotNullValue()));
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

        assertPackedHeader(packer.drain(), { commandCount: 2 });
        assert.equal(packer.bufferSize, 0);
      });

      it('drain returns null when buffer is empty', () => {
        assert.equal(new CommandPacker().drain(), null);
      });

      it('flushes at max commands', () => {
        const packer = new CommandPacker();
        const maxCommands = RequestHeaderEncoder.commandCountMaxValue();

        for (let i = 0; i < maxCommands; i++) {
          packer.add(makeBuffered(1000));
        }
        assert.equal(packer.bufferSize, maxCommands);

        const flushed = packer.add(makeBuffered(1000));
        assertPackedHeader(flushed, { commandCount: maxCommands });
        assert.equal(packer.bufferSize, 1);
      });
    });

    describe('custom strategy', () => {
      it('uses custom canAdd logic', () => {
        const customStrategy: PackingStrategy = {
          canAdd: (currentPack) => currentPack.commandCount < 2,
        };
        const packer = new CommandPacker({ strategy: customStrategy });

        packer.add(makeBuffered(1000));
        packer.add(makeBuffered(1000));

        const flushed = packer.add(makeBuffered(1000));
        assert.ok(flushed !== null);
        assert.equal(packer.bufferSize, 1);
      });
    });

    describe('buffer timing', () => {
      it('tracks bufferStartTime when time-bounded', () => {
        const packer = new CommandPacker({ maxWaitMs: 100 });

        assert.equal(packer.bufferStartTime, null);
        packer.add(makeBuffered(1000));
        const startTime = packer.bufferStartTime;
        assert.ok(startTime !== null && startTime > 0);

        packer.add(makeBuffered(1000));
        assert.equal(packer.bufferStartTime, startTime);

        packer.drain();
        assert.equal(packer.bufferStartTime, null);
      });

      it('bufferStartTime is null without maxWaitMs (optimization)', () => {
        const packer = new CommandPacker();
        packer.add(makeBuffered(1000));
        packer.add(makeBuffered(1000));
        assert.equal(packer.bufferStartTime, null);
      });

      it('getStaleTime returns correct time when configured', () => {
        const packer = new CommandPacker({ maxWaitMs: 100 });

        assert.equal(packer.getStaleTime(), null);
        packer.add(makeBuffered(1000));

        const staleTime = packer.getStaleTime();
        const bufferStart = packer.bufferStartTime;
        assert.ok(staleTime !== null && bufferStart !== null);
        assert.equal(staleTime, bufferStart + 100);
      });

      it('getStaleTime returns null without maxWaitMs', () => {
        const packer = new CommandPacker();
        packer.add(makeBuffered(1000));
        assert.equal(packer.getStaleTime(), null);
      });
    });

    describe('time-bounded flushing', () => {
      it('flushIfStale returns null when buffer is empty', () => {
        assert.equal(new CommandPacker({ maxWaitMs: 10 }).flushIfStale(), null);
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

        assert.ok(packer.flushIfStale() !== null);
        assert.equal(packer.bufferSize, 0);
      });

      it('inline staleness check triggers flush on add', async () => {
        const packer = new CommandPacker({ maxWaitMs: 5 });
        packer.add(makeBuffered(1000));

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
        let executed = false;
        createTimeoutScheduler().schedule(5, () => { executed = true; });

        assert.equal(executed, false);
        await delay(10);
        assert.equal(executed, true);
      });

      it('cancel prevents execution', async () => {
        let executed = false;
        const handle = createTimeoutScheduler().schedule(5, () => { executed = true; });
        handle.cancel();

        await delay(10);
        assert.equal(executed, false);
      });
    });

    describe('createImmediateScheduler', () => {
      it('schedules for next tick (ignores delay)', async () => {
        let executed = false;
        createImmediateScheduler().schedule(1000, () => { executed = true; });

        assert.equal(executed, false);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(executed, true);
      });

      it('cancel prevents execution', async () => {
        let executed = false;
        const handle = createImmediateScheduler().schedule(0, () => { executed = true; });
        handle.cancel();

        await new Promise(resolve => setImmediate(resolve));
        assert.equal(executed, false);
      });
    });
  });
});
