# memtier-bench Usage

A memtier_benchmark-compatible load testing tool for node-redis.

## Setup

```bash
# Clone, install, and build (run once)
git clone https://github.com/redis/node-redis.git
cd node-redis
npm install
npm run build   # Generates binary header codecs and compiles TypeScript
```

## Quick Start

```bash
# Must run from project root (node-redis/)
npx ts-node packages/client/lib/binary-headers/memtier-bench.ts \
  -s <host> -p <port> -a <password> \
  -t 4 -c 10 --test-time 30 --mode all
```

## Key Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--host` | `-s` | Redis host | 127.0.0.1 |
| `--port` | `-p` | Redis port | 6379 |
| `--password` | `-a` | Redis password | - |
| `--threads` | `-t` | Child processes (memtier-compatible) | 1 |
| `--connections` | `-c` | Connections per thread | 4 |
| `--test-time` | | Test duration in seconds | 60 |
| `--mode` | | `fast-headers-on`, `fast-headers-off`, or `all` | all |
| `--pipeline` | | Commands in flight per connection | 1 |
| `--bulk-size` | | Commands per binary header | 1 |
| `--data-size` | `-d` | Value size in bytes | 32 |
| `--ratio` | | SET:GET ratio | 1:1 |
| `--npm-client-version` | | Use specific npm package version | local |
| `--hide-histogram` | | Hide per-second stats | false |

## Examples

### Compare fast-headers on vs off
```bash
npx ts-node memtier-bench.ts -s localhost -p 6379 \
  -t 4 -c 10 --test-time 10 --mode all
```

### SET-only benchmark with pipelining
```bash
npx ts-node memtier-bench.ts -s localhost -p 6379 \
  --ratio 1:0 --pipeline 10 --bulk-size 10 \
  -t 4 -c 4 --test-time 30 --mode fast-headers-on
```

### Test with specific npm client version
```bash
npx ts-node memtier-bench.ts -s localhost -p 6379 \
  --npm-client-version 5.10.0 --test-time 10 --mode fast-headers-off
```

### High concurrency (like memtier -t 50 -c 4)
```bash
npx ts-node memtier-bench.ts -s localhost -p 6379 \
  -t 50 -c 4 --pipeline 10 --test-time 60 --mode all
```

## CPU Profiling with 0x

To generate flamegraphs for debugging performance, use [0x](https://github.com/davidmarkclements/0x):

```bash
# Install 0x globally (one-time)
npm install -g 0x

# Profile fast-headers-off (baseline)
0x -- npx ts-node packages/client/lib/binary-headers/memtier-bench.ts \
  -s localhost -p 6379 --test-time 10 --mode fast-headers-off

# Profile fast-headers-on
0x -- npx ts-node packages/client/lib/binary-headers/memtier-bench.ts \
  -s localhost -p 6379 --test-time 10 --mode fast-headers-on
```

This generates a folder like `./12345.0x/` with an interactive HTML flamegraph.
Open `flamegraph.html` in your browser to analyze CPU hotspots.

**Tips for reading flamegraphs:**
- Width = time spent (wider = more time)
- Look for tall stacks unique to `fast-headers-on`
- Search for `packing`, `binary`, `header`, `encoder` to find binary headers code

## Notes

- `-t` uses **child processes** (not threads) for parallelism — named for memtier CLI compatibility
- Total connections = threads × connections per thread
- `--npm-client-version` installs, verifies, and cleans up after benchmark