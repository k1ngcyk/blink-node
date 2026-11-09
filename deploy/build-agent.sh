#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
version=$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$root/agent/Cargo.toml" | head -1)
web_version=$(node -p "require(process.argv[1]).version" "$root/web/package.json")
[[ "$version" == "$web_version" ]] || { echo 'Agent and Web versions must match.' >&2; exit 1; }
mkdir -p "$root/.local"
work=$(mktemp -d "$root/.local/agent-release.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
docker buildx build --platform linux/amd64,linux/arm64 --target artifacts \
  -f "$root/agent/Dockerfile.release" --output "type=local,dest=$work" "$root"
out="$root/web/public/downloads/agent/v$version"
mkdir -p "$out"
for arch in amd64 arm64; do
  cp "$work/linux_$arch/blink-agent-linux-$arch.tar.gz" "$out/"
done
cmp "$work/linux_amd64/install.sh" "$work/linux_arm64/install.sh"
cp "$work/linux_amd64/install.sh" "$out/install.sh"
cat "$work/linux_amd64/SHA256SUMS" "$work/linux_arm64/SHA256SUMS" > "$out/SHA256SUMS"
printf 'Agent release ready: %s\n' "$out"
