#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ ${EUID} -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
command -v python3 >/dev/null
command -v systemctl >/dev/null
python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))'
id blink-agent >/dev/null
dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if ! id blink-proxy >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/blink-proxy --shell /usr/sbin/nologin --user-group blink-proxy
fi
install -d -m 0755 -o root -g root /usr/local/libexec/blink-proxy
install -d -m 0750 -o root -g blink-proxy /var/lib/blink-proxy
install -d -m 0700 -o root -g root /var/lib/blink-proxy/manager
install -d -m 0700 -o blink-proxy -g blink-proxy /var/lib/blink-proxy/caddy
install -m 0644 -o root -g root "$dir/proxy-manager.py" /usr/local/libexec/blink-proxy/manager.py
install -m 0644 -o root -g root "$dir/proxy-assets.json" /usr/local/libexec/blink-proxy/assets.json
install -m 0644 -o root -g root "$dir/blink-proxy-manager.service" /etc/systemd/system/blink-proxy-manager.service
# Record the trusted, local Master origin independently of task payloads.
python3 - /etc/blink-agent/config.toml <<'PY'
import json, pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
match = re.search(r'^server_url\s*=\s*"(https?://[^"\s]+)"\s*$', text, re.M)
if not match:
    raise SystemExit('Cannot read Master origin from Agent config')
pathlib.Path('/var/lib/blink-proxy/manager/origin.json').write_text(json.dumps({'origin': match[1]}))
PY
systemctl daemon-reload
systemctl enable --now blink-proxy-manager
systemctl restart blink-proxy-manager
systemctl try-restart blink-agent
echo 'Proxy deployment manager installed; the Agent will scan existing services on connection.'
