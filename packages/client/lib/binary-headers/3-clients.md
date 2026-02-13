```
<port 15723   --password "test123"   --ratio 1:0   -c 1   -t 3   -d 1024   --key-prefix "key_123456789A123456789A123456789A123456789A"   --key-minim>

> @redis/client@5.10.0 prememtier-bench
> tsc --build


> @redis/client@5.10.0 memtier-bench
> node dist/lib/binary-headers/memtier-bench.js --host redis-15723.aws-cluster-25422.cto.redislabs.com --port 15723 --password test123 --ratio 1:0 -c 1 -t 3 -d 1024 --key-prefix key_123456789A123456789A123456789A123456789A --key-minimum 1 --key-maximum 1000000 --test-time 10 --mode all --bulk-size 10 --pipeline 40 --profile --npm-client-version 5.10.0

Installing @redis/client@5.10.0...

added 2 packages, and audited 3 packages in 1s

found 0 vulnerabilities
Installed @redis/client@5.10.0
Verified @redis/client version: 5.10.0

═══════════════════════════════════════════════════════════════════
  Memtier-like Benchmark for node-redis
═══════════════════════════════════════════════════════════════════
Host: redis-15723.aws-cluster-25422.cto.redislabs.com:15723
Client (fast-headers-off): @redis/client@5.10.0 (npm)
Client (fast-headers-on): local source (../client)
Threads (-t): 3 child processes (memtier-compatible)
Connections per thread (-c): 1
Total connections: 3
Ratio (SET:GET): 1:0
Data size: 1024 bytes
Pipeline: 40 (commands in flight per connection)
Bulk size: 10 (commands per binary header)
Bulk slots: 16384
Key range: 1-1000000 (prefix: "key_123456789A123456789A123456789A123456789A")
Test time: 10s
Mode: all
Interval: 1s

══════════════════════════════════════════════════════════════════════
  MODE: fast-headers-on (binary headers enabled)
  Threads (-t): 3 child processes (memtier-compatible parallelism)
  Connections per thread (-c): 1
  Total connections: 3
  Pipeline depth: 40 commands in flight
  Bulk size: 10 commands per binary header
══════════════════════════════════════════════════════════════════════
Spawning 3 child processes (memtier -t equivalent)...
All 3 child processes ready. Starting benchmark...
[1s] SET: 74.14K ops/s p50=1.25ms p99=5.59ms | GET: 0 ops/s p50=0ns p99=0ns
[2s] SET: 104.78K ops/s p50=1.07ms p99=2.61ms | GET: 0 ops/s p50=0ns p99=0ns
[3s] SET: 108.81K ops/s p50=1.06ms p99=2.09ms | GET: 0 ops/s p50=0ns p99=0ns
[4s] SET: 105.62K ops/s p50=1.06ms p99=2.51ms | GET: 0 ops/s p50=0ns p99=0ns
[5s] SET: 109.48K ops/s p50=1.05ms p99=2.22ms | GET: 0 ops/s p50=0ns p99=0ns
[6s] SET: 111.61K ops/s p50=1.05ms p99=1.92ms | GET: 0 ops/s p50=0ns p99=0ns
[7s] SET: 109.86K ops/s p50=1.04ms p99=2.42ms | GET: 0 ops/s p50=0ns p99=0ns
[8s] SET: 114.27K ops/s p50=1.02ms p99=1.83ms | GET: 0 ops/s p50=0ns p99=0ns
[9s] SET: 115.67K ops/s p50=1.01ms p99=1.83ms | GET: 0 ops/s p50=0ns p99=0ns

All child processes finished.

────────────────────────────────────────────────────────────────────
SUMMARY
────────────────────────────────────────────────────────────────────
Type           ops/sec         p50         p95         p99       p99.9
SET            106.99K      1.05ms      1.73ms      2.64ms      5.28ms
GET                  0         0ns         0ns         0ns         0ns
Total          106.99K      1.05ms      1.73ms      2.64ms      5.28ms

──────────────────────────────────────────────────────────────────────
BINARY HEADERS STATS
──────────────────────────────────────────────────────────────────────
Commands:
  Total                    1.07M    Batched                1.07M
  Passthrough                  9    Ineligible                 9

Batching Efficiency:
  Batch Rate              100.0%    Avg Batch Size         10.00
  Total Batches          107.05K    Ineligible Rate         0.0%

Flush Reasons:
  Reason                   Count      Percentage
  Slot Mismatch                0            0.0%
  Max Commands                 0            0.0%
  Max Payload                  0            0.0%
  Timer Expired                3            0.0%
  Drain                  107.04K          100.0%
  ─                 ────────────    ────────────
  Total Flushes          107.05K          100.0%
Using cached @redis/client@5.10.0
Verified @redis/client version: 5.10.0

══════════════════════════════════════════════════════════════════════
  MODE: fast-headers-off
  Threads (-t): 3 child processes (memtier-compatible parallelism)
  Connections per thread (-c): 1
  Total connections: 3
  Pipeline depth: 40 commands in flight
  Bulk size: 10 commands per binary header
══════════════════════════════════════════════════════════════════════
Spawning 3 child processes (memtier -t equivalent)...
Using cached @redis/client@5.10.0
Verified @redis/client version: 5.10.0
Using cached @redis/client@5.10.0
Verified @redis/client version: 5.10.0
Using cached @redis/client@5.10.0
Verified @redis/client version: 5.10.0
All 3 child processes ready. Starting benchmark...
[1s] SET:  93.10K ops/s p50=1.03ms p99=4.44ms | GET: 0 ops/s p50=0ns p99=0ns
[2s] SET: 122.83K ops/s p50=921.67µs p99=1.99ms | GET: 0 ops/s p50=0ns p99=0ns
[3s] SET: 122.10K ops/s p50=916.33µs p99=2.11ms | GET: 0 ops/s p50=0ns p99=0ns
[4s] SET: 122.52K ops/s p50=921.67µs p99=1.94ms | GET: 0 ops/s p50=0ns p99=0ns
[5s] SET: 127.02K ops/s p50=895.00µs p99=1.82ms | GET: 0 ops/s p50=0ns p99=0ns
[6s] SET: 127.21K ops/s p50=887.00µs p99=1.94ms | GET: 0 ops/s p50=0ns p99=0ns
[7s] SET: 131.53K ops/s p50=868.33µs p99=1.69ms | GET: 0 ops/s p50=0ns p99=0ns
[8s] SET: 130.57K ops/s p50=876.33µs p99=1.69ms | GET: 0 ops/s p50=0ns p99=0ns
[9s] SET: 130.57K ops/s p50=868.33µs p99=1.71ms | GET: 0 ops/s p50=0ns p99=0ns

All child processes finished.

────────────────────────────────────────────────────────────────────
SUMMARY
────────────────────────────────────────────────────────────────────
Type           ops/sec         p50         p95         p99       p99.9
SET            123.93K    895.00µs      1.46ms      2.16ms      4.13ms
GET                  0         0ns         0ns         0ns         0ns
Total          123.93K    895.00µs      1.46ms      2.16ms      4.13ms

══════════════════════════════════════════════════════════════════════
COMPARISON
══════════════════════════════════════════════════════════════════════
Mode                  Total ops/sec         p50         p99
fast-headers-on             106.99K      1.05ms      2.64ms
fast-headers-off            123.93K    895.00µs      2.16ms

════════════════════════════════════════════════════════════════════════════════════════════════════
  PROFILE COMPARISON
  OFF: baseline (npm 5.10.0)  |  ON: binary headers (dev)
════════════════════════════════════════════════════════════════════════════════════════════════════
        Diff          ON         OFF  Function                           Location
----------------------------------------------------------------------------------------------------
   +1316.4ms   1316.4ms      0.0ms  calculateSlotString                new-slot-calulator.js:24
    +278.7ms    278.7ms      0.0ms  calculateSlot                      new-slot-calulator.js:145
    +190.1ms    190.1ms      0.0ms  encodeCommandWithLength            encoder.js:24
    +167.9ms    515.2ms    347.3ms  commandsToWrite                    commands-queue.js:398
    -157.9ms   2865.3ms   3023.2ms  writevGeneric                      node:internal/stream_base_commons:120
    +124.9ms    124.9ms      0.0ms  intercept                          codec.js:38
    -121.7ms    700.6ms    822.3ms  (anonymous)                        :-1
    -102.0ms      0.0ms    102.0ms  encodeCommand                      encoder.js:3
     +77.9ms     77.9ms      0.0ms  getCommandUpper                    eligibility.js:25
     +66.2ms     66.2ms      0.0ms  #decode                            codec.js:88
     +62.1ms     62.1ms      0.0ms  getSlot                            eligibility.js:107
     -61.8ms    278.0ms    339.8ms  (anonymous)                        memtier-bench.js:764
     -60.1ms     66.5ms    126.6ms  execAsPipeline                     multi-command.js:95
     -56.6ms    377.6ms    434.2ms  write                              socket.js:248
     -50.7ms     74.5ms    125.2ms  getBucketIndex                     JsHistogram.js:218
     -48.2ms    101.7ms    150.0ms  #decodeSimpleString                decoder.js:337
     -46.6ms    286.2ms    332.7ms  runMicrotasks                      :-1
     -44.0ms    649.2ms    693.2ms  (program)                          :-1
     -41.2ms    259.7ms    300.9ms  #decodeTypeValue                   decoder.js:83
     -36.4ms    244.3ms    280.7ms  _executePipeline                   index.js:774
     +34.1ms    185.1ms    151.0ms  nextTick                           node:internal/process/task_queues:110
     +31.8ms     31.8ms      0.0ms  #flush                             packing.js:138
     -26.8ms     29.0ms     55.8ms  record                             memtier-bench.js:580
     +26.2ms    111.3ms     85.1ms  onStreamRead                       node:internal/stream_base_commons:165
     +23.6ms     67.9ms     44.3ms  subarray                           node:buffer:1203
     +23.4ms     23.4ms      0.0ms  #parseHeader                       codec.js:111
     +22.9ms     80.7ms     57.8ms  FastBuffer                         node:internal/buffer:955
     -20.5ms     19.1ms     39.6ms  emit                               node:events:454
     -20.3ms    177.4ms    197.7ms  utf8Slice                          :-1
     +19.9ms   2547.3ms   2527.4ms  writev                             :-1
  ... and 186 more functions with smaller differences
----------------------------------------------------------------------------------------------------
CPU Time Summary:
  ON:  binary headers (dev)           13.89ms / 1K ops  (1.07M total ops)
  OFF: baseline (npm 5.10.0)          10.70ms / 1K ops  (1.24M total ops)
  ─────────────────────────────────────────────
  Difference (ON - OFF):             +3.19ms / 1K ops (+29.8%)
════════════════════════════════════════════════════════════════════════════════════════════════════
Cleaning up cached @redis/client@5.10.0...

Done.
ubuntu@ip-10-0-101-115:~/node-redis/packages/client$
```
