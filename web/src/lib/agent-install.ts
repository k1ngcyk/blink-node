import { version } from "../../package.json";

export const agentVersion = version;
export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function agentInstallCommand(serverUrl: string, token: string, terminal = false) {
  const url = new URL(serverUrl);
  if (url.origin !== serverUrl || !["https:", "http:"].includes(url.protocol))
    throw new Error("Invalid Master origin");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid enrollment token");
  // The token travels through a shell builtin and stdin, not sh/curl argv or
  // a query string. Only the short-lived token appears in the copied command.
  const script = `set -eu; umask 077; [ "$(id -u)" = 0 ] || { echo 'Run as root.' >&2; exit 1; }; if [ -f /etc/alpine-release ]; then apk add --no-cache bash curl ca-certificates </dev/null; fi; d=$(mktemp -d); trap 'rm -rf -- "$d"' EXIT; curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 ${shellQuote(`${serverUrl}/downloads/agent/v${agentVersion}/install.sh`)} -o "$d/install.sh"; bash "$d/install.sh" --server ${shellQuote(serverUrl)}${terminal ? " --enable-terminal" : ""}`;
  return `printf '%s\\n' ${shellQuote(token)} | sh -c ${shellQuote(script)}`;
}
