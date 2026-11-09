# Blink wire protocol v1

The canonical inbound validator is `web/src/server/protocol.ts`. Rust emits strongly typed
`Metric` structures; the integration test parses real Agent output with that validator.
All JSON control messages carry `v: 1`. Unsupported versions fail closed. No general-purpose
remote command field exists. PTY is a separately enabled, owner-authorized capability.

## Connections

- `POST /agent/enroll`: `{ token, credential }`. Both are 32 random bytes, base64url encoded.
  The Agent persists its proposed credential before enrollment. Enrollment consumes a
  15-minute single-use token. Retrying with the **same** credential is idempotent until
  expiry. A different credential cannot reuse the token. The master stores only SHA-256 hashes.
- `/ws/agent`: `Authorization: Bearer <credential>` over WSS. First message is `hello`.
- `/ws/live`: owner session cookie + exact Origin. Emits `ready` and `refresh` hints.
- `/ws/terminal`: owner session cookie + exact Origin, then `{type:"auth",ticket}` within
  5 seconds. Ticket is bound to the current owner session and server, expires in 30 seconds,
  and is atomically consumed. Secrets never appear in query strings.
- `/ws/agent-terminal`: Agent bearer credential plus `X-Blink-Stream`, a separate short-lived,
  one-use stream secret from the control channel. Only that Agent can attach to the session.

## Agent → master

- `hello {info}`: hostname, os, kernel, arch, cpuModel, cpuCount, version, terminal, diagnostics, proxy.
  `proxy` defaults to false for older agents; true requires the local deployment socket.
- `metrics {samples}`: maximum 20 samples per message; Agent currently sends at most 10.
  Each sample includes `bootId` (Agent-start UUID), monotonic `seq`, RFC3339 UTC `at`, uptime,
  CPU / cores / load, memory and swap byte counts, per-mount capacity / inode counts,
  per-interface cumulative counters / deltas / rates, disk I/O rates, optional temperatures.
- `check.result {result}`: id, at, ok, latencyMs, loss, status, certificateDays, error.
  A result must match a pending check assigned to that Agent and have a recent timestamp.
- `diagnostic.result {id,ok,result}`: bounded text, matched to an unexpired assigned job.
- `proxy.result {taskId,desiredVersion,ok,result}`: matched to the assigned server and running
  job. Scans contain encrypted-at-rest discoveries; apply results contain allowlisted status.
- `proxy.status {status}`: bounded, credential-free managed service / certificate status, every minute. Optional `checkedAt`, `ufwState` (`active` / `inactive` / `not_installed` / `error`), `ufw` verbose output, and `network {checkedAt, addresses: [{address, source: "interface" | "ip.sb", interface?}]}` describe actual node state. At most one public IPv4 and one public IPv6 are accepted; initial observations populate empty host addresses without overwriting saved values. Address discovery is cached for five minutes and refreshed by explicit scans. Client endpoints use these IPs; TLS/SNI retains the configured certificate domain.
- Exit references may identify managed SS2022 instances or explicitly registered existing Shadowsocks listeners from encrypted scan snapshots. Imported exits use the same typed `exits` payload, including validated cipher/password (server:user for multi-user SS2022), but never enter local `instances` or schedule source-service deployment. Rescans invalidate changed/missing source configurations; source IP changes redeploy referencing entrances.

## Master → Agent

- `welcome {intervalSeconds}`: informational sampling recommendation; local configuration
  constrains actual collection to 5–60 seconds.
- `metrics.ack {bootId,seq}`: remove the acknowledged prefix from the local buffer only after
  persistence. Duplicate inserts do not increment traffic. Expired samples are discarded.
- `check.run {id,kind,target}`: allowlisted `tcp`, `http`, `icmp`, `tls`; Agent independently
  validates resolved destinations and pins the connection to the validated public IP.
- `diagnostic.run {id,kind,unit}`: allowlisted `processes`, `services`, `logs`; fixed executable
  and argument construction, no shell interpolation. Optional unit has strict validation.
- `terminal.open {id,streamToken}` / `terminal.close {id}`: Unix identity is decided locally.
- `proxy.run {taskId,resourceId,desiredVersion,deadline,operation,payload}`: `scan`, `apply` or `firewall`.
  Agent validates server identity, bounds and deadline, then forwards through the group-restricted
  `/run/blink-proxy/control.sock`. Payload contains typed proxy specs, credentials, routes, node
  addresses, ACME email and firewall mode; no executable, shell or arbitrary output-path fields.
  `firewall` instead carries `{firewall, retainExisting, exits: [{id, port, udp, sources}]}` without credentials.
  It reconciles imported-exit ACLs alongside managed-instance rules without changing service configs or restarting cores.
  Nodes advertise `status.externalFirewall=true` and `externalFirewallVersion`; old nodes must update before linking imported exits.

## Terminal stream

Browser → Agent: JSON `input {data}` or `resize {cols,rows}`. Output is binary PTY bytes.
Raw output has bounded per-frame size and buffers; the connection closes on backpressure.
Authentication expires with the browser session. Idle limit 15 minutes; absolute limit 1 hour.
Shell exit, browser disconnect, credential revocation and gateway restart end the PTY session.

## Proxy task delivery

One running task per node, with queued jobs dispatched in per-node FIFO order. Encrypted jobs persist before dispatch; unacknowledged jobs are
redelivered after 45 seconds with the same ID and payload. Dependencies must complete before
an entrance task is dispatched. Socket/transport failure is not treated as a confirmed failure;
the helper's seven-day durable ledger answers redelivery. Jobs expire after 30 minutes.

Imported-exit firewall jobs use separate monotonically increasing desired/applied versions.
Prepare jobs retain existing source rules while allowing the new IPv4/IPv6 sources; entrance applies depend on them.
Cleanup jobs run only after successful entrance applies, remove obsolete owned rules, and retain shared and administrator rules.
Firewall-only rollback restores its own journal without touching service generations. Normal applies merge these imported ACLs.

Apply generations are monotonically versioned. The local transaction journal restores prior
configuration, units and owned firewall rules after failure/interruption. Successful same-version
redelivery verifies its payload fingerprint. Cloudflare changes and multi-node deployments are
not globally atomic: failures are visible and a new apply reconciles desired configuration.
Proxy operations and credential access require owner authorization and recent elevation.
