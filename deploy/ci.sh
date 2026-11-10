#!/usr/bin/env bash
# Build Runner (tag: build), using its existing Docker/registry credentials.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
docker version
docker buildx version
builder="blink-node-${CI_PROJECT_ID:-local}"
if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  docker buildx create --name "$builder" --driver docker-container
fi
export BUILDX_BUILDER="$builder"
# Keep this project's BuildKit cache between jobs, without changing the shared
# runner's default builder. The resource_group serializes this project's jobs.
platforms=$(docker buildx inspect --bootstrap)
if ! grep -q 'linux/arm64' <<< "$platforms"; then
  docker run --privileged --rm tonistiigi/binfmt --install arm64
  docker buildx stop "$builder"
  docker buildx inspect --bootstrap
fi
# Development checks and acceptance tests run locally before pushing main.
# publish.sh builds the Agent packages once, then publishes both Web platforms.
export BLINK_PROXY_ASSET_MIRROR="${BLINK_PROXY_ASSET_MIRROR:-https://node.withblink.com/downloads/proxy}"
bash deploy/publish.sh
