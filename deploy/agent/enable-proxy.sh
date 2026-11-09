#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ ${EUID} -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
command -v python3 >/dev/null
python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))'
id blink-agent >/dev/null
dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$dir/service-platform.sh"
blink_platform
if ! /usr/bin/python3 -c 'import yaml' >/dev/null 2>&1; then
  if command -v apk >/dev/null; then apk add --no-cache py3-yaml;
  elif command -v apt-get >/dev/null; then apt-get update && apt-get install -y python3-yaml;
  else echo 'Install PyYAML for /usr/bin/python3 before enabling proxy scanning.' >&2; exit 1; fi
fi
blink_user blink-proxy /var/lib/blink-proxy /sbin/nologin
install -d -m 0755 -o root -g root /usr/local/libexec/blink-proxy
install -d -m 0755 -o root -g root /usr/local/libexec/blink-proxy/bin
install -d -m 0750 -o root -g blink-proxy /var/lib/blink-proxy
install -d -m 0700 -o root -g root /var/lib/blink-proxy/manager
install -d -m 0700 -o blink-proxy -g blink-proxy /var/lib/blink-proxy/caddy
install -m 0644 -o root -g root "$dir/proxy-manager.py" /usr/local/libexec/blink-proxy/manager.py
install -m 0644 -o root -g root "$dir/proxy-assets.json" /usr/local/libexec/blink-proxy/assets.json
blink_service_install blink-proxy-manager "$dir"
# Record the trusted, local Master origin independently of task payloads.
python3 - /etc/blink-agent/config.toml <<'PY'
import json, pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
match = re.search(r'^server_url\s*=\s*"(https?://[^"\s]+)"\s*$', text, re.M)
if not match:
    raise SystemExit('Cannot read Master origin from Agent config')
pathlib.Path('/var/lib/blink-proxy/manager/origin.json').write_text(json.dumps({'origin': match[1]}))
PY
blink_service_enable blink-proxy-manager
blink_service_restart blink-proxy-manager
if blink_service_active blink-agent; then blink_service_restart blink-agent; fi
echo 'Proxy deployment manager installed; the Agent will scan existing services on connection.'
