#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
python3 "$root/deploy/fetch-proxy-assets.py"
docker buildx build --load --target proxy-test \
  --build-arg "HTTP_PROXY=${BLINK_BUILD_PROXY:-${HTTP_PROXY:-}}" --build-arg "HTTPS_PROXY=${BLINK_BUILD_PROXY:-${HTTPS_PROXY:-}}" --build-arg NO_PROXY \
    -f "$root/deploy/agent/Dockerfile.test" -t blink-proxy-test "$root"
docker run --rm --network none --security-opt no-new-privileges:true blink-proxy-test python3 /proxy/test-proxy.py
docker run --rm --network none --security-opt no-new-privileges:true blink-proxy-test
