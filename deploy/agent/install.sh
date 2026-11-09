#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ ${EUID} -ne 0 ]]; then echo 'Run as root.' >&2; exit 1; fi
if [[ $# -ne 2 ]]; then echo 'Usage: install.sh /path/to/blink-agent /path/to/config.toml' >&2; exit 1; fi
if [[ $(uname -s) != Linux ]]; then echo 'Linux is required.' >&2; exit 1; fi
"$1" --version
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/service-platform.sh"
blink_platform
blink_user blink-agent /var/lib/blink-agent /bin/sh
install -d -m 0750 -o root -g blink-agent /etc/blink-agent
install -d -m 0700 -o blink-agent -g blink-agent /var/lib/blink-agent
if [[ -e /etc/blink-agent/config.toml ]]; then echo 'Existing config found; refusing to overwrite.' >&2; exit 1; fi
install -m 0755 -o root -g root "$1" /usr/local/bin/blink-agent
install -m 0640 -o root -g blink-agent "$2" /etc/blink-agent/config.toml
blink_service_install blink-agent "$script_dir"
bash "$script_dir/enable-proxy.sh"
echo 'Installed. Enroll before enabling blink-agent with systemctl or rc-service; then run enable-auto-update.sh for automatic updates. See README.'
