#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
version=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$root/web/package.json" | head -1)
image=registry.windgyre.com/library/blink-node-web
git -C "$root" diff --quiet && git -C "$root" diff --cached --quiet || { echo 'Commit source changes before publishing.' >&2; exit 1; }
stage() {
  local label=$1 started=$SECONDS
  shift
  printf '[%s] START %s\n' "$(date -u +%FT%TZ)" "$label"
  "$@"
  printf '[%s] DONE %s (%ss)\n' "$(date -u +%FT%TZ)" "$label" "$((SECONDS - started))"
}
stage 'Agent packages: amd64 + arm64' bash "$root/deploy/build-agent.sh"
revision=$(git -C "$root" rev-parse HEAD)
stage 'Web images: amd64 + arm64 build and push' docker buildx build --platform linux/amd64,linux/arm64 --target runtime \
  --build-arg "HTTP_PROXY=${BLINK_BUILD_PROXY:-${HTTP_PROXY:-}}" --build-arg "HTTPS_PROXY=${BLINK_BUILD_PROXY:-${HTTPS_PROXY:-}}" --build-arg NO_PROXY \
  --label "org.opencontainers.image.source=${CI_PROJECT_URL:-https://git.magipop.xyz/blink/blink-node}" \
  --label "org.opencontainers.image.version=$version" \
  --label "org.opencontainers.image.revision=$revision" \
  --metadata-file "$root/.local/publish-metadata.json" \
  -t "$image:$version" -t "$image:latest" -t "$image:$revision" --push "$root/web"
