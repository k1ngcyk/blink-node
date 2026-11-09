#!/usr/bin/env bash
# Switch an already enrolled systemd installation to a root web terminal.
set -euo pipefail
umask 077
die() { printf 'Blink Agent: %s\n' "$*" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || die 'Run as root.'
[[ $(uname -s) == Linux ]] || die 'Linux with systemd is required.'
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
config=/etc/blink-agent/config.toml
override=/etc/systemd/system/blink-agent.service.d/terminal.conf
[[ -f "$config" ]] || die 'Install and enroll the agent first.'
[[ -f "$script_dir/root-terminal.conf.example" ]] || die 'Keep root-terminal.conf.example beside this script.'
systemctl show-environment >/dev/null

# Preserve the original local configuration and any existing terminal override.
[[ -e "$config.before-root-terminal" ]] || cp -p -- "$config" "$config.before-root-terminal"
if [[ -f "$override" && ! -e "$override.before-root-terminal" ]]; then
  cp -p -- "$override" "$override.before-root-terminal"
fi
work=$(mktemp "${config}.root.XXXXXXXX")
trap 'rm -f -- "$work"' EXIT
# Agent config is a flat TOML object. Preserve all other settings and comments.
awk '
  BEGIN {
    print "terminal_enabled = true"
    print "terminal_user = \"root\""
    print "allow_root_terminal = true"
  }
  !/^[[:space:]]*["\047]?(terminal_enabled|terminal_user|allow_root_terminal)["\047]?[[:space:]]*=/
' "$config" > "$work"
chmod --reference="$config" "$work"
chown --reference="$config" "$work"
install -d -m 0755 -o root -g root "$(dirname -- "$override")"
install -m 0644 -o root -g root "$script_dir/root-terminal.conf.example" "$override"
mv -f -- "$work" "$config"
systemctl daemon-reload
systemctl restart blink-agent
systemctl is-active --quiet blink-agent || die 'Service failed to start; inspect journalctl -u blink-agent.'
printf 'Root web terminal enabled. Reconnect from the panel; run id -un to verify.\n'
