/**
 * Simple benchmark comparing queue implementations.
 * Tests single command encoding and decoding.
 *
 * Compares:
 * - Master baseline (original commands-queue from master branch)
 * - Current queue without codec
 * - Current queue with binary headers codec
 *
 * Usage: npx ts-node lib/binary-headers/queue-codec-bench.ts
 */

import RedisCommandsQueue from '../client/commands-queue';
import MasterQueue from './master-queue';
import { BinaryHeadersCodec } from './codec';
import { DefaultBinaryHeaderStatsCounter } from './stats';
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

function createMasterQueue(): MasterQueue {
  return new MasterQueue(
    2,
    null,
    () => {}
  );
}

function createQueue(): RedisCommandsQueue {
  return new RedisCommandsQueue(
    2,
    null,
    () => {},
    ''
  );
}

function createQueueWithBinhdr(): RedisCommandsQueue {
  return new RedisCommandsQueue(
    2,
    null,
    () => {},
    '',
    new BinaryHeadersCodec()
  );
}

function createQueueWithBinhdrAndStats(): RedisCommandsQueue {
  return new RedisCommandsQueue(
    2,
    null,
    () => {},
    '',
    new BinaryHeadersCodec({
      statsCounter: DefaultBinaryHeaderStatsCounter.create()
    })
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

function wrapMasterQueue(): BenchQueue {
  const queue = createMasterQueue();
  return {
    addCommand: (args) => { queue.addCommand(args); },
    commandsToWrite: () => queue.commandsToWrite(),
    decode: (chunk) => queue.decoder.write(chunk),
  };
}

function wrapQueue(): BenchQueue {
  const queue = createQueue();
  return {
    addCommand: (args) => { queue.addCommand(args); },
    commandsToWrite: () => queue.commandsToWrite(),
    decode: (chunk) => queue.processIncomingData(chunk),
  };
}

function wrapQueueWithBinhdr(): BenchQueue {
  const queue = createQueueWithBinhdr();
  return {
    addCommand: (args) => { queue.addCommand(args); },
    commandsToWrite: () => queue.commandsToWrite(),
    decode: (chunk) => queue.processIncomingData(chunk),
  };
}

function wrapQueueWithBinhdrAndStats(): BenchQueue {
  const queue = createQueueWithBinhdrAndStats();
  return {
    addCommand: (args) => { queue.addCommand(args); },
    commandsToWrite: () => queue.commandsToWrite(),
    decode: (chunk) => queue.processIncomingData(chunk),
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

  const queue = wrapQueue();

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
  console.log(`${r.name.padEnd(25)} median: ${formatNs(r.medianNs).padStart(8)}  [${formatNs(r.minNs)} - ${formatNs(r.maxNs)}]`);
}

async function main(): Promise<void> {
  console.log('Queue Codec Benchmark');
  console.log('=====================\n');
  console.log('Comparing unified RedisCommandsQueue with and without binary headers codec.\n');

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

  const encodeMaster = runEncodeBenchmark('Master (baseline)', wrapMasterQueue, testCommand);
  const encodeNoCodec = runEncodeBenchmark('Current (no codec)', wrapQueue, testCommand);
  const encodeBinhdr = runEncodeBenchmark('Current (binhdr)', wrapQueueWithBinhdr, testCommand);
  const encodeBinhdrStats = runEncodeBenchmark('Current (binhdr+stats)', wrapQueueWithBinhdrAndStats, testCommand);

  printResult(encodeMaster);
  printResult(encodeNoCodec);
  printResult(encodeBinhdr);
  printResult(encodeBinhdrStats);

  const encodeCurrentOverhead = encodeNoCodec.medianNs / encodeMaster.medianNs;
  const encodeBinhdrOverhead = encodeBinhdr.medianNs / encodeMaster.medianNs;
  const encodeBinhdrStatsOverhead = encodeBinhdrStats.medianNs / encodeMaster.medianNs;
  console.log(`\nOverhead vs master baseline:`);
  console.log(`  Current (no codec): ${((encodeCurrentOverhead - 1) * 100).toFixed(1)}% (${encodeCurrentOverhead.toFixed(2)}x)`);
  console.log(`  Current (binhdr):   ${((encodeBinhdrOverhead - 1) * 100).toFixed(1)}% (${encodeBinhdrOverhead.toFixed(2)}x)`);
  console.log(`  Current (binhdr+stats): ${((encodeBinhdrStatsOverhead - 1) * 100).toFixed(1)}% (${encodeBinhdrStatsOverhead.toFixed(2)}x)\n`);

  // Decode benchmarks
  console.log('DECODE (single +OK response)');
  console.log('-'.repeat(60));

  const decodeMaster = runDecodeBenchmark('Master (baseline)', wrapMasterQueue, plainResp);
  const decodeNoCodec = runDecodeBenchmark('Current (no codec)', wrapQueue, plainResp);
  const decodeBinhdr = runDecodeBenchmark('Current (binhdr)', wrapQueueWithBinhdr, binhdrResp);
  const decodeBinhdrStats = runDecodeBenchmark('Current (binhdr+stats)', wrapQueueWithBinhdrAndStats, binhdrResp);

  printResult(decodeMaster);
  printResult(decodeNoCodec);
  printResult(decodeBinhdr);
  printResult(decodeBinhdrStats);

  const decodeCurrentOverhead = decodeNoCodec.medianNs / decodeMaster.medianNs;
  const decodeBinhdrOverhead = decodeBinhdr.medianNs / decodeMaster.medianNs;
  const decodeBinhdrStatsOverhead = decodeBinhdrStats.medianNs / decodeMaster.medianNs;
  console.log(`\nOverhead vs master baseline:`);
  console.log(`  Current (no codec): ${((decodeCurrentOverhead - 1) * 100).toFixed(1)}% (${decodeCurrentOverhead.toFixed(2)}x)`);
  console.log(`  Current (binhdr):   ${((decodeBinhdrOverhead - 1) * 100).toFixed(1)}% (${decodeBinhdrOverhead.toFixed(2)}x)`);
  console.log(`  Current (binhdr+stats): ${((decodeBinhdrStatsOverhead - 1) * 100).toFixed(1)}% (${decodeBinhdrStatsOverhead.toFixed(2)}x)\n`);

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

  const encodeBatchMaster = runEncodeBatchBenchmark('Master (baseline)', wrapMasterQueue, batchCommands);
  const encodeBatchNoCodec = runEncodeBatchBenchmark('Current (no codec)', wrapQueue, batchCommands);
  const encodeBatchBinhdr = runEncodeBatchBenchmark('Current (binhdr)', wrapQueueWithBinhdr, batchCommands);
  const encodeBatchBinhdrStats = runEncodeBatchBenchmark('Current (binhdr+stats)', wrapQueueWithBinhdrAndStats, batchCommands);

  printResult(encodeBatchMaster);
  printResult(encodeBatchNoCodec);
  printResult(encodeBatchBinhdr);
  printResult(encodeBatchBinhdrStats);

  const batchEncodeCurrentOverhead = encodeBatchNoCodec.medianNs / encodeBatchMaster.medianNs;
  const batchEncodeBinhdrOverhead = encodeBatchBinhdr.medianNs / encodeBatchMaster.medianNs;
  const batchEncodeBinhdrStatsOverhead = encodeBatchBinhdrStats.medianNs / encodeBatchMaster.medianNs;
  console.log(`\nOverhead vs master baseline:`);
  console.log(`  Current (no codec): ${((batchEncodeCurrentOverhead - 1) * 100).toFixed(1)}% (${batchEncodeCurrentOverhead.toFixed(2)}x)`);
  console.log(`  Current (binhdr):   ${((batchEncodeBinhdrOverhead - 1) * 100).toFixed(1)}% (${batchEncodeBinhdrOverhead.toFixed(2)}x)`);
  console.log(`  Current (binhdr+stats): ${((batchEncodeBinhdrStatsOverhead - 1) * 100).toFixed(1)}% (${batchEncodeBinhdrStatsOverhead.toFixed(2)}x)\n`);

  console.log(`DECODE BATCH (${BATCH_SIZE} +OK responses)`);
  console.log('-'.repeat(60));

  const decodeBatchMaster = runDecodeBatchBenchmark('Master (baseline)', wrapMasterQueue, batchCommands, plainBatchResp);
  const decodeBatchNoCodec = runDecodeBatchBenchmark('Current (no codec)', wrapQueue, batchCommands, plainBatchResp);
  const decodeBatchBinhdr = runDecodeBatchBenchmark('Current (binhdr)', wrapQueueWithBinhdr, batchCommands, binhdrBatchResp);
  const decodeBatchBinhdrStats = runDecodeBatchBenchmark('Current (binhdr+stats)', wrapQueueWithBinhdrAndStats, batchCommands, binhdrBatchResp);

  printResult(decodeBatchMaster);
  printResult(decodeBatchNoCodec);
  printResult(decodeBatchBinhdr);
  printResult(decodeBatchBinhdrStats);

  const batchDecodeCurrentOverhead = decodeBatchNoCodec.medianNs / decodeBatchMaster.medianNs;
  const batchDecodeBinhdrOverhead = decodeBatchBinhdr.medianNs / decodeBatchMaster.medianNs;
  const batchDecodeBinhdrStatsOverhead = decodeBatchBinhdrStats.medianNs / decodeBatchMaster.medianNs;
  console.log(`\nOverhead vs master baseline:`);
  console.log(`  Current (no codec): ${((batchDecodeCurrentOverhead - 1) * 100).toFixed(1)}% (${batchDecodeCurrentOverhead.toFixed(2)}x)`);
  console.log(`  Current (binhdr):   ${((batchDecodeBinhdrOverhead - 1) * 100).toFixed(1)}% (${batchDecodeBinhdrOverhead.toFixed(2)}x)`);
  console.log(`  Current (binhdr+stats): ${((batchDecodeBinhdrStatsOverhead - 1) * 100).toFixed(1)}% (${batchDecodeBinhdrStatsOverhead.toFixed(2)}x)\n`);

  // Summary
  console.log('='.repeat(60));
  console.log('SUMMARY (overhead vs master baseline)');
  console.log('='.repeat(60));
  console.log('Single command:');
  console.log(`  Encode - no codec: ${((encodeCurrentOverhead - 1) * 100).toFixed(1)}%, binhdr: ${((encodeBinhdrOverhead - 1) * 100).toFixed(1)}%, binhdr+stats: ${((encodeBinhdrStatsOverhead - 1) * 100).toFixed(1)}%`);
  console.log(`  Decode - no codec: ${((decodeCurrentOverhead - 1) * 100).toFixed(1)}%, binhdr: ${((decodeBinhdrOverhead - 1) * 100).toFixed(1)}%, binhdr+stats: ${((decodeBinhdrStatsOverhead - 1) * 100).toFixed(1)}%`);
  console.log('Batch (10 commands):');
  console.log(`  Encode - no codec: ${((batchEncodeCurrentOverhead - 1) * 100).toFixed(1)}%, binhdr: ${((batchEncodeBinhdrOverhead - 1) * 100).toFixed(1)}%, binhdr+stats: ${((batchEncodeBinhdrStatsOverhead - 1) * 100).toFixed(1)}%`);
  console.log(`  Decode - no codec: ${((batchDecodeCurrentOverhead - 1) * 100).toFixed(1)}%, binhdr: ${((batchDecodeBinhdrOverhead - 1) * 100).toFixed(1)}%, binhdr+stats: ${((batchDecodeBinhdrStatsOverhead - 1) * 100).toFixed(1)}%`);
}

main().catch(console.error);
