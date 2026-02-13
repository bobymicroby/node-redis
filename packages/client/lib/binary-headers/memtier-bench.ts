/**
 * Memtier-like load testing tool for node-redis.
 *
 * Replicates memtier_benchmark behavior:
 *   - pipeline: Number of commands "in flight" (sent, waiting for response)
 *   - bulk-size: Number of commands grouped under one binary header (for fast-headers mode)
 *   - threads (-t): Number of parallel child processes (for memtier CLI compatibility)
 *
 * Unlike batching with Promise.all(), true pipelining maintains a constant
 * number of in-flight commands by issuing a new command each time a response arrives.
 *
 * Multi-Process Architecture:
 *   Node.js is single-threaded, so to match memtier's -t (threads) behavior, we use
 *   child processes instead. Each "thread" is actually a separate Node.js process
 *   with its own event loop, similar to how memtier uses pthreads with libevent.
 *   The -t flag is named for memtier CLI compatibility.
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
 *   --mode all --pipeline 10 -c 4 -t 4 --test-time 30
 */

import { parseArgs } from 'node:util';
import { fork, ChildProcess, execSync } from 'node:child_process';
import { build as buildHistogram, Histogram, encodeIntoCompressedBase64, decodeFromCompressedBase64 } from 'hdr-histogram-js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as inspector from 'node:inspector';
import { createTimeoutScheduler } from './packing';

// CPU Profiler - saves .cpuprofile with custom names
let profilerSession: inspector.Session | null = null;
let currentProfileMode: string | null = null;

function startCpuProfiler(modeName: string): void {
  profilerSession = new inspector.Session();
  profilerSession.connect();
  profilerSession.post('Profiler.enable');
  profilerSession.post('Profiler.start');
  currentProfileMode = modeName;
}

interface ProfileResult {
  path: string;
  profile: inspector.Profiler.Profile;
}

function stopCpuProfiler(saveToFile: boolean = true): Promise<ProfileResult | null> {
  return new Promise((resolve) => {
    if (!profilerSession || !currentProfileMode) {
      resolve(null);
      return;
    }
    const modeName = currentProfileMode;
    profilerSession.post('Profiler.stop', (err, { profile }) => {
      if (err) {
        console.error('Failed to stop profiler:', err);
        resolve(null);
        return;
      }
      profilerSession!.disconnect();
      profilerSession = null;
      currentProfileMode = null;

      let fullPath = '';
      if (saveToFile) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const tmpDir = path.resolve(__dirname, '..', '..', 'tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        const filename = `memtier-${modeName}-${timestamp}.cpuprofile`;
        fullPath = path.join(tmpDir, filename);
        fs.writeFileSync(fullPath, JSON.stringify(profile));
      }
      resolve({ path: fullPath, profile });
    });
  });
}

interface FunctionTime {
  name: string;
  url: string;
  line: number;
  selfTime: number;
}

/**
 * Normalize a URL/path to a consistent relative path for comparison.
 * This allows matching functions from local source vs npm package.
 *
 * Examples:
 *   /Users/.../node-redis/packages/client/dist/lib/client/commands-queue.js -> client/commands-queue.js
 *   /Users/.../.cache/memtier-bench/5.10.0/node_modules/@redis/client/dist/lib/client/commands-queue.js -> client/commands-queue.js
 *   node:internal/streams/readable -> node:internal/streams/readable (unchanged)
 */
function normalizeProfileUrl(url: string): string {
  if (!url || url.startsWith('node:') || url === '(native)') {
    return url;
  }

  // Look for common path segments that indicate the start of the relative path
  // Try to extract from: .../dist/lib/... or .../lib/...
  const distLibMatch = url.match(/dist\/lib\/(.+)$/);
  if (distLibMatch) {
    return distLibMatch[1];
  }

  const libMatch = url.match(/\/lib\/(.+)$/);
  if (libMatch) {
    return libMatch[1];
  }

  // For node_modules paths, extract package-relative path
  const nodeModulesMatch = url.match(/node_modules\/@redis\/client\/(.+)$/);
  if (nodeModulesMatch) {
    return nodeModulesMatch[1];
  }

  // Fallback: just use the filename
  const lastSlash = url.lastIndexOf('/');
  return lastSlash >= 0 ? url.slice(lastSlash + 1) : url;
}

function extractFunctionTimes(profile: inspector.Profiler.Profile): Map<string, FunctionTime> {
  const result = new Map<string, FunctionTime>();
  const samples = profile.samples || [];
  const timeDeltas = profile.timeDeltas || [];
  const nodeMap = new Map<number, inspector.Profiler.ProfileNode>();

  for (const node of profile.nodes) {
    nodeMap.set(node.id, node);
  }

  for (let i = 0; i < samples.length; i++) {
    const nodeId = samples[i];
    const delta = timeDeltas[i] || 0;
    const node = nodeMap.get(nodeId);
    if (!node) continue;

    const cf = node.callFrame;
    const normalizedUrl = normalizeProfileUrl(cf.url);
    // Don't include line number in key - it differs between versions
    const key = `${cf.functionName || '(anonymous)'}@${normalizedUrl}`;

    const existing = result.get(key);
    if (existing) {
      existing.selfTime += delta;
    } else {
      result.set(key, {
        name: cf.functionName || '(anonymous)',
        url: normalizedUrl,
        line: cf.lineNumber,
        selfTime: delta,
      });
    }
  }

  return result;
}

function mergeProfiles(profiles: inspector.Profiler.Profile[]): inspector.Profiler.Profile {
  if (profiles.length === 1) return profiles[0];

  // We can't simply concatenate samples because each profile has its own node IDs.
  // Instead, we need to extract function times from each profile separately and then
  // create a synthetic merged profile with unified node IDs.

  // First, extract and aggregate times from all profiles
  const aggregatedTimes = new Map<string, FunctionTime>();

  for (const profile of profiles) {
    const times = extractFunctionTimes(profile);
    for (const [key, fn] of times) {
      const existing = aggregatedTimes.get(key);
      if (existing) {
        existing.selfTime += fn.selfTime;
      } else {
        aggregatedTimes.set(key, { ...fn });
      }
    }
  }

  // Create synthetic nodes with new unified IDs
  const nodes: inspector.Profiler.ProfileNode[] = [];
  const samples: number[] = [];
  const timeDeltas: number[] = [];

  let nodeId = 1;
  for (const [, fn] of aggregatedTimes) {
    nodes.push({
      id: nodeId,
      callFrame: {
        functionName: fn.name,
        scriptId: '0',
        url: fn.url,
        lineNumber: fn.line,
        columnNumber: 0,
      },
      hitCount: 1,
      children: [],
    });
    // Add a single sample with the total time for this function
    samples.push(nodeId);
    timeDeltas.push(fn.selfTime);
    nodeId++;
  }

  return {
    nodes,
    startTime: Math.min(...profiles.map(p => p.startTime)),
    endTime: Math.max(...profiles.map(p => p.endTime)),
    samples,
    timeDeltas,
  };
}

interface ProfileOpsData {
  onTotalOps: number;
  offTotalOps: number;
}

function compareProfiles(
  offProfile: inspector.Profiler.Profile,
  onProfile: inspector.Profiler.Profile,
  npmClientVersion?: string,
  opsData?: ProfileOpsData
): void {
  const offTimes = extractFunctionTimes(offProfile);
  const onTimes = extractFunctionTimes(onProfile);

  // Calculate total active time (excluding idle)
  let offTotal = 0;
  let onTotal = 0;
  for (const [key, fn] of offTimes) {
    if (!key.includes('(idle)')) offTotal += fn.selfTime;
  }
  for (const [key, fn] of onTimes) {
    if (!key.includes('(idle)')) onTotal += fn.selfTime;
  }

  // Collect all functions from both profiles
  const allKeys = new Set<string>();
  for (const key of onTimes.keys()) allKeys.add(key);
  for (const key of offTimes.keys()) allKeys.add(key);

  // Build diffs for all functions
  const diffs: Array<{
    fn: FunctionTime;
    offTime: number | null;
    onTime: number | null;
    diff: number;
  }> = [];

  for (const key of allKeys) {
    if (key.includes('(idle)') || key.includes('(garbage collector)')) continue;

    const onFn = onTimes.get(key);
    const offFn = offTimes.get(key);

    const onTime = onFn?.selfTime ?? null;
    const offTime = offFn?.selfTime ?? null;

    // Calculate diff (treat null as 0 for calculation)
    const diff = (onTime ?? 0) - (offTime ?? 0);

    // Skip negligible diffs
    if (Math.abs(diff) < 100) continue; // Less than 0.1ms

    const fn = onFn || offFn!;
    diffs.push({ fn, offTime, onTime, diff });
  }

  // Sort by absolute diff descending
  diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  // Labels
  const offLabel = npmClientVersion ? `baseline (npm ${npmClientVersion})` : 'binary headers OFF';
  const onLabel = npmClientVersion ? 'binary headers (dev)' : 'binary headers ON';

  console.log('\n' + '═'.repeat(100));
  console.log('  PROFILE COMPARISON');
  console.log(`  OFF: ${offLabel}  |  ON: ${onLabel}`);
  console.log('═'.repeat(100));
  console.log(
    'Diff'.padStart(12) +
    'ON'.padStart(12) +
    'OFF'.padStart(12) +
    '  Function'.padEnd(35) +
    '  Location'
  );
  console.log('-'.repeat(100));

  const top = diffs.slice(0, 30);
  for (const { fn, offTime, onTime, diff } of top) {
    const shortUrl = fn.url
      .replace(/.*node_modules\//, '')
      .replace(/.*dist\//, '')
      .replace(/.*lib\//, '');
    const location = `${shortUrl}:${fn.line}`;

    // Format diff with sign
    const diffSign = diff >= 0 ? '+' : '';
    const diffStr = `${diffSign}${(diff / 1000).toFixed(1)}ms`.padStart(12);

    // Format ON time
    const onStr = ((onTime ?? 0) / 1000).toFixed(1).padStart(9) + 'ms';

    // Format OFF time
    const offStr = ((offTime ?? 0) / 1000).toFixed(1).padStart(9) + 'ms';

    console.log(
      diffStr +
      onStr +
      offStr +
      ('  ' + fn.name).slice(0, 35).padEnd(35) +
      '  ' + location.slice(0, 40)
    );
  }

  if (diffs.length > 30) {
    console.log(`  ... and ${diffs.length - 30} more functions with smaller differences`);
  }

  // Summary
  console.log('-'.repeat(100));
  console.log('CPU Time Summary:');

  if (opsData && opsData.onTotalOps > 0 && opsData.offTotalOps > 0) {
    // Normalized CPU time per 1K operations
    const onCpuPer1KOps = (onTotal / opsData.onTotalOps) * 1000;
    const offCpuPer1KOps = (offTotal / opsData.offTotalOps) * 1000;
    const cpuPerOpDiff = onCpuPer1KOps - offCpuPer1KOps;
    const cpuPerOpDiffSign = cpuPerOpDiff >= 0 ? '+' : '';
    const cpuPerOpPctDiff = offCpuPer1KOps > 0 ? ((cpuPerOpDiff) / offCpuPer1KOps * 100) : 0;
    const cpuPerOpPctSign = cpuPerOpPctDiff >= 0 ? '+' : '';

    console.log(`  ON:  ${onLabel.padEnd(30)} ${(onCpuPer1KOps / 1000).toFixed(2)}ms / 1K ops  (${formatTotalOps(opsData.onTotalOps)} total ops)`);
    console.log(`  OFF: ${offLabel.padEnd(30)} ${(offCpuPer1KOps / 1000).toFixed(2)}ms / 1K ops  (${formatTotalOps(opsData.offTotalOps)} total ops)`);
    console.log('  ' + '─'.repeat(45));
    console.log(`  Difference (ON - OFF):${' '.repeat(12)} ${cpuPerOpDiffSign}${(cpuPerOpDiff / 1000).toFixed(2)}ms / 1K ops (${cpuPerOpPctSign}${cpuPerOpPctDiff.toFixed(1)}%)`);
  } else {
    // Fallback to raw totals if ops data not available
    const totalDiff = (onTotal - offTotal) / 1000;
    const diffSign = totalDiff >= 0 ? '+' : '';
    const pctDiff = offTotal > 0 ? ((onTotal - offTotal) / offTotal * 100) : 0;
    const pctSign = pctDiff >= 0 ? '+' : '';

    console.log(`  ON:  ${onLabel.padEnd(30)} ${(onTotal / 1000).toFixed(1)}ms (total)`);
    console.log(`  OFF: ${offLabel.padEnd(30)} ${(offTotal / 1000).toFixed(1)}ms (total)`);
    console.log('  ' + '─'.repeat(45));
    console.log(`  Difference (ON - OFF):${' '.repeat(12)} ${diffSign}${totalDiff.toFixed(1)}ms (${pctSign}${pctDiff.toFixed(1)}%)`);
  }
  console.log('═'.repeat(100));
}

// Dynamic client import - will be set at runtime based on --npm-client-version
let RedisClient: any;
let BinaryHeaderStatsClass: any;

// Type alias for Redis client
type AnyRedisClient = any;

// Cache directory for npm client versions
const NPM_CACHE_DIR = path.join(os.homedir(), '.cache', 'memtier-bench');

/**
 * Initialize Redis client - either from local source or npm package
 */
function initializeRedisClient(npmVersion?: string): void {
  if (!npmVersion) {
    // Use local source with require (works with ts-node)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const localClient = require('../client');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const localStats = require('./stats');
    RedisClient = localClient.default;
    BinaryHeaderStatsClass = localStats.BinaryHeaderStats;
    return;
  }

  // Use npm version
  const versionDir = path.join(NPM_CACHE_DIR, npmVersion);
  const packageDir = path.join(versionDir, 'node_modules', '@redis', 'client');

  // Check if already installed
  if (!fs.existsSync(path.join(packageDir, 'package.json'))) {
    console.log(`Installing @redis/client@${npmVersion}...`);

    // Create cache directory
    fs.mkdirSync(versionDir, { recursive: true });

    // Create minimal package.json
    fs.writeFileSync(
      path.join(versionDir, 'package.json'),
      JSON.stringify({ name: 'memtier-bench-cache', version: '1.0.0', private: true }, null, 2)
    );

    // Install the specific version
    try {
      execSync(`npm install @redis/client@${npmVersion}`, {
        cwd: versionDir,
        stdio: 'inherit',
      });
    } catch (err) {
      throw new Error(`Failed to install @redis/client@${npmVersion}: ${(err as Error).message}`);
    }

    console.log(`Installed @redis/client@${npmVersion}`);
  } else {
    console.log(`Using cached @redis/client@${npmVersion}`);
  }

  // Verify the installed version matches what we requested
  const installedPackageJson = JSON.parse(
    fs.readFileSync(path.join(packageDir, 'package.json'), 'utf-8')
  );
  const installedVersion = installedPackageJson.version;
  if (installedVersion !== npmVersion) {
    throw new Error(
      `Version mismatch: requested @redis/client@${npmVersion} but found @${installedVersion}. ` +
      `Try deleting cache: rm -rf ~/.cache/memtier-bench/${npmVersion}`
    );
  }
  console.log(`Verified @redis/client version: ${installedVersion}`);

  // Dynamic require from the installed package
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const clientPath = path.join(packageDir, 'dist', 'lib', 'client', 'index.js');
  const clientModule = require(clientPath);
  RedisClient = clientModule.default;

  // Note: BinaryHeaderStatsClass may not exist in older versions
  try {
    const statsPath = path.join(packageDir, 'dist', 'lib', 'binary-headers', 'stats.js');
    if (fs.existsSync(statsPath)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const statsModule = require(statsPath);
      BinaryHeaderStatsClass = statsModule.BinaryHeaderStats;
    }
  } catch {
    // BinaryHeaderStatsClass not available in this version
    BinaryHeaderStatsClass = null;
  }
}

/**
 * Cleanup npm client cache
 */
function cleanupNpmCache(npmVersion?: string): void {
  if (!npmVersion) return;

  const versionDir = path.join(NPM_CACHE_DIR, npmVersion);
  if (fs.existsSync(versionDir)) {
    console.log(`Cleaning up cached @redis/client@${npmVersion}...`);
    fs.rmSync(versionDir, { recursive: true, force: true });
  }
}

// ============================================================================
// IPC Message Types for Multi-Process Support
// ============================================================================

interface WorkerConfig {
  type: 'config';
  workerId: number;
  mode: ModeName;
  config: BenchConfig;
  useNpmClient: boolean; // Whether this worker should use npm client (for fast-headers-off) or local source
}

interface IntervalStatsMessage {
  type: 'interval-stats';
  workerId: number;
  intervalSec: number;
  set: { count: number; p50: number; p99: number };
  get: { count: number; p50: number; p99: number };
  errors: number;
}

interface BinaryHeaderStatsData {
  totalCommandCount: number;
  batchedCommandCount: number;
  batchCount: number;
  ineligibleCount: number;
  slotMismatchFlushCount: number;
  maxCommandsFlushCount: number;
  maxPayloadFlushCount: number;
  timerFlushCount: number;
  drainFlushCount: number;
}

interface FinalStatsMessage {
  type: 'final-stats';
  workerId: number;
  durationSeconds: number;
  set: { count: number; p50: number; p95: number; p99: number; p999: number };
  get: { count: number; p50: number; p95: number; p99: number; p999: number };
  totalErrors: number;
  binaryHeaderStats?: BinaryHeaderStatsData;
  profileData?: string; // JSON-serialized inspector.Profiler.Profile
  // Encoded histogram data for proper percentile merging
  setHistogram?: string; // base64 encoded histogram
  getHistogram?: string; // base64 encoded histogram
}

interface WorkerReadyMessage {
  type: 'ready';
  workerId: number;
}

interface WorkerErrorMessage {
  type: 'error';
  workerId: number;
  message: string;
}

interface StartMessage {
  type: 'start';
}

interface StopMessage {
  type: 'stop';
}

type ParentToWorkerMessage = WorkerConfig | StartMessage | StopMessage;
type WorkerToParentMessage = WorkerReadyMessage | IntervalStatsMessage | FinalStatsMessage | WorkerErrorMessage;

// Store worker profiles for aggregation
const workerProfiles = new Map<string, inspector.Profiler.Profile[]>();

// Check if running as a worker process
const isWorkerProcess = process.env.MEMTIER_WORKER === '1';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

type ModeName = 'fast-headers-off' | 'fast-headers-on';

// Store profiles for comparison
const collectedProfiles = new Map<string, inspector.Profiler.Profile>();
const collectedProfilePaths: string[] = [];

interface BenchConfig {
  profile: boolean;
  host: string;
  port: number;
  threads: number;
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
  mode: 'fast-headers-off' | 'fast-headers-on' | 'all';
  interval: number;
  hideHistogram: boolean;
  username?: string;
  password?: string;
  npmClientVersion?: string;
  // Binary headers options
  binaryHeadersTimerDisabled?: boolean;
  binaryHeadersMaxWaitTime?: number;
  binaryHeadersMaxCommandCount?: number;
  binaryHeadersMaxPayloadLength?: number;
}

function parseConfig(): BenchConfig {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', short: 's', default: '127.0.0.1' },
      port: { type: 'string', short: 'p', default: '6379' },
      // Named 'threads' for memtier CLI compatibility, but uses child processes in Node.js
      threads: { type: 'string', short: 't', default: '1' },
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
      'hide-histogram': { type: 'boolean', default: false },
      'profile': { type: 'boolean', default: false },
      username: { type: 'string', short: 'u' },
      password: { type: 'string', short: 'a' },
      'npm-client-version': { type: 'string' },
      // Binary headers options
      'bh-timer-disabled': { type: 'boolean', default: false },
      'bh-max-wait-time': { type: 'string' },
      'bh-max-command-count': { type: 'string' },
      'bh-max-payload-length': { type: 'string' },
    },
    strict: true,
  });

  const [ratioSetStr, ratioGetStr] = (values.ratio as string).split(':');
  const ratioSet = parseInt(ratioSetStr, 10);
  const ratioGet = parseInt(ratioGetStr, 10);

  const config: BenchConfig = {
    profile: values.profile as boolean,
    host: values.host as string,
    port: parseInt(values.port as string, 10),
    threads: parseInt(values.threads as string, 10),
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
    hideHistogram: values['hide-histogram'] as boolean,
    username: values.username as string | undefined,
    password: values.password as string | undefined,
    npmClientVersion: values['npm-client-version'] as string | undefined,
    // Binary headers options (undefined means use defaults)
    binaryHeadersTimerDisabled: values['bh-timer-disabled'] as boolean,
    binaryHeadersMaxWaitTime: values['bh-max-wait-time'] ? parseInt(values['bh-max-wait-time'] as string, 10) : undefined,
    binaryHeadersMaxCommandCount: values['bh-max-command-count'] ? parseInt(values['bh-max-command-count'] as string, 10) : undefined,
    binaryHeadersMaxPayloadLength: values['bh-max-payload-length'] ? parseInt(values['bh-max-payload-length'] as string, 10) : undefined,
  };

  // Validation
  if (!['fast-headers-off', 'fast-headers-on', 'all'].includes(config.mode)) {
    throw new Error(`Invalid mode: ${config.mode}. Must be fast-headers-off, fast-headers-on, or all`);
  }
  if (config.threads < 1) {
    throw new Error(`threads (-t) must be >= 1 (note: uses child processes for parallelism)`);
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
// Latency Tracking (using HDR Histogram for memory-efficient percentile calculation)
// ============================================================================

/**
 * Creates a new HDR histogram configured for latency tracking.
 *
 * Configuration aligned with memtier_benchmark (see run_stats_types.h):
 * - lowestDiscernibleValue: 10 (microseconds) - LATENCY_HDR_MIN_VALUE
 * - highestTrackableValue: 600,000,000 (600 seconds in microseconds) - LATENCY_HDR_SEC_MAX_VALUE
 * - numberOfSignificantValueDigits: 2 (1% precision) - LATENCY_HDR_SEC_SIGDIGTS
 *
 * Note: memtier uses microseconds, so we convert from nanoseconds when recording.
 */
function createLatencyHistogram(): Histogram {
  return buildHistogram({
    lowestDiscernibleValue: 10,             // 10 microseconds (matches LATENCY_HDR_MIN_VALUE)
    highestTrackableValue: 600_000_000,     // 600 seconds in µs (matches LATENCY_HDR_SEC_MAX_VALUE)
    numberOfSignificantValueDigits: 2,      // 1% precision (matches LATENCY_HDR_SEC_SIGDIGTS)
  });
}

interface StatsSummary {
  ops: number;
  p50: number;
  p95: number;
  p99: number;
  p999: number;
}

function computeSummaryFromHistogram(histogram: Histogram, durationSeconds: number): StatsSummary {
  // Histogram stores values in microseconds, convert back to nanoseconds for display
  // (formatNs function expects nanoseconds)
  return {
    ops: histogram.totalCount / durationSeconds,
    p50: histogram.getValueAtPercentile(50) * 1000,   // µs -> ns
    p95: histogram.getValueAtPercentile(95) * 1000,   // µs -> ns
    p99: histogram.getValueAtPercentile(99) * 1000,   // µs -> ns
    p999: histogram.getValueAtPercentile(99.9) * 1000, // µs -> ns
  };
}

class MemtierStats {
  // Interval histograms (reset after each interval)
  readonly #setIntervalHist: Histogram = createLatencyHistogram();
  readonly #getIntervalHist: Histogram = createLatencyHistogram();

  // Cumulative histograms (for final summary)
  readonly #setTotalHist: Histogram = createLatencyHistogram();
  readonly #getTotalHist: Histogram = createLatencyHistogram();

  #errorCount = 0;
  #intervalErrors = 0;

  record(isSet: boolean, elapsedNs: bigint): void {
    // Convert from nanoseconds to microseconds to match memtier's histogram units
    // HDR histogram uses number, so convert from bigint
    const latencyUs = Number(elapsedNs / 1000n);

    if (isSet) {
      this.#setIntervalHist.recordValue(latencyUs);
      this.#setTotalHist.recordValue(latencyUs);
    } else {
      this.#getIntervalHist.recordValue(latencyUs);
      this.#getTotalHist.recordValue(latencyUs);
    }
  }

  recordError(): void {
    this.#errorCount++;
    this.#intervalErrors++;
  }

  snapshotInterval(intervalSeconds: number): { set: StatsSummary; get: StatsSummary; errors: number } {
    const result = {
      set: computeSummaryFromHistogram(this.#setIntervalHist, intervalSeconds),
      get: computeSummaryFromHistogram(this.#getIntervalHist, intervalSeconds),
      errors: this.#intervalErrors,
    };

    // Reset interval histograms and error count
    this.#setIntervalHist.reset();
    this.#getIntervalHist.reset();
    this.#intervalErrors = 0;

    return result;
  }

  finalSummary(totalDurationSeconds: number): {
    set: StatsSummary;
    get: StatsSummary;
    total: StatsSummary;
    totalErrors: number;
    totalOps: number;
  } {
    // Create a combined histogram for total stats
    const totalHist = createLatencyHistogram();
    totalHist.add(this.#setTotalHist);
    totalHist.add(this.#getTotalHist);

    return {
      set: computeSummaryFromHistogram(this.#setTotalHist, totalDurationSeconds),
      get: computeSummaryFromHistogram(this.#getTotalHist, totalDurationSeconds),
      total: computeSummaryFromHistogram(totalHist, totalDurationSeconds),
      totalErrors: this.#errorCount,
      totalOps: totalHist.totalCount,
    };
  }

  /**
   * Get base64-encoded histograms for sending to parent process
   */
  getEncodedHistograms(): { setHistogram: string; getHistogram: string } {
    return {
      setHistogram: encodeIntoCompressedBase64(this.#setTotalHist),
      getHistogram: encodeIntoCompressedBase64(this.#getTotalHist),
    };
  }
}

// ============================================================================
// Client Wrapper
// ============================================================================

// AnyRedisClient is defined at the top of the file

interface BenchClient {
  readonly client: AnyRedisClient;
  readonly binaryHeaders: boolean;
  disconnect(): Promise<void>;
}

interface BinaryHeadersClientOptions {
  timerDisabled?: boolean;
  maxWaitTime?: number;
  maxCommandCount?: number;
  maxPayloadLength?: number;
}

async function createBenchClient(
  host: string,
  port: number,
  binaryHeaders: boolean,
  username?: string,
  password?: string,
  bhOptions?: BinaryHeadersClientOptions
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
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(binaryHeaders ? {
      binaryHeaders: {
        enabled: true,
        'stats-collector': 'enabled',
        ...(bhOptions?.maxCommandCount !== undefined ? { maxCommandCount: bhOptions.maxCommandCount } : {}),
        ...(bhOptions?.maxPayloadLength !== undefined ? { maxPayloadLength: bhOptions.maxPayloadLength } : {}),
        ...(bhOptions?.timerDisabled ? { timer: false } : bhOptions?.maxWaitTime !== undefined ? { timer: { maxWaitTime: bhOptions.maxWaitTime, scheduler: createTimeoutScheduler() } } : {}),
      }
    } : {}),
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

function formatTotalOps(ops: number): string {
  if (ops >= 1_000_000) return (ops / 1_000_000).toFixed(2) + 'M';
  if (ops >= 1_000) return (ops / 1_000).toFixed(1) + 'K';
  return ops.toFixed(0);
}

// Track max column widths across interval stats calls
const intervalColWidths = {
  setOps: 0,
  setP50: 0,
  setP99: 0,
  getOps: 0,
  getP50: 0,
  getP99: 0,
};



function printIntervalStats(
  seconds: number,
  snapshot: { set: StatsSummary; get: StatsSummary; errors: number }
): void {
  const { set, get, errors } = snapshot;
  const errStr = errors > 0 ? `  ERR: ${errors}` : '';

  // Format values
  const setOps = formatOps(set.ops);
  const setP50 = formatNs(set.p50);
  const setP99 = formatNs(set.p99);
  const getOps = formatOps(get.ops);
  const getP50 = formatNs(get.p50);
  const getP99 = formatNs(get.p99);

  // Update max widths
  intervalColWidths.setOps = Math.max(intervalColWidths.setOps, setOps.length);
  intervalColWidths.setP50 = Math.max(intervalColWidths.setP50, setP50.length);
  intervalColWidths.setP99 = Math.max(intervalColWidths.setP99, setP99.length);
  intervalColWidths.getOps = Math.max(intervalColWidths.getOps, getOps.length);
  intervalColWidths.getP50 = Math.max(intervalColWidths.getP50, getP50.length);
  intervalColWidths.getP99 = Math.max(intervalColWidths.getP99, getP99.length);

  console.log(
    `[${seconds}s] ` +
    `SET: ${setOps.padStart(intervalColWidths.setOps)} ops/s p50=${setP50.padStart(intervalColWidths.setP50)} p99=${setP99.padStart(intervalColWidths.setP99)} | ` +
    `GET: ${getOps.padStart(intervalColWidths.getOps)} ops/s p50=${getP50.padStart(intervalColWidths.getP50)} p99=${getP99.padStart(intervalColWidths.getP99)}` +
    errStr
  );
}

function printFinalSummary(
  summary: { set: StatsSummary; get: StatsSummary; total: StatsSummary; totalErrors: number; totalOps?: number }
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

function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
  return n.toString();
}

function printBinaryHeaderStats(bhStats: any): void {
  const batchRate = bhStats.batchRate() * 100;
  const avgBatchSize = bhStats.averageBatchSize();
  const totalFlushes = bhStats.slotMismatchFlushCount + bhStats.maxCommandsFlushCount +
    bhStats.maxPayloadFlushCount + bhStats.timerFlushCount + bhStats.drainFlushCount;
  const passthroughCount = bhStats.totalCommandCount - bhStats.batchedCommandCount;
  const ineligibleRate = bhStats.totalCommandCount === 0
    ? 0
    : (bhStats.ineligibleCount / bhStats.totalCommandCount) * 100;

  console.log('\n' + '─'.repeat(70));
  console.log('BINARY HEADERS STATS');
  console.log('─'.repeat(70));

  // Commands summary
  console.log('Commands:');
  console.log(
    '  Total'.padEnd(20) +
    formatCount(bhStats.totalCommandCount).padStart(12) +
    '    ' +
    'Batched'.padEnd(16) +
    formatCount(bhStats.batchedCommandCount).padStart(12)
  );
  console.log(
    '  Passthrough'.padEnd(20) +
    formatCount(passthroughCount).padStart(12) +
    '    ' +
    'Ineligible'.padEnd(16) +
    formatCount(bhStats.ineligibleCount).padStart(12)
  );

  // Batching efficiency
  console.log('\nBatching Efficiency:');
  console.log(
    '  Batch Rate'.padEnd(20) +
    `${batchRate.toFixed(1)}%`.padStart(12) +
    '    ' +
    'Avg Batch Size'.padEnd(16) +
    avgBatchSize.toFixed(2).padStart(12)
  );
  console.log(
    '  Total Batches'.padEnd(20) +
    formatCount(bhStats.batchCount).padStart(12) +
    '    ' +
    'Ineligible Rate'.padEnd(16) +
    `${ineligibleRate.toFixed(1)}%`.padStart(12)
  );

  // Flush reasons breakdown
  console.log('\nFlush Reasons:');
  console.log(
    '  Reason'.padEnd(20) +
    'Count'.padStart(12) +
    '    ' +
    'Percentage'.padStart(12)
  );

  const flushReasons = [
    { name: 'Slot Mismatch', count: bhStats.slotMismatchFlushCount },
    { name: 'Max Commands', count: bhStats.maxCommandsFlushCount },
    { name: 'Max Payload', count: bhStats.maxPayloadFlushCount },
    { name: 'Timer Expired', count: bhStats.timerFlushCount },
    { name: 'Drain', count: bhStats.drainFlushCount },
  ];

  for (const reason of flushReasons) {
    const pct = totalFlushes === 0 ? 0 : (reason.count / totalFlushes) * 100;
    console.log(
      `  ${reason.name}`.padEnd(20) +
      formatCount(reason.count).padStart(12) +
      '    ' +
      `${pct.toFixed(1)}%`.padStart(12)
    );
  }

  console.log(
    '  ─'.padEnd(20) +
    '─'.repeat(12) +
    '    ' +
    '─'.repeat(12)
  );
  console.log(
    '  Total Flushes'.padEnd(20) +
    formatCount(totalFlushes).padStart(12) +
    '    ' +
    '100.0%'.padStart(12)
  );
}

interface ModeResult {
  mode: string;
  summary: { set: StatsSummary; get: StatsSummary; total: StatsSummary };
  totalOps: number; // Actual total operation count from histogram
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
  const binaryHeaders = mode === 'fast-headers-on';

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
      const client = await createBenchClient(
        config.host,
        config.port,
        binaryHeaders,
        config.username,
        config.password,
        {
          timerDisabled: config.binaryHeadersTimerDisabled,
          maxWaitTime: config.binaryHeadersMaxWaitTime,
          maxCommandCount: config.binaryHeadersMaxCommandCount,
          maxPayloadLength: config.binaryHeadersMaxPayloadLength,
        }
      );
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
    let aggregated: typeof BinaryHeaderStatsClass | undefined;
    for (const c of clients) {
      const clientOptions = (c.client as any).options;
      const s = clientOptions?.binaryHeaders?.getStats?.();
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

  return { mode, summary, totalOps: summary.totalOps };
}

// ============================================================================
// Worker Process Logic
// ============================================================================

async function runWorker(): Promise<void> {
  return new Promise((resolve, reject) => {
    let workerConfig: WorkerConfig | null = null;

    process.on('message', async (msg: ParentToWorkerMessage) => {
      if (msg.type === 'config') {
        workerConfig = msg;
        // Signal ready
        const readyMsg: WorkerReadyMessage = { type: 'ready', workerId: msg.workerId };
        process.send!(readyMsg);
      } else if (msg.type === 'start' && workerConfig) {
        try {
          await runWorkerBenchmark(workerConfig);
          resolve();
        } catch (err) {
          const errorMsg: WorkerErrorMessage = {
            type: 'error',
            workerId: workerConfig.workerId,
            message: (err as Error).message,
          };
          process.send!(errorMsg);
          reject(err);
        }
      } else if (msg.type === 'stop') {
        resolve();
      }
    });
  });
}

async function runWorkerBenchmark(workerConfig: WorkerConfig): Promise<void> {
  const { workerId, mode, config } = workerConfig;
  const binaryHeaders = mode === 'fast-headers-on';

  // Start profiler for this worker if enabled
  if (config.profile) {
    startCpuProfiler(mode);
  }

  // Create connections for this worker
  const clients: BenchClient[] = [];
  try {
    for (let i = 0; i < config.connections; i++) {
      const client = await createBenchClient(
        config.host,
        config.port,
        binaryHeaders,
        config.username,
        config.password,
        {
          timerDisabled: config.binaryHeadersTimerDisabled,
          maxWaitTime: config.binaryHeadersMaxWaitTime,
          maxCommandCount: config.binaryHeadersMaxCommandCount,
          maxPayloadLength: config.binaryHeadersMaxPayloadLength,
        }
      );
      clients.push(client);
    }
  } catch (err) {
    throw new Error(`Worker ${workerId}: Failed to create connections: ${(err as Error).message}`);
  }

  const stats = new MemtierStats();
  const value = 'x'.repeat(config.dataSize);
  const ac = new AbortController();

  // Start connection loops
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

  // Periodic stats reporting to parent
  const startTime = Date.now();
  let intervalCount = 0;

  const intervalTimer = setInterval(() => {
    intervalCount++;
    const snapshot = stats.snapshotInterval(config.interval);
    const msg: IntervalStatsMessage = {
      type: 'interval-stats',
      workerId,
      intervalSec: intervalCount * config.interval,
      set: { count: snapshot.set.ops * config.interval, p50: snapshot.set.p50, p99: snapshot.set.p99 },
      get: { count: snapshot.get.ops * config.interval, p50: snapshot.get.p50, p99: snapshot.get.p99 },
      errors: snapshot.errors,
    };
    process.send!(msg);
  }, config.interval * 1000);

  // Wait for test duration
  await new Promise<void>((resolve) =>
    setTimeout(() => resolve(), config.testTime * 1000)
  );

  // Stop loops
  ac.abort();
  await Promise.allSettled(loopPromises);
  clearInterval(intervalTimer);

  // Send final stats
  const totalDurationS = (Date.now() - startTime) / 1000;
  const summary = stats.finalSummary(totalDurationS);

  // Collect binary header stats if enabled
  let binaryHeaderStatsData: BinaryHeaderStatsData | undefined;
  if (binaryHeaders) {
    let aggregated: typeof BinaryHeaderStatsClass | undefined;
    for (const c of clients) {
      const clientOptions = (c.client as any).options;
      const s = clientOptions?.binaryHeaders?.getStats?.();
      if (s) {
        aggregated = aggregated ? aggregated.plus(s) : s;
      }
    }
    if (aggregated) {
      binaryHeaderStatsData = {
        totalCommandCount: aggregated.totalCommandCount,
        batchedCommandCount: aggregated.batchedCommandCount,
        batchCount: aggregated.batchCount,
        ineligibleCount: aggregated.ineligibleCount,
        slotMismatchFlushCount: aggregated.slotMismatchFlushCount,
        maxCommandsFlushCount: aggregated.maxCommandsFlushCount,
        maxPayloadFlushCount: aggregated.maxPayloadFlushCount,
        timerFlushCount: aggregated.timerFlushCount,
        drainFlushCount: aggregated.drainFlushCount,
      };
    }
  }

  // Stop profiler and include profile data in final message
  let profileData: string | undefined;
  if (config.profile) {
    const result = await stopCpuProfiler(false); // Don't save to file, send to parent
    if (result) {
      profileData = JSON.stringify(result.profile);
    }
  }

  // Get encoded histograms for proper percentile merging in parent
  const encodedHistograms = stats.getEncodedHistograms();

  const finalMsg: FinalStatsMessage = {
    type: 'final-stats',
    workerId,
    durationSeconds: totalDurationS,
    set: {
      count: summary.set.ops * totalDurationS,
      p50: summary.set.p50,
      p95: summary.set.p95,
      p99: summary.set.p99,
      p999: summary.set.p999,
    },
    get: {
      count: summary.get.ops * totalDurationS,
      p50: summary.get.p50,
      p95: summary.get.p95,
      p99: summary.get.p99,
      p999: summary.get.p999,
    },
    totalErrors: summary.totalErrors,
    binaryHeaderStats: binaryHeaderStatsData,
    profileData,
    setHistogram: encodedHistograms.setHistogram,
    getHistogram: encodedHistograms.getHistogram,
  };
  process.send!(finalMsg);

  // Cleanup
  for (const client of clients) {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
}

// ============================================================================
// Multi-Process Orchestration (Main Process)
// ============================================================================

async function runModeMultiProcess(
  mode: ModeName,
  config: BenchConfig
): Promise<ModeResult | null> {
  const binaryHeaders = mode === 'fast-headers-on';
  const numWorkers = config.threads;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  MODE: ${mode}${binaryHeaders ? ' (binary headers enabled)' : ''}`);
  console.log(`  Threads (-t): ${numWorkers} child processes (memtier-compatible parallelism)`);
  console.log(`  Connections per thread (-c): ${config.connections}`);
  console.log(`  Total connections: ${numWorkers * config.connections}`);
  console.log(`  Pipeline depth: ${config.pipeline} commands in flight`);
  if (config.bulkSize > 1) {
    console.log(`  Bulk size: ${config.bulkSize} commands per binary header`);
  }
  console.log(`${'═'.repeat(70)}`);

  // Spawn worker child processes (equivalent to memtier's pthreads)
  console.log(`Spawning ${numWorkers} child processes (memtier -t equivalent)...`);

  // Increase max listeners to avoid warnings when spawning many workers
  process.stderr.setMaxListeners(numWorkers + 10);
  process.stdout.setMaxListeners(numWorkers + 10);

  const workers: ChildProcess[] = [];
  const workerReady: Promise<void>[] = [];

  for (let i = 0; i < numWorkers; i++) {
    // When npmClientVersion is set, fast-headers-off uses npm, fast-headers-on uses local
    const useNpmForThisMode = config.npmClientVersion && mode === 'fast-headers-off';
    const worker = fork(__filename, [], {
      env: {
        ...process.env,
        MEMTIER_WORKER: '1',
        // Pass npm version to worker only if this mode should use npm client
        ...(useNpmForThisMode ? { MEMTIER_NPM_VERSION: config.npmClientVersion } : {}),
      },
      // Use 'inherit' for stdio to avoid piping issues with many workers
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    workers.push(worker);

    // Wait for worker ready
    workerReady.push(
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Worker ${i} timed out`)), 30000);

        worker.on('message', (msg: WorkerToParentMessage) => {
          if (msg.type === 'ready' && msg.workerId === i) {
            clearTimeout(timeout);
            resolve();
          }
        });

        worker.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        worker.on('exit', (code) => {
          if (code !== 0) {
            clearTimeout(timeout);
            reject(new Error(`Worker ${i} exited with code ${code}`));
          }
        });
      })
    );

    // Send config to worker
    const configMsg: WorkerConfig = {
      type: 'config',
      workerId: i,
      mode,
      config,
      useNpmClient: !!useNpmForThisMode,
    };
    worker.send(configMsg);
  }

  // Wait for all workers to be ready
  try {
    await Promise.all(workerReady);
  } catch (err) {
    console.error(`\n  FAILED to initialize workers: ${(err as Error).message}`);
    console.error(`  Skipping this mode.\n`);
    for (const w of workers) {
      w.kill();
    }
    return null;
  }

  console.log(`All ${numWorkers} child processes ready. Starting benchmark...`);

  // Collect interval stats from workers
  const intervalStats: Map<number, IntervalStatsMessage[]> = new Map();
  const finalStats: Map<number, FinalStatsMessage> = new Map();

  for (let i = 0; i < numWorkers; i++) {
    intervalStats.set(i, []);
  }

  // Setup message handlers for stats
  for (const worker of workers) {
    worker.on('message', (msg: WorkerToParentMessage) => {
      if (msg.type === 'interval-stats') {
        intervalStats.get(msg.workerId)?.push(msg);

        // Print aggregated interval stats when all workers have reported
        const currentInterval = msg.intervalSec;
        const allReported = Array.from(intervalStats.values()).every(
          (arr) => arr.some((s) => s.intervalSec === currentInterval)
        );

        if (allReported && !config.hideHistogram) {
          // Aggregate stats from all workers for this interval
          let setOps = 0, getOps = 0, errors = 0;
          let setP50Sum = 0, setP99Sum = 0, getP50Sum = 0, getP99Sum = 0;

          for (const arr of intervalStats.values()) {
            const stat = arr.find((s) => s.intervalSec === currentInterval);
            if (stat) {
              setOps += stat.set.count;
              getOps += stat.get.count;
              errors += stat.errors;
              setP50Sum += stat.set.p50;
              setP99Sum += stat.set.p99;
              getP50Sum += stat.get.p50;
              getP99Sum += stat.get.p99;
            }
          }

          const snapshot = {
            set: {
              ops: setOps / config.interval,
              p50: setP50Sum / numWorkers,
              p95: 0,
              p99: setP99Sum / numWorkers,
              p999: 0,
            },
            get: {
              ops: getOps / config.interval,
              p50: getP50Sum / numWorkers,
              p95: 0,
              p99: getP99Sum / numWorkers,
              p999: 0,
            },
            errors,
          };
          printIntervalStats(currentInterval, snapshot);
        }
      } else if (msg.type === 'final-stats') {
        finalStats.set(msg.workerId, msg);
        // Collect profile data from workers
        if (msg.profileData) {
          const profiles = workerProfiles.get(mode) || [];
          profiles.push(JSON.parse(msg.profileData));
          workerProfiles.set(mode, profiles);
        }
      } else if (msg.type === 'error') {
        console.error(`Worker ${msg.workerId} error: ${msg.message}`);
      }
    });
  }

  // Signal all workers to start
  const startMsg: StartMessage = { type: 'start' };
  for (const worker of workers) {
    worker.send(startMsg);
  }

  // Wait for all workers to finish
  await Promise.all(
    workers.map(
      (worker) =>
        new Promise<void>((resolve) => {
          worker.on('exit', () => resolve());
        })
    )
  );

  console.log(`\nAll child processes finished.`);

  // Aggregate final stats
  if (finalStats.size === 0) {
    console.error('No final stats received from workers');
    return null;
  }

  // Merge histograms from all workers for proper percentile calculation
  const mergedSetHist = createLatencyHistogram();
  const mergedGetHist = createLatencyHistogram();
  let totalDuration = 0;
  let setCount = 0;
  let getCount = 0;
  let totalErrors = 0;

  for (const stat of finalStats.values()) {
    totalDuration = Math.max(totalDuration, stat.durationSeconds);
    setCount += stat.set.count;
    getCount += stat.get.count;
    totalErrors += stat.totalErrors;

    // Decode and merge histograms
    if (stat.setHistogram) {
      const decoded = decodeFromCompressedBase64(stat.setHistogram);
      mergedSetHist.add(decoded);
    }
    if (stat.getHistogram) {
      const decoded = decodeFromCompressedBase64(stat.getHistogram);
      mergedGetHist.add(decoded);
    }
  }

  // Create combined histogram for total stats
  const mergedTotalHist = createLatencyHistogram();
  mergedTotalHist.add(mergedSetHist);
  mergedTotalHist.add(mergedGetHist);

  const totalOps = mergedTotalHist.totalCount;

  const summary = {
    set: computeSummaryFromHistogram(mergedSetHist, totalDuration),
    get: computeSummaryFromHistogram(mergedGetHist, totalDuration),
    total: computeSummaryFromHistogram(mergedTotalHist, totalDuration),
    totalErrors,
    totalOps,
  };

  printFinalSummary(summary);

  // Aggregate and print binary header stats if available
  if (binaryHeaders && BinaryHeaderStatsClass) {
    let aggregatedBhStats: BinaryHeaderStatsData | undefined;
    for (const stat of finalStats.values()) {
      if (stat.binaryHeaderStats) {
        if (!aggregatedBhStats) {
          aggregatedBhStats = { ...stat.binaryHeaderStats };
        } else {
          aggregatedBhStats.totalCommandCount += stat.binaryHeaderStats.totalCommandCount;
          aggregatedBhStats.batchedCommandCount += stat.binaryHeaderStats.batchedCommandCount;
          aggregatedBhStats.batchCount += stat.binaryHeaderStats.batchCount;
          aggregatedBhStats.ineligibleCount += stat.binaryHeaderStats.ineligibleCount;
          aggregatedBhStats.slotMismatchFlushCount += stat.binaryHeaderStats.slotMismatchFlushCount;
          aggregatedBhStats.maxCommandsFlushCount += stat.binaryHeaderStats.maxCommandsFlushCount;
          aggregatedBhStats.maxPayloadFlushCount += stat.binaryHeaderStats.maxPayloadFlushCount;
          aggregatedBhStats.timerFlushCount += stat.binaryHeaderStats.timerFlushCount;
          aggregatedBhStats.drainFlushCount += stat.binaryHeaderStats.drainFlushCount;
        }
      }
    }
    if (aggregatedBhStats) {
      // Create a stats-like object with the methods printBinaryHeaderStats expects
      const statsObj = {
        ...aggregatedBhStats,
        batchRate: () => aggregatedBhStats!.totalCommandCount === 0
          ? 1.0
          : aggregatedBhStats!.batchedCommandCount / aggregatedBhStats!.totalCommandCount,
        averageBatchSize: () => aggregatedBhStats!.batchCount === 0
          ? 0.0
          : aggregatedBhStats!.batchedCommandCount / aggregatedBhStats!.batchCount,
      };
      printBinaryHeaderStats(statsObj);
    }
  }

  return { mode, summary, totalOps };
}

// ============================================================================
// Main Orchestrator
// ============================================================================

async function main(): Promise<void> {
  const config = parseConfig();

  // Pre-install npm client if needed (so workers don't race to install)
  if (config.npmClientVersion) {
    initializeRedisClient(config.npmClientVersion);
    console.log(''); // blank line after npm install output
  }

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Memtier-like Benchmark for node-redis');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`Host: ${config.host}:${config.port}`);
  if (config.npmClientVersion) {
    console.log(`Client (fast-headers-off): @redis/client@${config.npmClientVersion} (npm)`);
    console.log(`Client (fast-headers-on): local source (../client)`);
  } else {
    console.log(`Client: local source (../client)`);
  }
  console.log(`Threads (-t): ${config.threads} child processes (memtier-compatible)`);
  console.log(`Connections per thread (-c): ${config.connections}`);
  console.log(`Total connections: ${config.threads * config.connections}`);
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
  if (config.hideHistogram) {
    console.log(`Hide histogram: true`);
  }

  const modes: ModeName[] =
    config.mode === 'all'
      ? ['fast-headers-on', 'fast-headers-off']
      : [config.mode as ModeName];

  const results: ModeResult[] = [];

  for (const mode of modes) {
    // When npmClientVersion is set: fast-headers-off uses npm, fast-headers-on uses local
    // Otherwise: both modes use local source
    if (config.npmClientVersion) {
      const useNpm = mode === 'fast-headers-off';
      initializeRedisClient(useNpm ? config.npmClientVersion : undefined);
    } else {
      initializeRedisClient(undefined);
    }

    if (config.profile) {
      startCpuProfiler(mode);
    }

    // Use multi-process mode if threads > 1, otherwise single-process
    const result = config.threads > 1
      ? await runModeMultiProcess(mode, config)
      : await runMode(mode, config);
    if (result) results.push(result);

    if (config.profile) {
      const result = await stopCpuProfiler();
      if (result) {
        collectedProfiles.set(mode, result.profile);
        collectedProfilePaths.push(result.path);
      }
    }
  }

  if (results.length > 1) {
    printComparison(results);
  }

  // Compare profiles if we have both modes (use worker profiles if available, otherwise main process)
  if (config.profile) {
    let offProfile: inspector.Profiler.Profile | undefined;
    let onProfile: inspector.Profiler.Profile | undefined;

    // Prefer worker profiles (multi-process mode)
    if (workerProfiles.has('fast-headers-off') && workerProfiles.get('fast-headers-off')!.length > 0) {
      offProfile = mergeProfiles(workerProfiles.get('fast-headers-off')!);
    } else if (collectedProfiles.has('fast-headers-off')) {
      offProfile = collectedProfiles.get('fast-headers-off');
    }

    if (workerProfiles.has('fast-headers-on') && workerProfiles.get('fast-headers-on')!.length > 0) {
      onProfile = mergeProfiles(workerProfiles.get('fast-headers-on')!);
    } else if (collectedProfiles.has('fast-headers-on')) {
      onProfile = collectedProfiles.get('fast-headers-on');
    }

    if (offProfile && onProfile) {
      // Get ops data from results for normalized comparison
      const onResult = results.find(r => r.mode === 'fast-headers-on');
      const offResult = results.find(r => r.mode === 'fast-headers-off');
      const opsData: ProfileOpsData | undefined = (onResult && offResult) ? {
        onTotalOps: onResult.totalOps,
        offTotalOps: offResult.totalOps,
      } : undefined;

      compareProfiles(offProfile, onProfile, config.npmClientVersion, opsData);
    }
  }

  // Clean up profile files
  for (const profilePath of collectedProfilePaths) {
    try {
      fs.unlinkSync(profilePath);
    } catch {
      // ignore
    }
  }

  // Cleanup npm cache if used
  cleanupNpmCache(config.npmClientVersion);

  console.log('\nDone.');
  process.exit(0);
}

// Entry point: detect if running as worker or main process
if (isWorkerProcess) {
  // Worker process: get npm version from env if set
  const workerNpmVersion = process.env.MEMTIER_NPM_VERSION || undefined;
  initializeRedisClient(workerNpmVersion);
  runWorker()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('Worker fatal error:', err);
      process.exit(1);
    });
} else {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
