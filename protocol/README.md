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

- `hello {info}`: hostname, os, kernel, arch, cpuModel, cpuCount, version, terminal, diagnostics.
- `metrics {samples}`: maximum 20 samples per message; Agent currently sends at most 10.
  Each sample includes `bootId` (Agent-start UUID), monotonic `seq`, RFC3339 UTC `at`, uptime,
  CPU / cores / load, memory and swap byte counts, per-mount capacity / inode counts,
  per-interface cumulative counters / deltas / rates, disk I/O rates, optional temperatures.
- `check.result {result}`: id, at, ok, latencyMs, loss, status, certificateDays, error.
  A result must match a pending check assigned to that Agent and have a recent timestamp.
- `diagnostic.result {id,ok,result}`: bounded text, matched to an unexpired assigned job.

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

## Terminal stream

Browser → Agent: JSON `input {data}` or `resize {cols,rows}`. Output is binary PTY bytes.
Raw output has bounded per-frame size and buffers; the connection closes on backpressure.
Authentication expires with the browser session. Idle limit 15 minutes; absolute limit 1 hour.
Shell exit, browser disconnect, credential revocation and gateway restart end the PTY session.

## Future task extension

Proxy service management should introduce versioned, typed operations with `taskId`,
`resourceId`, `desiredVersion`, deadline and idempotent outcome. Add each operation to
explicit validators and Agent dispatch only after implementation. Host authorization and
`proxy_instance` resource grants remain separate.
