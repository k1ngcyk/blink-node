#!/usr/bin/env bash
# Install the independent updater for an already enrolled agent (including 0.1.0).
set -euo pipefail
umask 077
die() { printf 'Blink Agent: %s\n' "$*" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || die 'Run as root.'
[[ $(uname -s) == Linux ]] || die 'Linux is required.'
[[ -f /etc/blink-agent/config.toml && -f /usr/local/bin/blink-agent ]] || die 'Install and enroll the agent first.'
command -v python3 >/dev/null || die 'Install python3 (3.9+) and ca-certificates first.'
python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' || die 'Python 3.9+ is required.'
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/service-platform.sh"
blink_platform
for file in update-agent.py blink-agent-update.service blink-agent-update.timer; do
  [[ -f "$script_dir/$file" ]] || die "Keep $file beside this script."
done
install -d -m 0755 -o root -g root /usr/local/libexec
install -d -m 0700 -o root -g root /var/lib/blink-agent-update
if [[ $BLINK_INIT == openrc ]]; then
  if [[ ! -x /etc/init.d/crond ]]; then
    command -v apk >/dev/null || die 'Install an OpenRC crond service first.'
    apk add --no-cache busybox-openrc
  fi
  install -m 0755 -o root -g root "$script_dir/update-agent.py" /usr/local/libexec/blink-agent-update
  install -d -m 0755 -o root -g root /etc/periodic/15min
  install -m 0755 -o root -g root "$script_dir/blink-agent-update.cron" /etc/periodic/15min/blink-agent-update
  rc-update add crond default
  rc-service crond start
  printf 'Automatic updates enabled: current Master, OpenRC/crond, every 15 minutes.\n'
  exit 0
fi
# Stop only the updater before replacing its Python source; keep the agent running.
for unit in blink-agent-update.timer blink-agent-update.service; do
  if systemctl cat "$unit" >/dev/null 2>&1; then
    systemctl stop "$unit"
  fi
done
install -m 0755 -o root -g root "$script_dir/update-agent.py" /usr/local/libexec/blink-agent-update
install -m 0644 -o root -g root "$script_dir/blink-agent-update.service" /etc/systemd/system/blink-agent-update.service
install -m 0644 -o root -g root "$script_dir/blink-agent-update.timer" /etc/systemd/system/blink-agent-update.timer
systemctl daemon-reload
systemctl enable --now blink-agent-update.timer
printf 'Automatic updates enabled: current Master, every 15 minutes (+ up to 2 minutes jitter).\n'
