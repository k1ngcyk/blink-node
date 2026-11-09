#!/usr/bin/env bash
# Run on the Master after installing/registering the project-specific shell Runner.
set -euo pipefail
umask 077
[[ ${EUID} -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
id gitlab-runner >/dev/null
command -v gitlab-runner >/dev/null
command -v sudo >/dev/null
command -v python3 >/dev/null
docker compose version
[[ -f /opt/blink-node/.env && -f /opt/blink-node/deploy/compose.yml ]]
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -m 0755 -o root -g root "$script_dir/master-deploy.py" /usr/local/sbin/blink-node-deploy
work=$(mktemp)
trap 'rm -f -- "$work"' EXIT
printf 'gitlab-runner ALL=(root) NOPASSWD: /usr/local/sbin/blink-node-deploy *\n' > "$work"
visudo -cf "$work"
install -m 0440 -o root -g root "$work" /etc/sudoers.d/blink-node-deploy
systemctl enable --now gitlab-runner
printf 'Master deploy Runner ready; tag: blink-master-deploy.\n'
