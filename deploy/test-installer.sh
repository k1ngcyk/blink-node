#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
version=$(node -p "require(process.argv[1]).version" "$root/web/package.json")
[[ -f "$root/web/public/downloads/agent/v$version/install.sh" ]] || { echo 'Run bash deploy/build-agent.sh first.' >&2; exit 1; }
for arch in amd64 arm64; do
  docker buildx build --platform "linux/$arch" --load --target installer-test \
    -f "$root/deploy/agent/Dockerfile.test" -t "blink-installer-test:$arch" "$root"
  docker run --rm --platform "linux/$arch" --network none --security-opt no-new-privileges:true \
    -e AGENT_VERSION="$version" "blink-installer-test:$arch"
done
