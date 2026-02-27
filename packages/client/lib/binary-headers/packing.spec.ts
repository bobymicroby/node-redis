import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'mocha';
import {
  CommandPacker,
  createTimeoutScheduler,
  createImmediateScheduler,
  calculatePayloadLength,
} from './packing';
import { FlushReason } from './stats';
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
    describe('flush trigger conditions (table-driven)', () => {
      // Comprehensive table of all flush triggers
      const flushTriggerCases = [
        {
          name: 'incompatible slot triggers flush',
          setup: (p: CommandPacker) => {
            p.add(['cmd1'], 1000, 4);
            p.add(['cmd2'], 1000, 4);
          },
          triggerAdd: { resp: ['cmd3'], slot: 2000, len: 4 },
          expectFlush: true,
          expectFlushedCount: 2,
          expectBufferedAfter: 1,
        },
        {
          name: 'max commands triggers flush',
          setup: (p: CommandPacker) => {
            for (let i = 0; i < MAX_COMMANDS; i++) {
              p.add([`cmd${i}`], 1000, 4);
            }
          },
          triggerAdd: { resp: ['overflow'], slot: 1000, len: 4 },
          expectFlush: true,
          expectFlushedCount: MAX_COMMANDS,
          expectBufferedAfter: 1,
        },
        {
          name: 'compatible slot does not flush',
          setup: (p: CommandPacker) => {
            p.add(['cmd1'], 1000, 4);
          },
          triggerAdd: { resp: ['cmd2'], slot: 1000, len: 4 },
          expectFlush: false,
          expectBufferedAfter: 2,
        },
        {
          name: 'null slot compatible with any',
          setup: (p: CommandPacker) => {
            p.add(['cmd1'], 5000, 4);
          },
          triggerAdd: { resp: ['cmd2'], slot: NULL_SLOT, len: 4 },
          expectFlush: false,
          expectBufferedAfter: 2,
        },
      ];

      for (const tc of flushTriggerCases) {
        it(tc.name, () => {
          const packer = new CommandPacker();
          tc.setup(packer);

          const result = packer.add(tc.triggerAdd.resp, tc.triggerAdd.slot, tc.triggerAdd.len);

          if (tc.expectFlush) {
            assert.ok(result !== null, 'Expected flush');
            assertPackedHeader(result, { commandCount: tc.expectFlushedCount });
          } else {
            assert.equal(result, null, 'Expected no flush');
          }
          assert.equal(packer.bufferSize, tc.expectBufferedAfter);
        });
      }
    });

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

      it('header buffer is not corrupted by subsequent flush (buffer reuse regression)', () => {
        // This test catches a bug where the packer reused its internal header buffer
        // without copying. If the caller holds a reference to the first flush result
        // while a second flush occurs, the first result's header would be corrupted.
        const packer = new CommandPacker();

        // First batch: slot 1000, 2 commands
        packer.add(['cmd1'], 1000, 4);
        packer.add(['cmd2'], 1000, 4);
        const firstFlush = packer.add(['cmd3'], 2000, 4); // triggers flush (slot change)

        // Second batch: slot 2000, 2 commands
        packer.add(['cmd4'], 2000, 4);
        const secondFlush = packer.add(['cmd5'], 3000, 4); // triggers flush (slot change)

        // Third batch via drain: slot 3000, 1 command
        const thirdFlush = packer.drain(FlushReason.DRAIN);

        // CRITICAL: Verify first flush header is still valid after subsequent flushes
        // Before the fix, firstFlush[0] would contain thirdFlush's header data
        assertPackedHeader(firstFlush, { commandCount: 2, slot: 1000 });
        assertPackedHeader(secondFlush, { commandCount: 2, slot: 2000 });
        assertPackedHeader(thirdFlush, { commandCount: 1, slot: 3000 });

        // Also verify the header buffers are distinct objects (not aliased)
        assert.notStrictEqual(firstFlush![0], secondFlush![0], 'Header buffers should be distinct');
        assert.notStrictEqual(secondFlush![0], thirdFlush![0], 'Header buffers should be distinct');
      });

      it('drain returns packed commands and empties buffer', () => {
        const packer = new CommandPacker();
        packer.add(['*1\r\n$4\r\nPING\r\n'], 1000, 14);
        packer.add(['*1\r\n$4\r\nPING\r\n'], 1000, 14);

        const drained = packer.drain(FlushReason.DRAIN);
        assertPackedHeader(drained, { commandCount: 2, slot: 1000 });
        assert.equal(packer.bufferSize, 0);
      });

      it('drain returns null when buffer is empty', () => {
        assert.equal(new CommandPacker().drain(FlushReason.DRAIN), null);
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

        const packed = packer.drain(FlushReason.DRAIN);
        assertPackedHeader(packed, { commandCount: 3, slot: 5000 });
      });

      it('uses slot 0 on wire when all commands are keyless', () => {
        const packer = new CommandPacker();
        packer.add(['resp1'], NULL_SLOT, 5);
        packer.add(['resp2'], NULL_SLOT, 5);

        const packed = packer.drain(FlushReason.DRAIN);
        assertPackedHeader(packed, { commandCount: 2, slot: 0 });
      });

      it('keyless commands can join any existing slot batch', () => {
        const packer = new CommandPacker();
        packer.add(['keyed'], 5000, 5);      // Sets slot to 5000
        packer.add(['keyless1'], NULL_SLOT, 8); // NULL_SLOT compatible with 5000
        packer.add(['keyless2'], NULL_SLOT, 8); // Still compatible

        assert.equal(packer.bufferSize, 3);
        const packed = packer.drain(FlushReason.DRAIN);
        assertPackedHeader(packed, { commandCount: 3, slot: 5000 });
      });

      it('keyed command joins keyless batch and sets slot', () => {
        const packer = new CommandPacker();
        packer.add(['keyless1'], NULL_SLOT, 8);
        packer.add(['keyless2'], NULL_SLOT, 8);
        packer.add(['keyed'], 3000, 5); // First non-null slot wins

        assert.equal(packer.bufferSize, 3);
        const packed = packer.drain(FlushReason.DRAIN);
        assertPackedHeader(packed, { commandCount: 3, slot: 3000 });
      });

      // Table-driven slot compatibility tests
      const slotCompatibilityCases = [
        { name: 'same slot', slots: [1000, 1000, 1000], expectBatched: 3 },
        { name: 'null then keyed', slots: [NULL_SLOT, 2000, NULL_SLOT], expectBatched: 3 },
        { name: 'keyed then null', slots: [3000, NULL_SLOT, NULL_SLOT], expectBatched: 3 },
        { name: 'all null', slots: [NULL_SLOT, NULL_SLOT, NULL_SLOT], expectBatched: 3 },
      ];

      for (const { name, slots, expectBatched } of slotCompatibilityCases) {
        it(`batches compatible slots: ${name}`, () => {
          const packer = new CommandPacker();
          slots.forEach((slot, i) => packer.add([`cmd${i}`], slot, 4));

          assert.equal(packer.bufferSize, expectBatched);
        });
      }
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

      it('does not flush when payload exactly at max length', () => {
        const packer = new CommandPacker();
        const maxPayload = RequestHeaderEncoder.lengthMaxValue();

        // First command takes up most of the space
        packer.add(['first'], 1000, maxPayload - 10);
        // Second command exactly fills remaining space
        const result = packer.add(['second'], 1000, 10);

        // Should NOT flush - we're exactly at the limit, not over
        assert.equal(result, null);
        assert.equal(packer.bufferSize, 2);

        // Verify drain works and has correct total
        const drained = packer.drain(FlushReason.DRAIN);
        assertPackedHeader(drained, { commandCount: 2, slot: 1000 });
      });

      it('flushes when payload would exceed by even 1 byte', () => {
        const packer = new CommandPacker();
        const maxPayload = RequestHeaderEncoder.lengthMaxValue();

        packer.add(['first'], 1000, maxPayload - 10);
        // One byte over the limit
        const flushed = packer.add(['second'], 1000, 11);

        assert.ok(flushed !== null);
        assertPackedHeader(flushed, { commandCount: 1, slot: 1000 });
        assert.equal(packer.bufferSize, 1);
      });
    });

    describe('packed output structure', () => {
      it('includes header followed by all resp parts', () => {
        const packer = new CommandPacker();
        packer.add(['part1a', 'part1b'], 1000, 10);
        packer.add(['part2a'], 1000, 5);

        const packed = packer.drain(FlushReason.DRAIN);
        assert.ok(packed !== null);
        assert.equal(packed.length, 4); // header + part1a + part1b + part2a
        assert.ok(packed[0] instanceof Buffer);
        assert.equal(packed[1], 'part1a');
        assert.equal(packed[2], 'part1b');
        assert.equal(packed[3], 'part2a');
      });
    });

    describe('memory retention', () => {
      it('releases flushed payload references so GC can reclaim them', () => {
        const script = `
          const { CommandPacker } = require('./packages/client/lib/binary-headers/packing');
          const { FlushReason } = require('./packages/client/lib/binary-headers/stats');
          const packer = new CommandPacker(undefined, { maxCommandCount: 2 });

          let ref;
          (() => {
            let payload = Buffer.alloc(8 * 1024 * 1024, 0x61);
            ref = new WeakRef(payload);
            packer.add([payload], 1, payload.length);
            let drained = packer.drain(FlushReason.DRAIN);
            drained = null;
            payload = null;
          })();

          (async () => {
            for (let i = 0; i < 200; i++) {
              global.gc();
              if (ref.deref() === undefined) {
                process.stdout.write('collected');
                return;
              }
              await new Promise(resolve => setImmediate(resolve));
            }
            process.stdout.write('retained');
          })().catch(err => {
            console.error(err);
            process.exit(1);
          });
        `;

        const result = spawnSync(
          process.execPath,
          ['--expose-gc', '-r', 'ts-node/register/transpile-only', '-e', script],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              TS_NODE_PROJECT: './packages/test-utils/tsconfig.json',
            },
            encoding: 'utf8',
          }
        );

        assert.equal(result.status, 0, `probe process failed: ${result.stderr || 'unknown error'}`);
        assert.equal(
          result.stdout.trim(),
          'collected',
          `flushed payload is still retained: ${result.stdout.trim()}`
        );
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
