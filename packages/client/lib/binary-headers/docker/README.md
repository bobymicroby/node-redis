# memtier-bench Docker Image

A containerized version of the memtier-like benchmark tool for node-redis.

## Building the Image

### Using the build script

```bash
./packages/client/lib/binary-headers/docker/build.sh

# Or with a custom tag
./packages/client/lib/binary-headers/docker/build.sh memtier-bench:local
```

### Using docker build directly

```bash
# From the repository root
docker build \
  -f packages/client/lib/binary-headers/docker/Dockerfile \
  -t memtier-bench \
  .
```

## Usage

All CLI arguments are passed directly to the benchmark tool after `docker run`:

```bash
# Basic benchmark against a Redis server
docker run --rm memtier-bench \
  --host redis.example.com \
  --port 6379 \
  --mode all \
  --test-time 30

# With authentication
docker run --rm memtier-bench \
  --host redis.example.com \
  --port 6379 \
  -u myuser \
  -a mypassword \
  --mode fast-headers-on
```

## Connecting to Redis

### Redis in Docker (same network)

```bash
# Create a network
docker network create redis-net

# Start Redis
docker run -d --name redis --network redis-net redis:latest

# Run benchmark
docker run --rm --network redis-net memtier-bench \
  --host redis \
  --port 6379 \
  --mode all
```

### Redis on localhost

**Linux (using host networking):**
```bash
docker run --rm --network host memtier-bench \
  --host 127.0.0.1 \
  --port 6379 \
  --mode all
```

**macOS / Windows (using special DNS name):**
```bash
docker run --rm memtier-bench \
  --host host.docker.internal \
  --port 6379 \
  --mode all
```

### Redis Cluster (OSS Cluster)

```bash
docker run --rm memtier-bench \
  --host node1.example.com \
  --port 6379 \
  --mode oss-cluster \
  --npm-oss-cluster \
  --npm-client-version 5.1.1 \
  --oss-node node1.example.com:6379 \
  --oss-node node2.example.com:6380 \
  --oss-node node3.example.com:6381
```

## CLI Arguments Reference

| Argument | Short | Default | Description |
|----------|-------|---------|-------------|
| `--host` | `-s` | `127.0.0.1` | Redis server hostname |
| `--port` | `-p` | `6379` | Redis server port |
| `--threads` | `-t` | `1` | Number of worker processes |
| `--connections` | `-c` | `4` | Connections per thread |
| `--ratio` | | `1:1` | SET:GET ratio |
| `--data-size` | `-d` | `32` | Value size in bytes |
| `--pipeline` | | `1` | Commands in flight per connection |
| `--bulk-size` | | `1` | Commands per binary header |
| `--bulk-slots` | | `16384` | Number of slots for bulk mode |
| `--key-minimum` | | `1` | Minimum key suffix |
| `--key-maximum` | | `1000000` | Maximum key suffix |
| `--key-prefix` | | `memtier-` | Key name prefix |
| `--test-time` | | `60` | Test duration in seconds |
| `--mode` | | `all` | Benchmark mode (see below) |
| `--interval` | | `1` | Stats reporting interval (seconds) |
| `--hide-histogram` | | `false` | Hide histogram output |
| `--profile` | | `false` | Enable CPU profiling |
| `--username` | `-u` | | Redis username |
| `--password` | `-a` | | Redis password |
| `--npm-client-version` | | | Use specific npm client version for comparison |
| `--npm-oss-cluster` | | `false` | Use OSS cluster mode |
| `--oss-node` | | | OSS cluster node (host:port, can be repeated) |
| `--bh-timer-disabled` | | `false` | Disable binary headers timer |
| `--bh-max-wait-time` | | | Max wait time for binary headers (ms) |
| `--bh-max-command-count` | | | Max commands per batch |
| `--bh-max-payload-length` | | | Max payload length per batch |

### Benchmark Modes

| Mode | Description |
|------|-------------|
| `fast-headers-off` | Standard node-redis client without binary headers |
| `fast-headers-on` | node-redis client with binary headers enabled |
| `oss-cluster` | OSS cluster mode (requires `--npm-oss-cluster`) |
| `all` | Run all applicable modes and compare |

## Examples

### High-throughput test

```bash
docker run --rm memtier-bench \
  --host redis.example.com \
  --port 6379 \
  --threads 4 \
  --connections 50 \
  --pipeline 100 \
  --test-time 60 \
  --mode all
```

### Compare binary headers performance

```bash
docker run --rm memtier-bench \
  --host redis.example.com \
  --port 6379 \
  --mode all \
  --test-time 30 \
  --bulk-size 10 \
  --pipeline 100
```

### Custom SET:GET ratio

```bash
docker run --rm memtier-bench \
  --host redis.example.com \
  --port 6379 \
  --ratio 1:10 \
  --mode fast-headers-on
```
