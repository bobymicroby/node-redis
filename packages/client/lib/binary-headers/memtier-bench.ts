/**
 * Memtier-like load testing tool for node-redis.
 *
 * Replicates memtier_benchmark behavior:
 *   - pipeline: Number of commands "in flight" (sent, waiting for response)
 *   - bulk-size: Number of commands grouped under one binary header (for fast-headers mode)
 *
 * Unlike batching with Promise.all(), true pipelining maintains a constant
 * number of in-flight commands by issuing a new command each time a response arrives.
 *
 * Modes:
 *   1. current      - node-redis client without binary headers
 *   2. fast-headers - node-redis client with binary headers enabled
 *   3. all          - Run both modes sequentially for comparison
 *
 * Usage:
 *   npx ts-node packages/client/lib/binary-headers/memtier-bench.ts [options]
 *
 * Examples:
 *   --mode current --test-time 5
 *   --mode fast-headers --pipeline 10
 *   --mode all --pipeline 10 -c 4 --test-time 30
 */

import { parseArgs } from 'node:util';
import RedisClient from '../client';
import { RedisClientType } from '../client';
import { BinaryHeaderStats } from './stats';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

type ModeName = 'current' | 'fast-headers';

interface BenchConfig {
  host: string;
  port: number;
  connections: number;
  ratioSet: number;
  ratioGet: number;
  dataSize: number;
  pipeline: number;
  bulkSize: number;
  bulkSlots: number;
  keyMinimum: number;
  keyMaximum: number;
  keyPrefix: string;
  testTime: number;
  mode: 'current' | 'fast-headers' | 'all';
  interval: number;
}

function parseConfig(): BenchConfig {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', short: 's', default: '127.0.0.1' },
      port: { type: 'string', short: 'p', default: '6379' },
      connections: { type: 'string', short: 'c', default: '4' },
      ratio: { type: 'string', default: '1:1' },
      'data-size': { type: 'string', short: 'd', default: '32' },
      pipeline: { type: 'string', default: '1' },
      'bulk-size': { type: 'string', default: '1' },
      'bulk-slots': { type: 'string', default: '16384' },
      'key-minimum': { type: 'string', default: '1' },
      'key-maximum': { type: 'string', default: '1000000' },
      'key-prefix': { type: 'string', default: 'memtier-' },
      'test-time': { type: 'string', default: '60' },
      mode: { type: 'string', default: 'all' },
      interval: { type: 'string', default: '1' },
    },
    strict: true,
  });

  const [ratioSetStr, ratioGetStr] = (values.ratio as string).split(':');
  const ratioSet = parseInt(ratioSetStr, 10);
  const ratioGet = parseInt(ratioGetStr, 10);

  const config: BenchConfig = {
    host: values.host as string,
    port: parseInt(values.port as string, 10),
    connections: parseInt(values.connections as string, 10),
    ratioSet,
    ratioGet,
    dataSize: parseInt(values['data-size'] as string, 10),
    pipeline: parseInt(values.pipeline as string, 10),
    bulkSize: parseInt(values['bulk-size'] as string, 10),
    bulkSlots: parseInt(values['bulk-slots'] as string, 10),
    keyMinimum: parseInt(values['key-minimum'] as string, 10),
    keyMaximum: parseInt(values['key-maximum'] as string, 10),
    keyPrefix: values['key-prefix'] as string,
    testTime: parseInt(values['test-time'] as string, 10),
    mode: values.mode as BenchConfig['mode'],
    interval: parseInt(values.interval as string, 10),
  };

  // Validation
  if (!['current', 'fast-headers', 'all'].includes(config.mode)) {
    throw new Error(`Invalid mode: ${config.mode}. Must be current, fast-headers, or all`);
  }
  if (config.pipeline < 1) {
    throw new Error(`pipeline must be >= 1`);
  }
  if (config.bulkSize < 1) {
    throw new Error(`bulk-size must be >= 1`);
  }
  if (config.pipeline < config.bulkSize) {
    throw new Error(`pipeline (${config.pipeline}) must be >= bulk-size (${config.bulkSize})`);
  }

  // Validate key range for bulk mode (same as memtier)
  if (config.bulkSize > 1) {
    const keysPerSlot = Math.floor((config.keyMaximum - config.keyMinimum + 1) / config.bulkSlots);
    if (keysPerSlot < config.bulkSize) {
      throw new Error(
        `Not enough keys per slot: (key-maximum - key-minimum + 1) / bulk-slots = ${keysPerSlot}, ` +
        `must be >= bulk-size (${config.bulkSize})`
      );
    }
  }

  return config;
}

// ============================================================================
// Key Generator (matches memtier's bulk key generation algorithm)
// ============================================================================

class BulkKeyGenerator {
  readonly #prefix: string;
  readonly #bulkSize: number;
  readonly #bulkSlots: number;
  readonly #keyMin: number;
  readonly #keysPerSlot: number;

  #commandCount = 0;
  #bulkNumber = 0;
  #initialSlotId: number;
  #initialKeySuffix: number;

  constructor(
    prefix: string,
    bulkSize: number,
    bulkSlots: number,
    keyMin: number,
    keyMax: number
  ) {
    this.#prefix = prefix;
    this.#bulkSize = bulkSize;
    this.#bulkSlots = bulkSlots;
    this.#keyMin = keyMin;
    this.#keysPerSlot = Math.floor((keyMax - keyMin + 1) / bulkSlots);

    // Random starting points (like memtier's randomize_bulk_initial_values)
    this.#initialSlotId = Math.floor(Math.random() * bulkSlots);
    this.#initialKeySuffix = Math.floor(Math.random() * this.#keysPerSlot);
  }

  nextKey(): string {
    // Always use {slot_id}:key_suffix format for fast-header protocol (including bulk-size=1)
    // This matches memtier's behavior where bulk key format is used regardless of bulk_size
    const posInBulk = this.#commandCount % this.#bulkSize;
    if (posInBulk === 0 && this.#commandCount > 0) {
      this.#bulkNumber++;
    }

    // slot_id cycles through bulk_slots, one per bulk
    const slotId = (this.#initialSlotId + this.#bulkNumber) % this.#bulkSlots;

    // key_suffix continues sequentially across all bulks
    const keySuffix = (this.#initialKeySuffix + this.#commandCount) % this.#keysPerSlot;

    this.#commandCount++;

    // Key format: {slot_id}:key_suffix - hash tag ensures same slot
    return `${this.#prefix}{${slotId}}:${this.#keyMin + keySuffix}`;
  }
}

// ============================================================================
// Latency Tracking
// ============================================================================

class LatencyHistogram {
  #values: bigint[] = [];

  record(elapsedNs: bigint): void {
    this.#values.push(elapsedNs);
  }

  reset(): bigint[] {
    const vals = this.#values;
    this.#values = [];
    return vals;
  }

  get count(): number {
    return this.#values.length;
  }
}

interface StatsSummary {
  ops: number;
  p50: number;
  p95: number;
  p99: number;
  p999: number;
}

function percentile(sorted: bigint[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return Number(sorted[idx]);
}

function computeSummary(values: bigint[], durationSeconds: number): StatsSummary {
  const sorted = values.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    ops: values.length / durationSeconds,
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    p999: percentile(sorted, 0.999),
  };
}

class MemtierStats {
  readonly #setHist = new LatencyHistogram();
  readonly #getHist = new LatencyHistogram();
  #errorCount = 0;
  #intervalErrors = 0;

  // Keep all values for final summary
  #allSetValues: bigint[] = [];
  #allGetValues: bigint[] = [];

  record(isSet: boolean, elapsedNs: bigint): void {
    if (isSet) {
      this.#setHist.record(elapsedNs);
      this.#allSetValues.push(elapsedNs);
    } else {
      this.#getHist.record(elapsedNs);
      this.#allGetValues.push(elapsedNs);
    }
  }

  recordError(): void {
    this.#errorCount++;
    this.#intervalErrors++;
  }

  snapshotInterval(intervalSeconds: number): { set: StatsSummary; get: StatsSummary; errors: number } {
    const setVals = this.#setHist.reset();
    const getVals = this.#getHist.reset();
    const errors = this.#intervalErrors;
    this.#intervalErrors = 0;

    return {
      set: computeSummary(setVals, intervalSeconds),
      get: computeSummary(getVals, intervalSeconds),
      errors,
    };
  }

  finalSummary(totalDurationSeconds: number): {
    set: StatsSummary;
    get: StatsSummary;
    total: StatsSummary;
    totalErrors: number;
  } {
    const setVals = this.#allSetValues;
    const getVals = this.#allGetValues;
    const allValues = [...setVals, ...getVals];

    return {
      set: computeSummary(setVals, totalDurationSeconds),
      get: computeSummary(getVals, totalDurationSeconds),
      total: computeSummary(allValues, totalDurationSeconds),
      totalErrors: this.#errorCount,
    };
  }
}

// ============================================================================
// Client Wrapper
// ============================================================================

type AnyRedisClient = RedisClientType<any, any, any, any, any>;

interface BenchClient {
  readonly client: AnyRedisClient;
  readonly binaryHeaders: boolean;
  disconnect(): Promise<void>;
}

async function createBenchClient(
  host: string,
  port: number,
  binaryHeaders: boolean
): Promise<BenchClient> {
  const client = RedisClient.create({
    socket: {
      host,
      port,
      connectTimeout: 10000,
      reconnectStrategy: false,
    },
    disableOfflineQueue: true,
    commandOptions: {
      timeout: 30000,
    },
    ...(binaryHeaders ? { binaryHeaders: { enabled: true, 'stats-collector': 'enabled' } } : {}),
  });

  client.on('error', () => {
    // Suppress connection errors during benchmark
  });

  await client.connect();

  // Probe with PING to verify connection works
  // For binary headers mode, use a timeout since unsupported servers will hang
  const probeTimeout = binaryHeaders ? 3000 : 10000;
  try {
    await Promise.race([
      client.sendCommand(['PING']),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(
          binaryHeaders
            ? 'PING timed out - server likely does not support binary headers'
            : 'PING timed out - server not responding'
        )), probeTimeout)
      ),
    ]);
  } catch (err) {
    client.destroy();
    throw err;
  }

  return {
    client: client as AnyRedisClient,
    binaryHeaders,
    async disconnect() {
      try {
        await client.quit();
      } catch {
        client.destroy();
      }
    },
  };
}

// ============================================================================
// Pipelining with Bulk Batching
// ============================================================================

/**
 * Pipelining loop that maintains pipeline depth and issues commands in bulk-size batches.
 *
 * This matches memtier_benchmark's behavior:
 * - pipeline: total number of commands "in flight" (sent, waiting for response)
 * - bulk-size: number of commands issued together (same slot, batched under one header)
 *
 * Key memtier behavior replicated:
 * 1. Each command is tracked individually (one request per command)
 * 2. Each response is processed individually (latency recorded when response arrives)
 * 3. Bulk is purely a transmission optimization (header groups commands)
 * 4. Latency = time from command sent to its response received (per command)
 *
 * Commands are issued synchronously in a for loop. Because node-redis uses
 * setImmediate to schedule writes, all commands issued beforeatches of bulk-size using client.multi().execAsPipeline().
 * This guarantees all commands in a bulk are written to the socket together,
 * enabling the binary headers interceptor to batch them under one header.
 *
 * When bulk-size responses arrive, another batch is issued to maintain pipeline depth.
 */
function runPipelinedConnection(
  client: AnyRedisClient,
  keyGen: BulkKeyGenerator,
  value: string,
  pipelineDepth: number,
  bulkSize: number,
  ratioSet: number,
  ratioGet: number,
  stats: MemtierStats,
  signal: AbortSignal,
  connId: number
): Promise<void> {
  return new Promise((resolve) => {
    const ratioTotal = ratioSet + ratioGet;
    let cmdIndex = 0;
    let inFlight = 0;
    let bulkResponseCount = 0;
    let resolved = false;
    let firstBatchLogged = false;

    /**
     * Issue a batch of bulk-size commands using multi().execAsPipeline().
     * This guarantees all commands are written to the socket in one batch,
     * enabling the binary headers interceptor to batch them under one header.
     */
    function issueBulk(): void {
      if (signal.aborted) {
        if (inFlight === 0 && !resolved) {
          resolved = true;
          resolve();
        }
        return;
      }

      // Build the bulk using multi() - this guarantees batching
      const multi = client.multi();
      const commandMeta: Array<{ isSet: boolean; start: bigint }> = [];
      const bulkStart = process.hrtime.bigint();

      for (let i = 0; i < bulkSize; i++) {
        const key = keyGen.nextKey();
        const isSet = (cmdIndex % ratioTotal) < ratioSet;
        cmdIndex++;
        inFlight++;

        commandMeta.push({ isSet, start: bulkStart });

        // Use addCommand to add raw commands to the multi
        if (isSet) {
          multi.addCommand(['SET', key, value]);
        } else {
          multi.addCommand(['GET', key]);
        }
      }

      // Execute as pipeline - this writes all commands in one batch
      multi.execAsPipeline()
        .then(() => {
          // Record latency for each command in the bulk
          const elapsed = process.hrtime.bigint() - bulkStart;
          for (const meta of commandMeta) {
            stats.record(meta.isSet, elapsed);
          }
        })
        .catch(() => {
          // Record errors for each command in the bulk
          for (let i = 0; i < commandMeta.length; i++) {
            stats.recordError();
          }
        })
        .finally(() => {
          inFlight -= bulkSize;
          bulkResponseCount += bulkSize;

          if (!firstBatchLogged && cmdIndex >= pipelineDepth) {
            console.log(`  [conn ${connId}] pipeline filled: ${pipelineDepth} commands, bulk-size=${bulkSize}`);
            firstBatchLogged = true;
          }

          // When bulk-size responses received, issue another bulk to maintain pipeline
          if (bulkResponseCount >= bulkSize) {
            bulkResponseCount = 0;
            if (!signal.aborted && inFlight < pipelineDepth) {
              issueBulk();
            }
          }

          // Resolve when all done
          if (signal.aborted && inFlight === 0 && !resolved) {
            resolved = true;
            resolve();
          }
        });
    }

    // Fill the pipeline initially with (pipeline / bulk-size) batches
    const initialBulks = Math.ceil(pipelineDepth / bulkSize);
    for (let i = 0; i < initialBulks; i++) {
      issueBulk();
    }

    // Handle abort signal if no commands were issued
    signal.addEventListener('abort', () => {
      if (inFlight === 0 && !resolved) {
        resolved = true;
        resolve();
      }
    });
  });
}

// ============================================================================
// Reporter
// ============================================================================

function formatNs(ns: number): string {
  if (ns >= 1_000_000) return (ns / 1_000_000).toFixed(2) + 'ms';
  if (ns >= 1_000) return (ns / 1_000).toFixed(2) + 'µs';
  return ns.toFixed(0) + 'ns';
}

function formatOps(ops: number): string {
  if (ops >= 1_000_000) return (ops / 1_000_000).toFixed(2) + 'M';
  if (ops >= 1_000) return (ops / 1_000).toFixed(2) + 'K';
  return ops.toFixed(0);
}

function printIntervalStats(
  seconds: number,
  snapshot: { set: StatsSummary; get: StatsSummary; errors: number }
): void {
  const { set, get, errors } = snapshot;
  const errStr = errors > 0 ? `  ERR: ${errors}` : '';
  console.log(
    `[${seconds}s]  ` +
    `SET: ${formatOps(set.ops).padStart(8)} ops/sec  p50=${formatNs(set.p50).padStart(10)}  p99=${formatNs(set.p99).padStart(10)}  |  ` +
    `GET: ${formatOps(get.ops).padStart(8)} ops/sec  p50=${formatNs(get.p50).padStart(10)}  p99=${formatNs(get.p99).padStart(10)}` +
    errStr
  );
}

function printFinalSummary(
  summary: { set: StatsSummary; get: StatsSummary; total: StatsSummary; totalErrors: number }
): void {
  console.log('\n────────────────────────────────────────────────────────────────────');
  console.log('SUMMARY');
  console.log('────────────────────────────────────────────────────────────────────');
  console.log(
    'Type'.padEnd(10) +
    'ops/sec'.padStart(12) +
    'p50'.padStart(12) +
    'p95'.padStart(12) +
    'p99'.padStart(12) +
    'p99.9'.padStart(12)
  );

  for (const [label, s] of [
    ['SET', summary.set],
    ['GET', summary.get],
    ['Total', summary.total],
  ] as const) {
    console.log(
      label.padEnd(10) +
      formatOps(s.ops).padStart(12) +
      formatNs(s.p50).padStart(12) +
      formatNs(s.p95).padStart(12) +
      formatNs(s.p99).padStart(12) +
      formatNs(s.p999).padStart(12)
    );
  }

  if (summary.totalErrors > 0) {
    console.log(`\nTotal errors: ${summary.totalErrors}`);
  }
}

function printBinaryHeaderStats(bhStats: BinaryHeaderStats): void {
  console.log(
    `\nBinary Header Stats:  ` +
    `batchRate=${(bhStats.batchRate() * 100).toFixed(1)}%  ` +
    `avgBatchSize=${bhStats.averageBatchSize().toFixed(1)}  ` +
    `batches=${bhStats.batchCount}  ` +
    `flushReasons: slot=${bhStats.slotMismatchFlushCount} ` +
    `max-cmd=${bhStats.maxCommandsFlushCount} ` +
    `max-payload=${bhStats.maxPayloadFlushCount} ` +
    `timer=${bhStats.timerFlushCount} ` +
    `drain=${bhStats.drainFlushCount}`
  );
}

interface ModeResult {
  mode: string;
  summary: { set: StatsSummary; get: StatsSummary; total: StatsSummary };
}

function printComparison(results: ModeResult[]): void {
  console.log('\n' + '═'.repeat(70));
  console.log('COMPARISON');
  console.log('═'.repeat(70));
  console.log(
    'Mode'.padEnd(20) +
    'Total ops/sec'.padStart(15) +
    'p50'.padStart(12) +
    'p99'.padStart(12)
  );

  for (const r of results) {
    console.log(
      r.mode.padEnd(20) +
      formatOps(r.summary.total.ops).padStart(15) +
      formatNs(r.summary.total.p50).padStart(12) +
      formatNs(r.summary.total.p99).padStart(12)
    );
  }
}

// ============================================================================
// Run a Single Mode
// ============================================================================

async function runMode(
  mode: ModeName,
  config: BenchConfig
): Promise<ModeResult | null> {
  const binaryHeaders = mode === 'fast-headers';

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  MODE: ${mode}${binaryHeaders ? ' (binary headers enabled)' : ''}`);
  console.log(`  Pipeline depth: ${config.pipeline} commands in flight`);
  if (config.bulkSize > 1) {
    console.log(`  Bulk size: ${config.bulkSize} commands per binary header`);
  }
  console.log(`${'═'.repeat(70)}`);

  // Create connections
  console.log(`Creating ${config.connections} connections...`);
  const clients: BenchClient[] = [];
  try {
    for (let i = 0; i < config.connections; i++) {
      const client = await createBenchClient(config.host, config.port, binaryHeaders);
      clients.push(client);
    }
  } catch (err) {
    console.error(`\n  FAILED to create connections for mode "${mode}": ${(err as Error).message}`);
    console.error(`  Skipping this mode.\n`);
    for (const c of clients) {
      try { await c.disconnect(); } catch {}
    }
    return null;
  }
  console.log(`All ${config.connections} connections ready. Starting benchmark...`);

  const stats = new MemtierStats();
  const value = 'x'.repeat(config.dataSize);

  // Abort controller for signaling end of test
  const ac = new AbortController();

  // Start connection loops with bulk-aware pipelining
  const loopPromises = clients.map((benchClient, i) => {
    const keyGen = new BulkKeyGenerator(
      config.keyPrefix,
      config.bulkSize,
      config.bulkSlots,
      config.keyMinimum,
      config.keyMaximum
    );
    return runPipelinedConnection(
      benchClient.client,
      keyGen,
      value,
      config.pipeline,
      config.bulkSize,
      config.ratioSet,
      config.ratioGet,
      stats,
      ac.signal,
      i
    );
  });

  // Periodic reporting
  const startTime = Date.now();
  let intervalCount = 0;

  const intervalTimer = setInterval(() => {
    intervalCount++;
    const snapshot = stats.snapshotInterval(config.interval);
    printIntervalStats(intervalCount * config.interval, snapshot);
  }, config.interval * 1000);

  // Wait for test duration
  await new Promise<void>((resolve) =>
    setTimeout(() => resolve(), config.testTime * 1000)
  );

  // Signal all loops to stop
  console.log(`\nTest time elapsed. Stopping loops...`);
  ac.abort();

  // Wait for in-flight commands to complete
  console.log(`Waiting for in-flight commands...`);
  await Promise.allSettled(loopPromises);
  console.log(`All loops stopped.`);

  clearInterval(intervalTimer);

  const totalDurationS = (Date.now() - startTime) / 1000;
  const summary = stats.finalSummary(totalDurationS);
  printFinalSummary(summary);

  // Report binary header stats for fast-headers mode
  if (binaryHeaders) {
    let aggregated: BinaryHeaderStats | undefined;
    for (const c of clients) {
      const s = (c.client as any).binaryHeaderStats;
      if (s) {
        aggregated = aggregated ? aggregated.plus(s) : s;
      }
    }
    if (aggregated) {
      printBinaryHeaderStats(aggregated);
    }
  }

  // Disconnect all clients
  for (const client of clients) {
    try {
      await client.disconnect();
    } catch {
      // ignore disconnect errors
    }
  }

  return { mode, summary };
}

// ============================================================================
// Main Orchestrator
// ============================================================================

async function main(): Promise<void> {
  const config = parseConfig();

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Memtier-like Benchmark for node-redis');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`Host: ${config.host}:${config.port}`);
  console.log(`Connections: ${config.connections}`);
  console.log(`Ratio (SET:GET): ${config.ratioSet}:${config.ratioGet}`);
  console.log(`Data size: ${config.dataSize} bytes`);
  console.log(`Pipeline: ${config.pipeline} (commands in flight per connection)`);
  console.log(`Bulk size: ${config.bulkSize} (commands per binary header)`);
  if (config.bulkSize > 1) {
    console.log(`Bulk slots: ${config.bulkSlots}`);
  }
  console.log(`Key range: ${config.keyMinimum}-${config.keyMaximum} (prefix: "${config.keyPrefix}")`);
  console.log(`Test time: ${config.testTime}s`);
  console.log(`Mode: ${config.mode}`);
  console.log(`Interval: ${config.interval}s`);

  const modes: ModeName[] =
    config.mode === 'all'
      ? ['current', 'fast-headers']
      : [config.mode as ModeName];

  const results: ModeResult[] = [];

  for (const mode of modes) {
    const result = await runMode(mode, config);
    if (result) results.push(result);
  }

  if (results.length > 1) {
    printComparison(results);
  }

  console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
