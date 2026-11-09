#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
version=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$root/web/package.json" | head -1)
[[ -f "$root/web/public/downloads/agent/v$version/install.sh" ]] || { echo 'Run bash deploy/build-agent.sh first.' >&2; exit 1; }
for arch in amd64 arm64; do
  docker buildx build --platform "linux/$arch" --load --target installer-test \
    --build-arg "HTTP_PROXY=${BLINK_BUILD_PROXY:-${HTTP_PROXY:-}}" --build-arg "HTTPS_PROXY=${BLINK_BUILD_PROXY:-${HTTPS_PROXY:-}}" --build-arg NO_PROXY \
    -f "$root/deploy/agent/Dockerfile.test" -t "blink-installer-test:$arch" "$root"
  docker run --rm --platform "linux/$arch" --network none --security-opt no-new-privileges:true \
    -e AGENT_VERSION="$version" "blink-installer-test:$arch"
done
