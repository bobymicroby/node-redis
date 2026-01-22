import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  CommandPacker,
  createTimeoutScheduler,
  createImmediateScheduler,
  calculatePayloadLength,
} from './packing';
import { RequestHeaderDecoder, RequestHeaderEncoder } from './generated/request-header-codec';

const NULL_SLOT = RequestHeaderEncoder.slotNullValue();
const MAX_COMMANDS = RequestHeaderEncoder.commandCountMaxValue();

function assertPackedHeader(
  packed: ReadonlyArray<unknown> | null,
  expected: { commandCount?: number; slot?: number }
): void {
  assert.ok(packed !== null, 'Expected packed data to be non-null');
  assert.ok(packed[0] instanceof Buffer, 'Expected first element to be a Buffer');

  const decoder = new RequestHeaderDecoder().wrap(packed[0] as Buffer, 0);
  assert.ok(decoder.isValid(), 'Expected valid header');

  if (expected.commandCount !== undefined) {
    assert.equal(decoder.commandCount(), expected.commandCount);
  }
  if (expected.slot !== undefined) {
    assert.equal(decoder.slot(), expected.slot);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Packing', () => {
  describe('calculatePayloadLength', () => {
    it('calculates length for string parts', () => {
      assert.equal(calculatePayloadLength(['*1\r\n$4\r\nPING\r\n']), 14);
    });

    it('calculates length for buffer parts', () => {
      assert.equal(calculatePayloadLength([Buffer.from('*1\r\n$4\r\nPING\r\n')]), 14);
    });

    it('returns 0 for empty array', () => {
      assert.equal(calculatePayloadLength([]), 0);
    });

    it('calculates length for mixed string and buffer', () => {
      assert.equal(calculatePayloadLength(['abc', Buffer.from('def')]), 6);
    });
  });

  describe('CommandPacker', () => {
    describe('basic operations', () => {
      it('buffers first command and returns null', () => {
        const packer = new CommandPacker();
        const result = packer.add(['*1\r\n$4\r\nPING\r\n'], 1000, 14);
        assert.equal(result, null);
        assert.equal(packer.bufferSize, 1);
      });

      it('buffers compatible commands', () => {
        const packer = new CommandPacker();
        packer.add(['*1\r\n$4\r\nPING\r\n'], 1000, 14);
        packer.add(['*1\r\n$4\r\nPING\r\n'], 1000, 14);
        packer.add(['*1\r\n$4\r\nPING\r\n'], NULL_SLOT, 14);
        assert.equal(packer.bufferSize, 3);
      });

      it('flushes on incompatible slot', () => {
        const packer = new CommandPacker();
        packer.add(['*1\r\n$4\r\nPING\r\n'], 1000, 14);
        packer.add(['*1\r\n$4\r\nPING\r\n'], 1000, 14);

        const flushed = packer.add(['*1\r\n$4\r\nPING\r\n'], 2000, 14);
        assertPackedHeader(flushed, { commandCount: 2, slot: 1000 });
        assert.equal(packer.bufferSize, 1);
      });

      it('drain returns packed commands and empties buffer', () => {
        const packer = new CommandPacker();
        packer.add(['*1\r\n$4\r\nPING\r\n'], 1000, 14);
        packer.add(['*1\r\n$4\r\nPING\r\n'], 1000, 14);

        const drained = packer.drain();
        assertPackedHeader(drained, { commandCount: 2, slot: 1000 });
        assert.equal(packer.bufferSize, 0);
      });

      it('drain returns null when buffer is empty', () => {
        assert.equal(new CommandPacker().drain(), null);
      });

      it('flushes at max commands', () => {
        const packer = new CommandPacker();

        for (let i = 0; i < MAX_COMMANDS; i++) {
          packer.add(['*1\r\n$4\r\nPING\r\n'], 1000, 14);
        }
        assert.equal(packer.bufferSize, MAX_COMMANDS);

        const flushed = packer.add(['*1\r\n$4\r\nPING\r\n'], 1000, 14);
        assertPackedHeader(flushed, { commandCount: MAX_COMMANDS });
        assert.equal(packer.bufferSize, 1);
      });
    });

    describe('slot handling', () => {
      it('resolves slot from first non-null command', () => {
        const packer = new CommandPacker();
        packer.add(['resp1'], NULL_SLOT, 5);
        packer.add(['resp2'], 5000, 5);
        packer.add(['resp3'], NULL_SLOT, 5);

        const packed = packer.drain();
        assertPackedHeader(packed, { commandCount: 3, slot: 5000 });
      });

      it('uses slot 0 on wire when all commands are keyless', () => {
        const packer = new CommandPacker();
        packer.add(['resp1'], NULL_SLOT, 5);
        packer.add(['resp2'], NULL_SLOT, 5);

        const packed = packer.drain();
        assertPackedHeader(packed, { commandCount: 2, slot: 0 });
      });
    });

    describe('time-bounded flushing', () => {
      it('flushes stale buffer on add', async () => {
        const packer = new CommandPacker(5);
        packer.add(['*1\r\n$4\r\nPING\r\n'], 1000, 14);

        await delay(10);

        const flushed = packer.add(['*1\r\n$4\r\nPING\r\n'], 1000, 14);
        assert.ok(flushed !== null);
        assert.equal(packer.bufferSize, 1);
      });

      it('does not flush non-stale buffer', () => {
        const packer = new CommandPacker(1000);
        packer.add(['*1\r\n$4\r\nPING\r\n'], 1000, 14);

        const result = packer.add(['*1\r\n$4\r\nPING\r\n'], 1000, 14);
        assert.equal(result, null);
        assert.equal(packer.bufferSize, 2);
      });
    });

    describe('payload limits', () => {
      it('flushes when payload would exceed max length', () => {
        const packer = new CommandPacker();
        const maxPayload = RequestHeaderEncoder.lengthMaxValue();
        const largePayload = maxPayload - 100;

        packer.add(['large'], 1000, largePayload);
        const flushed = packer.add(['overflow'], 1000, 200);

        assert.ok(flushed !== null);
        assert.equal(packer.bufferSize, 1);
      });
    });

    describe('packed output structure', () => {
      it('includes header followed by all resp parts', () => {
        const packer = new CommandPacker();
        packer.add(['part1a', 'part1b'], 1000, 10);
        packer.add(['part2a'], 1000, 5);

        const packed = packer.drain();
        assert.ok(packed !== null);
        assert.equal(packed.length, 4); // header + part1a + part1b + part2a
        assert.ok(packed[0] instanceof Buffer);
        assert.equal(packed[1], 'part1a');
        assert.equal(packed[2], 'part1b');
        assert.equal(packed[3], 'part2a');
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
      it('schedules for next tick ignoring delay', async () => {
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
