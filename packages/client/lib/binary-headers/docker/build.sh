#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../../.." && pwd)"

cd "${REPO_ROOT}"

# Get version info
GIT_SHA="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain)" ]; then
    echo "ERROR: Git working directory is dirty. Commit or stash changes before building."
    git status --short
    exit 1
fi
VERSION="${GIT_SHA}"

# Allow override via argument
IMAGE_NAME="${1:-memtier-bench}"

echo "Building memtier-bench Docker image..."
echo "Repository root: ${REPO_ROOT}"
echo "Git SHA: ${VERSION}"
echo ""

# Build with both version tag and latest
docker build \
    -f packages/client/lib/binary-headers/docker/Dockerfile \
    -t "${IMAGE_NAME}:${VERSION}" \
    -t "${IMAGE_NAME}:latest" \
    .

echo ""
echo "Tagged:"
echo "  ${IMAGE_NAME}:${VERSION}"
echo "  ${IMAGE_NAME}:latest"
echo ""
echo "Run with:"
echo "  docker run --rm ${IMAGE_NAME}:${VERSION} --host <redis-host> --port 6379 --mode all"
