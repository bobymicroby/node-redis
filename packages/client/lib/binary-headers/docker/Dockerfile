# =============================================================================
# Dockerfile for memtier-bench - A memtier-like benchmark for node-redis
# =============================================================================
#
# Build (from repository root):
#   docker build -f packages/client/lib/binary-headers/docker/Dockerfile -t memtier-bench .
#
# Usage:
#   docker run --rm memtier-bench --host redis --port 6379 --mode all --test-time 30
#   docker run --rm --network host memtier-bench --host 127.0.0.1 --port 6379
#
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build the entire monorepo
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Copy everything
COPY . .

# Clean any existing build artifacts, install dependencies, and build
# Increase Node memory limit for TypeScript compilation
RUN npm run clean; \
    rm -rf node_modules packages/*/node_modules && \
    npm ci && \
    NODE_OPTIONS="--max-old-space-size=4096" npm run build

# -----------------------------------------------------------------------------
# Stage 2: Lean runtime with only what's needed
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

# Copy compiled client package
COPY --from=builder /app/packages/client/dist ./dist

# Copy node_modules from builder (includes all runtime deps)
COPY --from=builder /app/node_modules ./node_modules

# Entrypoint runs the benchmark, all args passed through
ENTRYPOINT ["node", "dist/lib/binary-headers/memtier-bench.js"]
