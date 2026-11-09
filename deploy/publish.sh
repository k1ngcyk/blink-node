#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
version=$(node -p "require(process.argv[1]).version" "$root/web/package.json")
image=registry.windgyre.com/library/blink-node-web
git -C "$root" diff --quiet && git -C "$root" diff --cached --quiet || { echo 'Commit source changes before publishing.' >&2; exit 1; }
bash "$root/deploy/build-agent.sh"
docker buildx build --platform linux/amd64,linux/arm64 --target runtime \
  --label "org.opencontainers.image.source=https://github.com/k1ngcyk/blink-node" \
  --label "org.opencontainers.image.version=$version" \
  --label "org.opencontainers.image.revision=$(git -C "$root" rev-parse HEAD)" \
  -t "$image:$version" -t "$image:latest" --push "$root/web"
