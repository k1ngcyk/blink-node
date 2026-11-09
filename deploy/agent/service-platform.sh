# Shared by the root-owned installation helpers (bash).
blink_platform() {
  if [[ -x /sbin/openrc-run && ! -d /run/systemd/system ]]; then
    BLINK_INIT=openrc
    [[ -f /run/openrc/softlevel ]] || { echo 'OpenRC must be running.' >&2; return 1; }
  else
    BLINK_INIT=systemd
    systemctl show-environment >/dev/null
  fi
}
blink_user() {
  local name=$1 home=$2 shell=$3
  if id "$name" >/dev/null 2>&1; then
    [[ $(id -u "$name") != 0 ]] || return 1
  elif command -v useradd >/dev/null; then
    useradd --system --home-dir "$home" --shell "$shell" --user-group "$name"
  else
    addgroup -S "$name"
    adduser -S -D -H -h "$home" -s "$shell" -G "$name" "$name"
  fi
}
blink_service_install() {
  local name=$1 directory=$2
  if [[ $BLINK_INIT == openrc ]]; then
    install -m 0755 -o root -g root "$directory/$name.openrc" "/etc/init.d/$name"
  else
    install -m 0644 -o root -g root "$directory/$name.service" "/etc/systemd/system/$name.service"
    systemctl daemon-reload
  fi
}
blink_service_enable() {
  if [[ $BLINK_INIT == openrc ]]; then
    rc-update add "$1" default
    rc-service "$1" start
  else
    systemctl enable --now "$1"
  fi
}
blink_service_active() {
  if [[ $BLINK_INIT == openrc ]]; then rc-service "$1" status >/dev/null 2>&1;
  else systemctl is-active --quiet "$1"; fi
}
blink_service_restart() {
  if [[ $BLINK_INIT == openrc ]]; then rc-service "$1" restart;
  else systemctl restart "$1"; fi
}
