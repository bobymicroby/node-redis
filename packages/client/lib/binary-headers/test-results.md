```
> @redis/client@5.10.0 memtier-bench
> node dist/lib/binary-headers/memtier-bench.js --host redis-15723.aws-cluster-25422.cto.redislabs.com --port 15723 --password test123 --ratio 1:0 -c 4 -t 4 -d 1024 --key-prefix key_123456789A123456789A123456789A123456789A --key-minimum 1 --key-maximum 1000000 --test-time 10 --mode all --bulk-size 10 --pipeline 40 --profile --npm-client-version 5.10.0

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
Threads (-t): 4 child processes (memtier-compatible)
Connections per thread (-c): 4
Total connections: 16
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
  Threads (-t): 4 child processes (memtier-compatible parallelism)
  Connections per thread (-c): 4
  Total connections: 16
  Pipeline depth: 40 commands in flight
  Bulk size: 10 commands per binary header
══════════════════════════════════════════════════════════════════════
Spawning 4 child processes (memtier -t equivalent)...
All 4 child processes ready. Starting benchmark...
[1s] SET: 74.54K ops/s p50=7.25ms p99=29.50ms | GET: 0 ops/s p50=0ns p99=0ns
[2s] SET: 116.29K ops/s p50=4.99ms p99=14.00ms | GET: 0 ops/s p50=0ns p99=0ns
[3s] SET: 124.92K ops/s p50=4.53ms p99=13.82ms | GET: 0 ops/s p50=0ns p99=0ns
[4s] SET: 126.99K ops/s p50=4.69ms p99=11.23ms | GET: 0 ops/s p50=0ns p99=0ns
[5s] SET: 131.97K ops/s p50=4.46ms p99=11.21ms | GET: 0 ops/s p50=0ns p99=0ns
[6s] SET: 128.56K ops/s p50=4.50ms p99=10.89ms | GET: 0 ops/s p50=0ns p99=0ns
[7s] SET: 135.70K ops/s p50=4.41ms p99=10.45ms | GET: 0 ops/s p50=0ns p99=0ns
[8s] SET: 133.78K ops/s p50=4.38ms p99=10.43ms | GET: 0 ops/s p50=0ns p99=0ns
[9s] SET: 137.33K ops/s p50=4.36ms p99=10.02ms | GET: 0 ops/s p50=0ns p99=0ns

All child processes finished.

────────────────────────────────────────────────────────────────────
SUMMARY
────────────────────────────────────────────────────────────────────
Type           ops/sec         p50         p95         p99       p99.9
SET            124.24K      4.61ms      9.21ms     14.14ms     26.37ms
GET                  0         0ns         0ns         0ns         0ns
Total          124.24K      4.61ms      9.21ms     14.14ms     26.37ms

──────────────────────────────────────────────────────────────────────
BINARY HEADERS STATS
──────────────────────────────────────────────────────────────────────
Commands:
  Total                    1.24M    Batched                1.24M
  Passthrough                 48    Ineligible                48

Batching Efficiency:
  Batch Rate              100.0%    Avg Batch Size         10.00
  Total Batches          124.32K    Ineligible Rate         0.0%

Flush Reasons:
  Reason                   Count      Percentage
  Slot Mismatch                0            0.0%
  Max Commands                 0            0.0%
  Max Payload                  0            0.0%
  Timer Expired               16            0.0%
  Drain                  124.31K          100.0%
  ─                 ────────────    ────────────
  Total Flushes          124.32K          100.0%
Using cached @redis/client@5.10.0
Verified @redis/client version: 5.10.0

══════════════════════════════════════════════════════════════════════
  MODE: fast-headers-off
  Threads (-t): 4 child processes (memtier-compatible parallelism)
  Connections per thread (-c): 4
  Total connections: 16
  Pipeline depth: 40 commands in flight
  Bulk size: 10 commands per binary header
══════════════════════════════════════════════════════════════════════
Spawning 4 child processes (memtier -t equivalent)...
Using cached @redis/client@5.10.0
Verified @redis/client version: 5.10.0
Using cached @redis/client@5.10.0
Verified @redis/client version: 5.10.0
Using cached @redis/client@5.10.0
Verified @redis/client version: 5.10.0
Using cached @redis/client@5.10.0
Verified @redis/client version: 5.10.0
All 4 child processes ready. Starting benchmark...
[1s] SET:  99.22K ops/s p50=5.24ms p99=26.11ms | GET: 0 ops/s p50=0ns p99=0ns
[2s] SET: 158.56K ops/s p50=3.96ms p99= 9.13ms | GET: 0 ops/s p50=0ns p99=0ns
[3s] SET: 165.00K ops/s p50=3.92ms p99= 7.71ms | GET: 0 ops/s p50=0ns p99=0ns
[4s] SET: 155.38K ops/s p50=3.95ms p99=10.19ms | GET: 0 ops/s p50=0ns p99=0ns
[5s] SET: 161.14K ops/s p50=3.98ms p99= 7.78ms | GET: 0 ops/s p50=0ns p99=0ns
[6s] SET: 162.87K ops/s p50=3.96ms p99= 8.38ms | GET: 0 ops/s p50=0ns p99=0ns
[7s] SET: 166.50K ops/s p50=3.87ms p99= 7.39ms | GET: 0 ops/s p50=0ns p99=0ns
[8s] SET: 167.35K ops/s p50=3.94ms p99= 6.81ms | GET: 0 ops/s p50=0ns p99=0ns
[9s] SET: 165.37K ops/s p50=3.91ms p99= 7.81ms | GET: 0 ops/s p50=0ns p99=0ns

All child processes finished.

────────────────────────────────────────────────────────────────────
SUMMARY
────────────────────────────────────────────────────────────────────
Type           ops/sec         p50         p95         p99       p99.9
SET            155.63K      3.97ms      6.85ms     10.56ms     21.89ms
GET                  0         0ns         0ns         0ns         0ns
Total          155.63K      3.97ms      6.85ms     10.56ms     21.89ms

══════════════════════════════════════════════════════════════════════
COMPARISON
══════════════════════════════════════════════════════════════════════
Mode                  Total ops/sec         p50         p99
fast-headers-on             124.24K      4.61ms     14.14ms
fast-headers-off            155.63K      3.97ms     10.56ms

════════════════════════════════════════════════════════════════════════════════════════════════════
  PROFILE COMPARISON
  OFF: baseline (npm 5.10.0)  |  ON: binary headers (dev)
════════════════════════════════════════════════════════════════════════════════════════════════════
        Diff          ON         OFF  Function                           Location
----------------------------------------------------------------------------------------------------
   +4477.6ms   4477.6ms      0.0ms  calculateSlotString                new-slot-calulator.js:24
   -2839.2ms   8584.5ms  11423.7ms  writevGeneric                      node:internal/stream_base_commons:120
   -1959.7ms   6040.7ms   8000.4ms  writev                             :-1
   -1096.3ms   2214.9ms   3311.2ms  (anonymous)                        :-1
    +863.0ms    863.0ms      0.0ms  calculateSlot                      new-slot-calulator.js:145
    -740.3ms   1115.9ms   1856.3ms  write                              socket.js:248
    +591.2ms    591.2ms      0.0ms  encodeCommandWithLength            encoder.js:24
    -436.9ms      0.0ms    436.9ms  encodeCommand                      encoder.js:3
    +385.4ms    385.4ms      0.0ms  intercept                          codec.js:38
    -301.1ms   1679.0ms   1980.2ms  commandsToWrite                    commands-queue.js:398
    +266.8ms    266.8ms      0.0ms  getCommandUpper                    eligibility.js:25
    +216.7ms    785.9ms    569.2ms  (program)                          :-1
    +209.4ms    975.5ms    766.1ms  runMicrotasks                      :-1
    +170.7ms    170.7ms      0.0ms  #decode                            codec.js:88
    +158.0ms    456.8ms    298.8ms  #onReply                           commands-queue.js:137
    +125.2ms    125.2ms      0.0ms  getSlot                            eligibility.js:107
    +109.8ms    270.9ms    161.1ms  FastBuffer                         node:internal/buffer:955
    +108.4ms    502.7ms    394.3ms  utf8Slice                          :-1
     +99.2ms     99.2ms      0.0ms  #flush                             packing.js:138
     +61.9ms    184.8ms    122.9ms  recordSingleValue                  JsHistogram.js:173
     -60.1ms     23.6ms     83.6ms  shift                              linked-list.js:194
     -60.0ms    151.8ms    211.8ms  _write                             node:internal/streams/writable:450
     +59.9ms    324.1ms    264.2ms  (anonymous)                        index.js:778
     +59.5ms    438.8ms    379.3ms  nextTick                           node:internal/process/task_queues:110
     +51.7ms    298.9ms    247.2ms  #decodeSimpleString                decoder.js:337
     +51.2ms    472.1ms    420.9ms  attachConfig                       commander.js:7
     +50.3ms    264.6ms    214.2ms  getBucketIndex                     JsHistogram.js:218
     +49.5ms    183.4ms    133.8ms  write                              decoder.js:56
     -48.6ms    738.2ms    786.8ms  (anonymous)                        memtier-bench.js:1117
     +45.4ms     45.4ms      0.0ms  #parseHeader                       codec.js:111
  ... and 212 more functions with smaller differences
----------------------------------------------------------------------------------------------------
CPU Time Summary:
  ON:  binary headers (dev)           32.28ms / 1K ops  (1.24M total ops)
  OFF: baseline (npm 5.10.0)          25.27ms / 1K ops  (1.56M total ops)
  ─────────────────────────────────────────────
  Difference (ON - OFF):             +7.02ms / 1K ops (+27.8%)
════════════════════════════════════════════════════════════════════════════════════════════════════
Cleaning up cached @redis/client@5.10.0...

Done.
ubuntu@ip-10-0-101-115:~/node-redis/packages/client$
```
