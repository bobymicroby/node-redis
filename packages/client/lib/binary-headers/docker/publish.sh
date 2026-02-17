#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../../.." && pwd)"

cd "${REPO_ROOT}"

# Docker Hub username
DOCKERHUB_USER="borislavivanov271"
IMAGE_NAME="${DOCKERHUB_USER}/memtier-bench"

# Get version info
GIT_SHA="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain)" ]; then
    echo "ERROR: Git working directory is dirty. Commit or stash changes before publishing."
    git status --short
    exit 1
fi

echo "Publishing memtier-bench to Docker Hub..."
echo "Image: ${IMAGE_NAME}"
echo "Git SHA: ${GIT_SHA}"
echo ""

# Build
docker build \
    -f packages/client/lib/binary-headers/docker/Dockerfile \
    -t "${IMAGE_NAME}:${GIT_SHA}" \
    -t "${IMAGE_NAME}:latest" \
    .

echo ""
echo "Pushing to Docker Hub..."

# Push all tags
docker push "${IMAGE_NAME}" --all-tags

echo ""
echo "Published:"
echo "  ${IMAGE_NAME}:${GIT_SHA}"
echo "  ${IMAGE_NAME}:latest"
echo ""
echo "Pull with:"
echo "  docker pull ${IMAGE_NAME}:latest"
echo ""
echo "Run with:"
echo "  docker run --rm ${IMAGE_NAME} --host <redis-host> --port 6379 --mode all"
