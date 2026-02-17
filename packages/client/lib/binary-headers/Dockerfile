# Dockerfile for memtier-bench - Redis load testing tool for node-redis
#
# Build:
#   docker build -t memtier-bench -f packages/client/lib/binary-headers/Dockerfile .
#
# Run from repo root, or:
#   docker build -t memtier-bench -f Dockerfile ../../../..
#
# Usage:
#   docker run --rm memtier-bench --host <redis-host> --port 6379 --mode all --test-time 30
#
# Examples:
#   # Basic benchmark against local Redis
#   docker run --rm --network host memtier-bench --host 127.0.0.1 --port 6379 --mode all
#
#   # Benchmark against Redis in another container
#   docker run --rm --network redis-net memtier-bench --host redis --port 6379 --test-time 60
#
#   # Full options example
#   docker run --rm --network host memtier-bench \
#     --host 127.0.0.1 --port 6379 \
#     --threads 4 --connections 4 \
#     --pipeline 10 --bulk-size 5 \
#     --data-size 64 --ratio 1:10 \
#     --test-time 30 --mode fast-headers-on
#
#   # OSS Cluster mode
#   docker run --rm --network host memtier-bench \
#     --npm-oss-cluster --npm-client-version 5.1.1 \
#     --oss-node node1:6379 --oss-node node2:6379 \
#     --mode oss-cluster --test-time 30
#
#   # With authentication
#   docker run --rm --network host memtier-bench \
#     --host 127.0.0.1 --port 6379 \
#     --username myuser --password mypass \
#     --mode all --test-time 30
#
#   # With CPU profiling
#   docker run --rm --network host -v $(pwd)/profiles:/app/profiles memtier-bench \
#     --host 127.0.0.1 --port 6379 --profile --mode all

FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files for dependency installation
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/client/package.json ./packages/client/
COPY packages/test-utils/package.json ./packages/test-utils/
COPY packages/bloom/package.json ./packages/bloom/
COPY packages/json/package.json ./packages/json/
COPY packages/search/package.json ./packages/search/
COPY packages/time-series/package.json ./packages/time-series/
COPY packages/entraid/package.json ./packages/entraid/
COPY packages/redis/package.json ./packages/redis/

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source files
COPY packages/ ./packages/

# Build the project (includes binary header generation)
RUN npm run build

# Production image
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
COPY packages/client/package.json ./packages/client/
COPY packages/test-utils/package.json ./packages/test-utils/
COPY packages/bloom/package.json ./packages/bloom/
COPY packages/json/package.json ./packages/json/
COPY packages/search/package.json ./packages/search/
COPY packages/time-series/package.json ./packages/time-series/
COPY packages/entraid/package.json ./packages/entraid/
COPY packages/redis/package.json ./packages/redis/

# Install production dependencies plus hdr-histogram-js (devDep but