#!/usr/bin/env bash
# Downloaded over HTTPS from the Master. Enrollment token is read from stdin,
# never from command-line arguments or a URL. Run as root on systemd Linux.
set +x
set -euo pipefail
umask 077
VERSION="@VERSION@"
server=""
terminal=false
local_test=false
die() { printf 'Blink Agent: %s\n' "$*" >&2; exit 1; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) [[ $# -ge 2 ]] || die 'Missing --server value'; server="$2"; shift 2 ;;
    --enable-terminal) terminal=true; shift ;;
    --allow-insecure-localhost) local_test=true; shift ;;
    *) die "Unknown option: $1" ;;
  esac
done
[[ ${EUID} -eq 0 ]] || die 'Run as root (sudo -i), then paste the installation command.'
[[ $(uname -s) == Linux ]] || die 'Linux is required.'
server=${server%/}
# This value is written to TOML, so reject everything outside an HTTPS origin.
[[ "$server" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || {
  [[ "$local_test" == true && "$server" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$ ]] || die 'An HTTPS Master origin is required.'
}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'Use the published installer, not its source template.'
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die 'Supported architectures: x86_64 and ARM64.' ;;
esac
for tool in curl sha256sum tar systemctl useradd install chown mktemp; do
  command -v "$tool" >/dev/null || die "Missing dependency: $tool (install curl, ca-certificates and systemd)."
done
systemctl show-environment >/dev/null 2>&1 || die 'systemd must be running as the service manager.'
# Never silently replace an existing installation, identity, or local policy.
for path in /etc/blink-agent /var/lib/blink-agent /usr/local/bin/blink-agent /etc/systemd/system/blink-agent.service; do
  [[ ! -e "$path" && ! -L "$path" ]] || die "Existing $path found; see README for upgrade / re-enrollment."
done
if id blink-agent >/dev/null 2>&1; then
  [[ $(id -u blink-agent) != 0 ]] || die 'blink-agent must not be root.'
fi
IFS= read -r token || [[ -n ${token:-} ]] || die 'Supply the enrollment token on stdin.'
[[ "$token" =~ ^[A-Za-z0-9_-]{43}$ ]] || die 'Invalid enrollment token.'
work=$(mktemp -d /var/tmp/blink-install.XXXXXXXX)
created=false
cleanup() {
  result=$?
  trap - EXIT
  rm -rf -- "$work"
  if [[ "$result" != 0 && "$created" == true ]]; then
    # Keep the registered identity for recovery; never consume a token then
    # erase the credential on a later service-start failure.
    printf 'Installation incomplete. Inspect /etc/blink-agent and journalctl -u blink-agent.\n' >&2
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "$token" > "$work/token"
unset token
base="$server/downloads/agent/v$VERSION"
proto='=https'
[[ "$local_test" == false ]] || proto='=http,https'
fetch() {
  curl --fail --silent --show-error --location --proto "$proto" --proto-redir "$proto" \
    --tlsv1.2 --connect-timeout 15 --max-time 180 --retry 2 "$1" -o "$2"
}
archive="blink-agent-linux-$arch.tar.gz"
fetch "$base/SHA256SUMS" "$work/SHA256SUMS"
fetch "$base/$archive" "$work/$archive"
expected=$(awk -v name="$archive" '$2 == name && length($1) == 64 { print $1 }' "$work/SHA256SUMS")
[[ "$expected" =~ ^[a-f0-9]{64}$ ]] || die 'Missing or ambiguous release checksum.'
printf '%s  %s\n' "$expected" "$work/$archive" | sha256sum -c - >/dev/null || die 'Release checksum mismatch.'
# Extract only the two expected files; never extract arbitrary archive paths.
mkdir "$work/package"
tar -xzf "$work/$archive" -C "$work/package" --no-same-owner --no-same-permissions blink-agent blink-agent.service
for item in blink-agent blink-agent.service; do
  [[ -f "$work/package/$item" && ! -L "$work/package/$item" ]] || die 'Invalid release archive.'
done
chmod 0755 "$work/package/blink-agent"
[[ $("$work/package/blink-agent" --version) == "blink-agent $VERSION" ]] || die 'Release version mismatch.'
id blink-agent >/dev/null 2>&1 || useradd --system --home-dir /var/lib/blink-agent --shell /bin/sh --user-group blink-agent
install -d -m 0750 -o root -g blink-agent /etc/blink-agent
install -d -m 0700 -o blink-agent -g blink-agent /var/lib/blink-agent
created=true
cat > "$work/config.toml" <<EOF
server_url = "$server"
terminal_enabled = $terminal
terminal_user = "blink-agent"
allow_root_terminal = false
allow_insecure_localhost = $local_test
EOF
install -m 0640 -o root -g blink-agent "$work/config.toml" /etc/blink-agent/config.toml
install -m 0755 -o root -g root "$work/package/blink-agent" /usr/local/bin/blink-agent
install -m 0644 -o root -g root "$work/package/blink-agent.service" /etc/systemd/system/blink-agent.service
if ! /usr/local/bin/blink-agent enroll --token-file "$work/token"; then
  # No active installation preceded this invocation. Roll back local files so
  # a fresh panel token can be used immediately after a network/auth failure.
  rm -f /etc/blink-agent/config.toml /var/lib/blink-agent/identity.json /usr/local/bin/blink-agent /etc/systemd/system/blink-agent.service
  rmdir /etc/blink-agent /var/lib/blink-agent
  created=false
  die 'Enrollment failed. Generate a fresh command in the panel and retry.'
fi
chown blink-agent:blink-agent /var/lib/blink-agent/identity.json
chmod 0600 /var/lib/blink-agent/identity.json
rm -f "$work/token"
systemctl daemon-reload
systemctl enable --now blink-agent
systemctl is-active --quiet blink-agent || die 'Service failed to start.'
printf 'Blink Agent %s installed (%s). Terminal: %s. Return to the panel; metrics arrive within a few seconds.\n' "$VERSION" "$arch" "$terminal"
