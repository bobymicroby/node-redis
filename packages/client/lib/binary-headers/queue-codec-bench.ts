/**
 * Simple benchmark comparing queue codec implementations.
 * Tests single command encoding and decoding.
 *
 * Usage: npx ts-node lib/binary-headers/queue-codec-bench.ts
 */

import RedisCommandsQueue, { DEFAULT_CODEC, CommandCodec } from '../client/commands-queue';
import MasterQueue from './master-queue';
import { createBinhdrCodec, createBinhdrCodecOptimized } from './client-integration';
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

function createQueue(codec: CommandCodec): RedisCommandsQueue {
  return new RedisCommandsQueue(
    2,
    null,
    () => {},
    codec
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

function wrapCurrentQueue(codec: CommandCodec): BenchQueue {
  const queue = createQueue(codec);
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

  const queue = wrapCurrentQueue(DEFAULT_CODEC);

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

  // Wait for binhdr codecs to initialize
  const binhdrCodec = createBinhdrCodec();
  const binhdrCodecOpt = createBinhdrCodecOptimized();
  await new Promise(resolve => setTimeout(resolve, 100));

  // Encode benchmarks
  console.log('ENCODE (single SET command)');
  console.log('-'.repeat(60));

  const encodeMaster = runEncodeBenchmark('Master (no codec)', wrapMasterQueue, testCommand);
  const encodeDefault = runEncodeBenchmark('Default codec', () => wrapCurrentQueue(DEFAULT_CODEC), testCommand);
  const encodeBinhdr = runEncodeBenchmark('Binhdr codec', () => wrapCurrentQueue(binhdrCodec), testCommand);
  const encodeBinhdrOpt = runEncodeBenchmark('Binhdr optimized', () => wrapCurrentQueue(binhdrCodecOpt), testCommand);

  printResult(encodeMaster);
  printResult(encodeDefault);
  printResult(encodeBinhdr);
  printResult(encodeBinhdrOpt);

  const codecOverhead = encodeDefault.medianNs / encodeMaster.medianNs;
  const binhdrOverhead = encodeBinhdr.medianNs / encodeMaster.medianNs;
  const binhdrOptOverhead = encodeBinhdrOpt.medianNs / encodeMaster.medianNs;
  console.log(`\nOverhead vs master:`);
  console.log(`  Default codec:    ${((codecOverhead - 1) * 100).toFixed(1)}% (${codecOverhead.toFixed(2)}x)`);
  console.log(`  Binhdr codec:     ${((binhdrOverhead - 1) * 100).toFixed(1)}% (${binhdrOverhead.toFixed(2)}x)`);
  console.log(`  Binhdr optimized: ${((binhdrOptOverhead - 1) * 100).toFixed(1)}% (${binhdrOptOverhead.toFixed(2)}x)\n`);

  // Decode benchmarks
  console.log('DECODE (single +OK response)');
  console.log('-'.repeat(60));

  const decodeMaster = runDecodeBenchmark('Master (no codec)', wrapMasterQueue, plainResp);
  const decodeDefault = runDecodeBenchmark('Default codec', () => wrapCurrentQueue(DEFAULT_CODEC), plainResp);
  const decodeBinhdr = runDecodeBenchmark('Binhdr codec', () => wrapCurrentQueue(binhdrCodec), binhdrResp);
  const decodeBinhdrOpt = runDecodeBenchmark('Binhdr optimized', () => wrapCurrentQueue(binhdrCodecOpt), binhdrResp);

  printResult(decodeMaster);
  printResult(decodeDefault);
  printResult(decodeBinhdr);
  printResult(decodeBinhdrOpt);

  const decodeCodecOverhead = decodeDefault.medianNs / decodeMaster.medianNs;
  const decodeBinhdrOverhead = decodeBinhdr.medianNs / decodeMaster.medianNs;
  const decodeBinhdrOptOverhead = decodeBinhdrOpt.medianNs / decodeMaster.medianNs;
  console.log(`\nOverhead vs master:`);
  console.log(`  Default codec:    ${((decodeCodecOverhead - 1) * 100).toFixed(1)}% (${decodeCodecOverhead.toFixed(2)}x)`);
  console.log(`  Binhdr codec:     ${((decodeBinhdrOverhead - 1) * 100).toFixed(1)}% (${decodeBinhdrOverhead.toFixed(2)}x)`);
  console.log(`  Binhdr optimized: ${((decodeBinhdrOptOverhead - 1) * 100).toFixed(1)}% (${decodeBinhdrOptOverhead.toFixed(2)}x)\n`);

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
  const encodeBatchDefault = runEncodeBatchBenchmark('Default codec', () => wrapCurrentQueue(DEFAULT_CODEC), batchCommands);
  const encodeBatchBinhdr = runEncodeBatchBenchmark('Binhdr codec', () => wrapCurrentQueue(binhdrCodec), batchCommands);
  const encodeBatchBinhdrOpt = runEncodeBatchBenchmark('Binhdr optimized', () => wrapCurrentQueue(binhdrCodecOpt), batchCommands);

  printResult(encodeBatchMaster);
  printResult(encodeBatchDefault);
  printResult(encodeBatchBinhdr);
  printResult(encodeBatchBinhdrOpt);

  const batchCodecOverhead = encodeBatchDefault.medianNs / encodeBatchMaster.medianNs;
  const batchBinhdrOverhead = encodeBatchBinhdr.medianNs / encodeBatchMaster.medianNs;
  const batchBinhdrOptOverhead = encodeBatchBinhdrOpt.medianNs / encodeBatchMaster.medianNs;
  console.log(`\nOverhead vs master:`);
  console.log(`  Default codec:    ${((batchCodecOverhead - 1) * 100).toFixed(1)}% (${batchCodecOverhead.toFixed(2)}x)`);
  console.log(`  Binhdr codec:     ${((batchBinhdrOverhead - 1) * 100).toFixed(1)}% (${batchBinhdrOverhead.toFixed(2)}x)`);
  console.log(`  Binhdr optimized: ${((batchBinhdrOptOverhead - 1) * 100).toFixed(1)}% (${batchBinhdrOptOverhead.toFixed(2)}x)\n`);

  console.log(`DECODE BATCH (${BATCH_SIZE} +OK responses)`);
  console.log('-'.repeat(60));

  const decodeBatchMaster = runDecodeBatchBenchmark('Master (no codec)', wrapMasterQueue, batchCommands, plainBatchResp);
  const decodeBatchDefault = runDecodeBatchBenchmark('Default codec', () => wrapCurrentQueue(DEFAULT_CODEC), batchCommands, plainBatchResp);
  const decodeBatchBinhdr = runDecodeBatchBenchmark('Binhdr codec', () => wrapCurrentQueue(binhdrCodec), batchCommands, binhdrBatchResp);
  const decodeBatchBinhdrOpt = runDecodeBatchBenchmark('Binhdr optimized', () => wrapCurrentQueue(binhdrCodecOpt), batchCommands, binhdrBatchResp);

  printResult(decodeBatchMaster);
  printResult(decodeBatchDefault);
  printResult(decodeBatchBinhdr);
  printResult(decodeBatchBinhdrOpt);

  const decodeBatchCodecOverhead = decodeBatchDefault.medianNs / decodeBatchMaster.medianNs;
  const decodeBatchBinhdrOverhead = decodeBatchBinhdr.medianNs / decodeBatchMaster.medianNs;
  const decodeBatchBinhdrOptOverhead = decodeBatchBinhdrOpt.medianNs / decodeBatchMaster.medianNs;
  console.log(`\nOverhead vs master:`);
  console.log(`  Default codec:    ${((decodeBatchCodecOverhead - 1) * 100).toFixed(1)}% (${decodeBatchCodecOverhead.toFixed(2)}x)`);
  console.log(`  Binhdr codec:     ${((decodeBatchBinhdrOverhead - 1) * 100).toFixed(1)}% (${decodeBatchBinhdrOverhead.toFixed(2)}x)`);
  console.log(`  Binhdr optimized: ${((decodeBatchBinhdrOptOverhead - 1) * 100).toFixed(1)}% (${decodeBatchBinhdrOptOverhead.toFixed(2)}x)\n`);
}

main().catch(console.error);
