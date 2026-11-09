#!/usr/bin/env bash
# Build Runner (tag: build), using its existing Docker/registry credentials.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
docker version
docker buildx version
docker compose version
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
case "$(uname -m)" in
  x86_64|amd64) native=linux/amd64 ;;
  aarch64|arm64) native=linux/arm64 ;;
  *) echo 'Unsupported runner architecture' >&2; exit 1 ;;
esac

# Obtain a pinned Node runtime from the build image; no host Node/Rust install.
mkdir -p .local/ci-tools
docker pull --platform "$native" node:24-bookworm-slim
node_container=$(docker create --platform "$native" node:24-bookworm-slim)
candidate="blink-node-ci:${CI_PROJECT_ID:-local}-${CI_JOB_ID:-local}"
cleanup() {
  docker rm "$node_container" >/dev/null 2>&1 || true
  docker image rm "$candidate" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker cp "$node_container:/usr/local/bin/node" .local/ci-tools/node
chmod 0755 .local/ci-tools/node
export PATH="$root/.local/ci-tools:$PATH"
node --version
docker run --rm --platform "$native" --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$root/web:$root/web" -w "$root/web" node:24-bookworm-slim npm ci --cache /tmp/npm
(
  cd web
  node node_modules/typescript/bin/tsc --noEmit
  node node_modules/eslint/bin/eslint.js .
  node --import tsx --test tests/*.test.ts
)
bash deploy/build-agent.sh
bash deploy/test-installer.sh
bash deploy/test-proxy.sh
(
  cd web
  node --import tsx tests/proxy-integration.ts
)
python3 deploy/test-master-deploy.py
docker buildx build --platform "$native" --target runtime --load \
  --build-arg "HTTP_PROXY=${BLINK_BUILD_PROXY:-${HTTP_PROXY:-}}" --build-arg "HTTPS_PROXY=${BLINK_BUILD_PROXY:-${HTTPS_PROXY:-}}" \
  -t "$candidate" web
(
  cd web
  BLINK_TEST_IMAGE="$candidate" node --import tsx tests/docker-smoke.ts
)
bash deploy/publish.sh
