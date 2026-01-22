/**
 * Simple benchmark comparing queue codec implementations.
 * Tests single command encoding and decoding.
 *
 * Usage: npx ts-node lib/binary-headers/queue-codec-bench.ts
 */

import RedisCommandsQueue from '../client/commands-queue';
import MasterQueue from './master-queue';
import BinhdrCommandsQueue from './binhdr-commands-queue';
import { createBinhdrResponse } from './test-utils';

// ============================================================================
// Config
// ============================================================================

const WARMUP_ITERATIONS = 10_000;
const MEASURE_ITERATIONS = 100_000;
const ROUNDS = 5;

// ============================================================================
// Queue Factory
// ============================================================================

function createQueue(): RedisCommandsQueue {
  return new RedisCommandsQueue(
    2,
    null,
    () => {}
  );
}

function createBinhdrQueue(): BinhdrCommandsQueue {
  return new BinhdrCommandsQueue(
    2,
    null,
    () => {},
    {}
  );
}

function createMasterQueue(): MasterQueue {
  return new MasterQueue(
    2,
    null,
    () => {}
  );
}

// ============================================================================
// Queue Interface (unified for benchmarking)
// ============================================================================

interface BenchQueue {
  addCommand(args: ReadonlyArray<string>): void;
  commandsToWrite(): Generator<ReadonlyArray<string | Buffer>>;
  decode(chunk: Buffer): void;
}

function wrapCurrentQueue(): BenchQueue {
  const queue = createQueue();
  return {
    addCommand: (args) => { queue.addCommand(args); },
    commandsToWrite: () => queue.commandsToWrite(),
    decode: (chunk) => queue.processIncomingData(chunk),
  };
}

function wrapBinhdrQueue(): BenchQueue {
  const queue = createBinhdrQueue();
  return {
    addCommand: (args) => { queue.addCommand(args); },
    commandsToWrite: () => queue.commandsToWrite(),
    decode: (chunk) => queue.processIncomingData(chunk),
  };
}

function wrapMasterQueue(): BenchQueue {
  const queue = createMasterQueue();
  return {
    addCommand: (args) => { queue.addCommand(args); },
    commandsToWrite: () => queue.commandsToWrite(),
    decode: (chunk) => queue.decoder.write(chunk),
  };
}

// ============================================================================
// Benchmark Helpers
// ============================================================================

function measureEncode(queue: BenchQueue, command: ReadonlyArray<string>): number {
  queue.addCommand(command);

  const start = process.hrtime.bigint();
  for (const _encoded of queue.commandsToWrite()) {
    // consume
  }
  return Number(process.hrtime.bigint() - start);
}

function measureEncodeBatch(queue: BenchQueue, commands: ReadonlyArray<ReadonlyArray<string>>): number {
  for (const cmd of commands) {
    queue.addCommand(cmd);
  }

  const start = process.hrtime.bigint();
  for (const _encoded of queue.commandsToWrite()) {
    // consume
  }
  return Number(process.hrtime.bigint() - start);
}

function measureDecode(queue: BenchQueue, chunk: Buffer): number {
  const start = process.hrtime.bigint();
  queue.decode(chunk);
  return Number(process.hrtime.bigint() - start);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function runEncodeBenchmark(
  name: string,
  createBenchQueue: () => BenchQueue,
  command: ReadonlyArray<string>
): { name: string; medianNs: number; minNs: number; maxNs: number } {
  // Warmup
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    const queue = createBenchQueue();
    measureEncode(queue, command);
  }

  // Multiple rounds
  const roundAvgs: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    let totalNs = 0;
    for (let i = 0; i < MEASURE_ITERATIONS; i++) {
      const queue = createBenchQueue();
      totalNs += measureEncode(queue, command);
    }
    roundAvgs.push(totalNs / MEASURE_ITERATIONS);
  }

  return {
    name,
    medianNs: median(roundAvgs),
    minNs: Math.min(...roundAvgs),
    maxNs: Math.max(...roundAvgs),
  };
}

function runDecodeBenchmark(
  name: string,
  createBenchQueue: () => BenchQueue,
  chunk: Buffer
): { name: string; medianNs: number; minNs: number; maxNs: number } {
  // Warmup
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    const queue = createBenchQueue();
    queue.addCommand(['PING']);
    for (const _ of queue.commandsToWrite()) {}
    queue.decode(chunk);
  }

  // Multiple rounds
  const roundAvgs: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    let totalNs = 0;
    for (let i = 0; i < MEASURE_ITERATIONS; i++) {
      const queue = createBenchQueue();
      queue.addCommand(['PING']);
      for (const _ of queue.commandsToWrite()) {}
      totalNs += measureDecode(queue, chunk);
    }
    roundAvgs.push(totalNs / MEASURE_ITERATIONS);
  }

  return {
    name,
    medianNs: median(roundAvgs),
    minNs: Math.min(...roundAvgs),
    maxNs: Math.max(...roundAvgs),
  };
}

function runEncodeBatchBenchmark(
  name: string,
  createBenchQueue: () => BenchQueue,
  commands: ReadonlyArray<ReadonlyArray<string>>
): { name: string; medianNs: number; minNs: number; maxNs: number } {
  // Warmup
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    const queue = createBenchQueue();
    measureEncodeBatch(queue, commands);
  }

  // Multiple rounds
  const roundAvgs: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    let totalNs = 0;
    for (let i = 0; i < MEASURE_ITERATIONS; i++) {
      const queue = createBenchQueue();
      totalNs += measureEncodeBatch(queue, commands);
    }
    roundAvgs.push(totalNs / MEASURE_ITERATIONS);
  }

  return {
    name,
    medianNs: median(roundAvgs),
    minNs: Math.min(...roundAvgs),
    maxNs: Math.max(...roundAvgs),
  };
}

function runDecodeBatchBenchmark(
  name: string,
  createBenchQueue: () => BenchQueue,
  commands: ReadonlyArray<ReadonlyArray<string>>,
  chunk: Buffer
): { name: string; medianNs: number; minNs: number; maxNs: number } {
  // Warmup
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    const queue = createBenchQueue();
    for (const cmd of commands) {
      queue.addCommand(cmd);
    }
    for (const _ of queue.commandsToWrite()) {}
    queue.decode(chunk);
  }

  // Multiple rounds
  const roundAvgs: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    let totalNs = 0;
    for (let i = 0; i < MEASURE_ITERATIONS; i++) {
      const queue = createBenchQueue();
      for (const cmd of commands) {
        queue.addCommand(cmd);
      }
      for (const _ of queue.commandsToWrite()) {}
      totalNs += measureDecode(queue, chunk);
    }
    roundAvgs.push(totalNs / MEASURE_ITERATIONS);
  }

  return {
    name,
    medianNs: median(roundAvgs),
    minNs: Math.min(...roundAvgs),
    maxNs: Math.max(...roundAvgs),
  };
}

// ============================================================================
// Verification
// ============================================================================

function verifyEncoding(): void {
  console.log('Verifying encoding works correctly...\n');

  const queue = wrapCurrentQueue();

  // Before addCommand - should yield nothing
  let countBefore = 0;
  for (const _ of queue.commandsToWrite()) {
    countBefore++;
  }
  console.log(`  Before addCommand: ${countBefore} commands yielded`);

  // Add command
  queue.addCommand(['SET', 'key', 'value']);

  // After addCommand - should yield one encoded command
  let countAfter = 0;
  let encodedData: any = null;
  for (const encoded of queue.commandsToWrite()) {
    countAfter++;
    encodedData = encoded;
  }
  console.log(`  After addCommand:  ${countAfter} command yielded`);

  if (encodedData) {
    const asString = encodedData.map((b: any) => Buffer.isBuffer(b) ? b.toString() : String(b)).join('');
    console.log(`  Encoded output:    ${JSON.stringify(asString)}`);
  }

  if (countBefore !== 0 || countAfter !== 1) {
    throw new Error('Encoding verification failed!');
  }
  console.log('\n  ✓ Verification passed\n');
}

// ============================================================================
// Main
// ============================================================================

function formatNs(ns: number): string {
  if (ns >= 1_000_000) return (ns / 1_000_000).toFixed(2) + 'ms';
  if (ns >= 1_000) return (ns / 1_000).toFixed(2) + 'µs';
  return ns.toFixed(0) + 'ns';
}

function printResult(r: { name: string; medianNs: number; minNs: number; maxNs: number }): void {
  console.log(`${r.name.padEnd(20)} median: ${formatNs(r.medianNs).padStart(8)}  [${formatNs(r.minNs)} - ${formatNs(r.maxNs)}]`);
}

async function main(): Promise<void> {
  console.log('Queue Codec Benchmark');
  console.log('=====================\n');

  // Verify encoding actually works before running benchmarks
  verifyEncoding();

  console.log(`Warmup: ${WARMUP_ITERATIONS.toLocaleString()} iterations`);
  console.log(`Measure: ${MEASURE_ITERATIONS.toLocaleString()} iterations x ${ROUNDS} rounds\n`);

  const testCommand: ReadonlyArray<string> = ['SET', 'key', 'value'];
  const plainResp = Buffer.from('+OK\r\n');
  const binhdrResp = createBinhdrResponse('+OK\r\n');

  // Encode benchmarks
  console.log('ENCODE (single SET command)');
  console.log('-'.repeat(60));

  const encodeMaster = runEncodeBenchmark('Master (no codec)', wrapMasterQueue, testCommand);
  const encodeDefault = runEncodeBenchmark('No codec', () => wrapCurrentQueue(), testCommand);
  const encodeBinhdr = runEncodeBenchmark('Binhdr codec', () => wrapBinhdrQueue(), testCommand);

  printResult(encodeMaster);
  printResult(encodeDefault);
  printResult(encodeBinhdr);

  const codecOverhead = encodeDefault.medianNs / encodeMaster.medianNs;
  const binhdrOverhead = encodeBinhdr.medianNs / encodeMaster.medianNs;
  console.log(`\nOverhead vs master:`);
  console.log(`  No codec:         ${((codecOverhead - 1) * 100).toFixed(1)}% (${codecOverhead.toFixed(2)}x)`);
  console.log(`  Binhdr codec:     ${((binhdrOverhead - 1) * 100).toFixed(1)}% (${binhdrOverhead.toFixed(2)}x)\n`);

  // Decode benchmarks
  console.log('DECODE (single +OK response)');
  console.log('-'.repeat(60));

  const decodeMaster = runDecodeBenchmark('Master (no codec)', wrapMasterQueue, plainResp);
  const decodeDefault = runDecodeBenchmark('No codec', () => wrapCurrentQueue(), plainResp);
  const decodeBinhdr = runDecodeBenchmark('Binhdr codec', () => wrapBinhdrQueue(), binhdrResp);

  printResult(decodeMaster);
  printResult(decodeDefault);
  printResult(decodeBinhdr);

  const decodeCodecOverhead = decodeDefault.medianNs / decodeMaster.medianNs;
  const decodeBinhdrOverhead = decodeBinhdr.medianNs / decodeMaster.medianNs;
  console.log(`\nOverhead vs master:`);
  console.log(`  No codec:         ${((decodeCodecOverhead - 1) * 100).toFixed(1)}% (${decodeCodecOverhead.toFixed(2)}x)`);
  console.log(`  Binhdr codec:     ${((decodeBinhdrOverhead - 1) * 100).toFixed(1)}% (${decodeBinhdrOverhead.toFixed(2)}x)\n`);

  // ============================================================================
  // Batch scenario (10 commands queued)
  // ============================================================================

  const BATCH_SIZE = 10;
  const batchCommands: ReadonlyArray<ReadonlyArray<string>> = Array.from(
    { length: BATCH_SIZE },
    (_, i) => ['SET', `key${i}`, `value${i}`]
  );

  // Build batch responses: 10 x "+OK\r\n"
  const plainBatchResp = Buffer.from('+OK\r\n'.repeat(BATCH_SIZE));
  const binhdrBatchResp = createBinhdrResponse('+OK\r\n'.repeat(BATCH_SIZE));

  console.log(`ENCODE BATCH (${BATCH_SIZE} SET commands)`);
  console.log('-'.repeat(60));

  const encodeBatchMaster = runEncodeBatchBenchmark('Master (no codec)', wrapMasterQueue, batchCommands);
  const encodeBatchDefault = runEncodeBatchBenchmark('No codec', () => wrapCurrentQueue(), batchCommands);
  const encodeBatchBinhdr = runEncodeBatchBenchmark('Binhdr codec', () => wrapBinhdrQueue(), batchCommands);

  printResult(encodeBatchMaster);
  printResult(encodeBatchDefault);
  printResult(encodeBatchBinhdr);

  const batchCodecOverhead = encodeBatchDefault.medianNs / encodeBatchMaster.medianNs;
  const batchBinhdrOverhead = encodeBatchBinhdr.medianNs / encodeBatchMaster.medianNs;
  console.log(`\nOverhead vs master:`);
  console.log(`  No codec:         ${((batchCodecOverhead - 1) * 100).toFixed(1)}% (${batchCodecOverhead.toFixed(2)}x)`);
  console.log(`  Binhdr codec:     ${((batchBinhdrOverhead - 1) * 100).toFixed(1)}% (${batchBinhdrOverhead.toFixed(2)}x)\n`);

  console.log(`DECODE BATCH (${BATCH_SIZE} +OK responses)`);
  console.log('-'.repeat(60));

  const decodeBatchMaster = runDecodeBatchBenchmark('Master (no codec)', wrapMasterQueue, batchCommands, plainBatchResp);
  const decodeBatchDefault = runDecodeBatchBenchmark('No codec', () => wrapCurrentQueue(), batchCommands, plainBatchResp);
  const decodeBatchBinhdr = runDecodeBatchBenchmark('Binhdr codec', () => wrapBinhdrQueue(), batchCommands, binhdrBatchResp);

  printResult(decodeBatchMaster);
  printResult(decodeBatchDefault);
  printResult(decodeBatchBinhdr);

  const decodeBatchCodecOverhead = decodeBatchDefault.medianNs / decodeBatchMaster.medianNs;
  const decodeBatchBinhdrOverhead = decodeBatchBinhdr.medianNs / decodeBatchMaster.medianNs;
  console.log(`\nOverhead vs master:`);
  console.log(`  No codec:         ${((decodeBatchCodecOverhead - 1) * 100).toFixed(1)}% (${decodeBatchCodecOverhead.toFixed(2)}x)`);
  console.log(`  Binhdr codec:     ${((decodeBatchBinhdrOverhead - 1) * 100).toFixed(1)}% (${decodeBatchBinhdrOverhead.toFixed(2)}x)\n`);
}

main().catch(console.error);
