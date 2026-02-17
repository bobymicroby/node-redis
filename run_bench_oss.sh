#!/bin/bash

# SSH connection details - update these
SSH_HOST="ubuntu@52.16.66.240"
REMOTE_DIR="~/node-redis"

# Common parameters for OSS cluster mode
COMMON_PARAMS="--host redis-15723.aws-cluster-25422.cto.redislabs.com \
  --port 15723 \
  --password test123 \
  --ratio 1:0 \
  -t 1 \
  -d 1024 \
  --key-prefix \"key_123456789A123456789A123456789A123456789A\" \
  --key-minimum 1 \
  --key-maximum 1000000 \
  --test-time 5 \
  --mode all \
  --bulk-size 10 \
  --pipeline 40 \
  --profile \
  --npm-oss-cluster \
  --npm-client-version 5.10.0 \
  --oss-node redis-16099.aws-cluster-25422.cto.redislabs.com:16099"

# Run benchmarks with different connection counts
for CONNECTIONS in 1 2 3 4; do
  echo "========================================"
  echo "Running OSS benchmark with -c $CONNECTIONS"
  echo "========================================"

  ssh $SSH_HOST "source ~/.nvm/nvm.sh && cd $REMOTE_DIR && npx ts-node packages/client/lib/binary-headers/memtier-bench.ts \
    $COMMON_PARAMS \
    -c $CONNECTIONS" | tee "oss_c${CONNECTIONS}.txt"

  echo ""
  echo "Completed -c $CONNECTIONS"
  echo ""

  sleep 2
done

echo "All OSS benchmarks completed!"
echo "Results:"
ls -la oss_c*.txt
