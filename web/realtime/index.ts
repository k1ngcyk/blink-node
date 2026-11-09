import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { sql } from "../src/db";
import { config } from "../src/server/config";
import { token, hash } from "../src/server/crypto";
import { owner, audit, rateLimit } from "../src/server/auth";
import { body, HttpError, sameOrigin } from "../src/server/http";
import { agentMessage, checkResultSchema } from "../src/server/protocol";
import { ingest, aggregate, retention, ensurePartitions } from "../src/server/metrics";
import { evaluateAlerts, deliverNotifications } from "../src/server/alerts";
import { runCheck } from "../src/server/network";

const cfg = config();
// A dedicated connection owns the singleton worker lease. Multiple instances must
// not independently route terminals, send notifications or clean up live sessions.
const lease = await sql.reserve();
const [locked] = await lease`SELECT pg_try_advisory_lock(741829004) AS acquired`;
if (!locked.acquired) {
  lease.release();
  await sql.end();
  throw new Error("A Blink gateway already owns this database");
}
type Agent = { ws: WebSocket; tokenHash: string; hello: boolean; pending: number };
type Browser = { ws: WebSocket; session: string; userId: string };
type Terminal = {
  id: string;
  nodeId: string;
  userId: string;
  session: string;
  client: WebSocket;
  agent?: WebSocket;
  streamHash: string;
  opened: number;
  lastInput: number;
};
const agents = new Map<string, Agent>(),
  browsers = new Set<Browser>(),
  terminals = new Map<string, Terminal>();
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 256 * 1024,
  perMessageDeflate: false,
});
const liveness = new Map<WebSocket, number>();
const upgradeWindows = new Map<string, { start: number; count: number }>();
let stopping = false;
function logError(scope: string, error: unknown) {
  console.error(scope, error instanceof Error ? error.name : "error");
}
function send(ws: WebSocket, data: unknown) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount > 1024 * 1024) {
    ws.close(1013, "Backpressure");
    return false;
  }
  ws.send(JSON.stringify(data));
  return true;
}
function broadcast() {
  for (const b of browsers) send(b.ws, { type: "refresh" });
}
function closeTerminal(id: string, reason: string) {
  const t = terminals.get(id);
  if (!t) return;
  terminals.delete(id);
  t.client.close(1000, reason);
  t.agent?.close(1000, reason);
  const a = agents.get(t.nodeId);
  if (a) send(a.ws, { v: 1, type: "terminal.close", id });
  void sql`UPDATE terminal_sessions SET ended_at=now(),reason=${reason} WHERE id=${id}`.catch((e) =>
    logError("terminal cleanup", e),
  );
  void audit(t.userId, "terminal.closed", t.nodeId, { sessionId: id, reason }).catch((e) =>
    logError("audit", e),
  );
}
function requestHeaders(req: http.IncomingMessage) {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers))
    if (v) h.set(k, Array.isArray(v) ? v.join("; ") : v);
  return h;
}
async function authenticateAgent(headers: Headers) {
  const bearer = headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(bearer)) throw new HttpError(401, "Unauthorized");
  const tokenHash = hash(bearer.slice(7));
  const [row] = await sql`SELECT id FROM servers WHERE token_hash=${tokenHash} AND revoked=false`;
  if (!row) throw new HttpError(401, "Unauthorized");
  return { id: row.id as string, tokenHash };
}
const enrollmentSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    if (req.url === "/healthz" && req.method === "GET") {
      res.end("ok");
      return;
    }
    if (req.url !== "/agent/enroll" || req.method !== "POST") throw new HttpError(404, "Not found");
    const h = requestHeaders(req);
    await rateLimit(
      `enroll:${cfg.trustedProxy ? h.get("x-blink-client-ip") : req.socket.remoteAddress}`,
      30,
      300,
    );
    const request = new Request(`${cfg.origin}/agent/enroll`, {
      method: "POST",
      headers: h,
      body: req as unknown as ReadableStream,
      duplex: "half",
    } as RequestInit);
    const x = await body(request, enrollmentSchema, 4096);
    const id = await sql.begin(async (tx) => {
      const [enroll] =
        await tx`SELECT e.*,s.token_hash AS existing_hash FROM enrollments e JOIN servers s ON s.id=e.server_id WHERE e.token_hash=${hash(x.token)} AND e.expires_at>now() FOR UPDATE OF e`;
      if (!enroll) throw new HttpError(401, "Invalid enrollment");
      if (enroll.used_at) {
        if (enroll.existing_hash === hash(x.credential)) return enroll.server_id;
        throw new HttpError(401, "Enrollment already used");
      }
      await tx`UPDATE servers SET token_hash=${hash(x.credential)},revoked=false WHERE id=${enroll.server_id}`;
      await tx`UPDATE enrollments SET used_at=now() WHERE token_hash=${hash(x.token)}`;
      return enroll.server_id;
    });
    await audit(null, "agent.enrolled", id);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id, protocol: 1 }));
  } catch (e) {
    res.statusCode = e instanceof HttpError ? e.status : 500;
    res.end(JSON.stringify({ error: e instanceof HttpError ? e.message : "Request failed" }));
  }
});
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.maxHeadersCount = 40;
server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {});
  const timer = setTimeout(() => socket.destroy(), 5000);
  void (async () => {
    if (stopping || wss.clients.size >= 1600) throw new HttpError(503, "Capacity");
    const path = req.url;
    const h = requestHeaders(req);
    const ip = cfg.trustedProxy ? h.get("x-blink-client-ip") : req.socket.remoteAddress;
    const key = ip ?? "unknown",
      now = Date.now();
    const window = upgradeWindows.get(key);
    if (!window || now - window.start > 60000) upgradeWindows.set(key, { start: now, count: 1 });
    else if (++window.count > 600) throw new HttpError(429, "Upgrade limit");
    if (upgradeWindows.size > 10000) throw new HttpError(503, "Capacity");
    await rateLimit(`upgrade:${ip}`, 600, 60);
    if (path === "/ws/agent" || path === "/ws/agent-terminal") {
      const a = await authenticateAgent(h);
      let terminal: Terminal | undefined;
      if (path === "/ws/agent-terminal") {
        const streamToken = h.get("x-blink-stream") ?? "";
        if (!/^[A-Za-z0-9_-]{43}$/.test(streamToken)) throw new HttpError(401, "Unauthorized");
        terminal = [...terminals.values()].find(
          (t) =>
            t.nodeId === a.id &&
            t.streamHash === hash(streamToken) &&
            !t.agent &&
            Date.now() - t.opened < 10000,
        );
        if (!terminal) throw new HttpError(401, "Expired terminal");
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        clearTimeout(timer);
        track(ws);
        if (terminal) attachTerminalAgent(ws, terminal);
        else attachAgent(ws, a.id, a.tokenHash);
      });
    } else if (path === "/ws/live" || path === "/ws/terminal") {
      sameOrigin(h);
      const user = await owner(h);
      if ([...browsers].filter((b) => b.userId === user.id).length >= 12)
        throw new HttpError(429, "Too many live views");
      wss.handleUpgrade(req, socket, head, (ws) => {
        clearTimeout(timer);
        track(ws);
        if (path === "/ws/live") {
          const b = { ws, session: user.token_hash, userId: user.id };
          browsers.add(b);
          ws.on("close", () => browsers.delete(b));
          send(ws, { type: "ready" });
        } else attachBrowserTerminal(ws, user);
      });
    } else throw new HttpError(404, "Not found");
  })().catch((e) => {
    clearTimeout(timer);
    if (!socket.destroyed)
      socket.end(
        `HTTP/1.1 ${e instanceof HttpError ? e.status : 500} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
  });
});
function track(ws: WebSocket) {
  liveness.set(ws, Date.now());
  ws.on("pong", () => liveness.set(ws, Date.now()));
  ws.on("error", () => {});
  ws.on("close", () => liveness.delete(ws));
}
function attachAgent(ws: WebSocket, id: string, tokenHash: string) {
  agents.get(id)?.ws.close(1000, "Replaced by new connection");
  const a: Agent = { ws, tokenHash, hello: false, pending: 0 };
  agents.set(id, a);
  let chain = Promise.resolve(),
    window = Date.now(),
    count = 0;
  const helloTimer = setTimeout(() => {
    if (!a.hello) ws.close(1008, "Hello required");
  }, 10000);
  ws.on("message", (raw, binary) => {
    if (Date.now() - window > 10000) {
      window = Date.now();
      count = 0;
    }
    if (binary || ++count > 40 || ++a.pending > 4) {
      ws.close(1008, "Message limit");
      return;
    }
    chain = chain
      .then(async () => {
        const parsed = agentMessage.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success) {
          console.warn(
            "Invalid Agent protocol",
            parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path, code: i.code })),
          );
          throw new Error("Invalid protocol");
        }
        const m = parsed.data;
        if (!a.hello && m.type !== "hello") throw new Error("Hello required");
        if (m.type === "hello") {
          if (a.hello) throw new Error("Duplicate hello");
          a.hello = true;
          clearTimeout(helloTimer);
          await sql`UPDATE servers SET info=${sql.json(m.info)},last_seen=now() WHERE id=${id}`;
          send(ws, { v: 1, type: "welcome", intervalSeconds: 5 });
          broadcast();
        } else if (m.type === "metrics") {
          await ingest(id, m.samples);
          send(ws, {
            v: 1,
            type: "metrics.ack",
            bootId: m.samples.at(-1)!.bootId,
            seq: m.samples.at(-1)!.seq,
          });
        } else if (m.type === "check.result") {
          if (Math.abs(Date.now() - Date.parse(m.result.at)) > 120000) return;
          const task = checkPending.get(m.result.id);
          if (!task || task.serverId !== id) return;
          checkPending.delete(m.result.id);
          await saveCheck(m.result, id);
        } else if (m.type === "diagnostic.result") {
          await sql`UPDATE diagnostic_jobs SET state=${m.ok ? "done" : "failed"},result=${m.result} WHERE id=${m.id} AND server_id=${id} AND state='running' AND expires_at>now()`;
        }
      })
      .catch((e) => {
        logError("agent message", e);
        ws.close(1008, "Invalid message or persistence failure");
      })
      .finally(() => {
        a.pending--;
      });
  });
  ws.on("close", () => {
    clearTimeout(helloTimer);
    if (agents.get(id) === a) {
      agents.delete(id);
      for (const t of terminals.values())
        if (t.nodeId === id) closeTerminal(t.id, "Agent disconnected");
      broadcast();
    }
  });
}
function attachBrowserTerminal(ws: WebSocket, user: Awaited<ReturnType<typeof owner>>) {
  let terminalId: string | undefined,
    authenticating = false;
  const timer = setTimeout(() => {
    if (!terminalId) ws.close(1008, "Ticket required");
  }, 5000);
  ws.on("message", (data, binary) => {
    if (binary || Buffer.byteLength(data as Buffer) > 16384) {
      ws.close(1008, "Invalid message");
      return;
    }
    void (async () => {
      const m = JSON.parse(data.toString());
      if (!terminalId) {
        if (authenticating) throw new Error("Authentication pending");
        authenticating = true;
        const x = z
          .object({ type: z.literal("auth"), ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
          .parse(m);
        const [ticket] =
          await sql`DELETE FROM terminal_tickets WHERE token_hash=${hash(x.ticket)} AND session_hash=${user.token_hash} AND user_id=${user.id} AND expires_at>now() RETURNING server_id`;
        if (!ticket) throw new Error("Invalid ticket");
        const a = agents.get(ticket.server_id);
        if (!a?.hello) throw new Error("Agent offline");
        if (
          terminals.size >= 32 ||
          [...terminals.values()].filter((t) => t.userId === user.id).length >= 4
        )
          throw new Error("Terminal limit");
        const id = randomUUID(),
          stream = token();
        terminalId = id;
        clearTimeout(timer);
        const t: Terminal = {
          id,
          nodeId: ticket.server_id,
          userId: user.id,
          session: user.token_hash,
          client: ws,
          streamHash: hash(stream),
          opened: Date.now(),
          lastInput: Date.now(),
        };
        terminals.set(id, t);
        await sql`INSERT INTO terminal_sessions(id,user_id,server_id) VALUES(${id},${user.id},${ticket.server_id})`;
        if (ws.readyState !== WebSocket.OPEN) {
          closeTerminal(id, "Browser disconnected");
          return;
        }
        send(a.ws, { v: 1, type: "terminal.open", id, streamToken: stream });
        await audit(user.id, "terminal.opened", ticket.server_id, { sessionId: id });
      } else {
        const t = terminals.get(terminalId);
        if (!t?.agent) return;
        const x = z
          .discriminatedUnion("type", [
            z.object({ type: z.literal("input"), data: z.string().max(8192) }),
            z.object({
              type: z.literal("resize"),
              cols: z.number().int().min(2).max(500),
              rows: z.number().int().min(2).max(300),
            }),
          ])
          .parse(m);
        t.lastInput = Date.now();
        if (!send(t.agent, x)) closeTerminal(t.id, "Backpressure");
      }
    })().catch(() => {
      ws.close(1008, "Terminal authorization or protocol failed");
    });
  });
  ws.on("close", () => {
    clearTimeout(timer);
    if (terminalId) closeTerminal(terminalId, "Browser disconnected");
  });
}
function attachTerminalAgent(ws: WebSocket, t: Terminal) {
  if (t.agent) {
    ws.close(1008, "Already connected");
    return;
  }
  t.agent = ws;
  t.streamHash = "";
  send(t.client, { type: "ready", id: t.id });
  ws.on("message", (data, binary) => {
    if (!binary || Buffer.byteLength(data as Buffer) > 16384) {
      closeTerminal(t.id, "Invalid terminal output");
      return;
    }
    if (t.client.readyState !== WebSocket.OPEN || t.client.bufferedAmount > 1024 * 1024) {
      closeTerminal(t.id, "Backpressure");
      return;
    }
    t.client.send(data, { binary: true });
  });
  ws.on("close", () => closeTerminal(t.id, "Shell exited"));
}
const checkPending = new Map<string, { serverId: string; sent: number }>();
async function saveCheck(result: z.infer<typeof checkResultSchema>, serverId: string | null) {
  await sql.begin(async (tx) => {
    const updated =
      await tx`UPDATE checks SET latest=${sql.json(result)} WHERE id=${result.id} AND server_id IS NOT DISTINCT FROM ${serverId}::uuid AND enabled=true RETURNING id`;
    if (updated.length)
      await tx`INSERT INTO check_results(check_id,checked_at,data) VALUES(${result.id},${result.at},${sql.json(result)})`;
  });
}
let checksRunning = 0;
async function dispatch() {
  const due =
    await sql`SELECT * FROM checks WHERE enabled=true AND (last_run IS NULL OR last_run<now()-interval_seconds*interval '1 second') ORDER BY last_run NULLS FIRST LIMIT 30`;
  for (const c of due) {
    if (checksRunning >= 10) break;
    await sql`UPDATE checks SET last_run=now() WHERE id=${c.id}`;
    if (c.server_id) {
      const a = agents.get(c.server_id);
      if (a?.hello) {
        checkPending.set(c.id, { serverId: c.server_id, sent: Date.now() });
        send(a.ws, { v: 1, type: "check.run", id: c.id, kind: c.kind, target: c.target });
      } else
        await saveCheck(
          {
            id: c.id,
            at: new Date().toISOString(),
            ok: false,
            latencyMs: null,
            loss: null,
            status: null,
            certificateDays: null,
            error: "Agent 离线",
          },
          c.server_id,
        );
    } else {
      checksRunning++;
      void runCheck({ id: c.id, kind: c.kind, target: c.target })
        .then((r) => saveCheck(r, null))
        .catch((e) => logError("check", e))
        .finally(() => {
          checksRunning--;
        });
    }
  }
  for (const [id, p] of checkPending)
    if (Date.now() - p.sent > 20000) {
      checkPending.delete(id);
      await saveCheck(
        {
          id,
          at: new Date().toISOString(),
          ok: false,
          latencyMs: null,
          loss: null,
          status: null,
          certificateDays: null,
          error: "检查响应超时",
        },
        p.serverId,
      );
    }
  const jobs =
    await sql`UPDATE diagnostic_jobs SET state='running' WHERE id IN (SELECT id FROM diagnostic_jobs WHERE state='queued' AND expires_at>now() ORDER BY created_at LIMIT 20) RETURNING *`;
  for (const j of jobs) {
    const a = agents.get(j.server_id);
    if (a?.hello)
      send(a.ws, { v: 1, type: "diagnostic.run", id: j.id, kind: j.kind, unit: j.unit });
    else await sql`UPDATE diagnostic_jobs SET state='failed',result='Agent 离线' WHERE id=${j.id}`;
  }
  await sql`UPDATE diagnostic_jobs SET state='failed',result='任务超时' WHERE state IN('queued','running') AND expires_at<now()`;
}
async function validateConnections() {
  // Detect loss of the lease connection before continuing to act as the control plane.
  try {
    const [held] =
      await lease`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=0 AND objid=741829004 AND objsubid=1 AND granted) AS held`;
    if (!held.held) throw new Error("Gateway lease lost");
  } catch {
    await shutdown();
    return;
  }
  for (const [ip, w] of upgradeWindows) if (Date.now() - w.start > 60000) upgradeWindows.delete(ip);
  const validNodes = await sql`SELECT id,token_hash FROM servers WHERE revoked=false`;
  const nodeTokens = new Map(validNodes.map((n) => [n.id, n.token_hash]));
  for (const [id, a] of agents)
    if (nodeTokens.get(id) !== a.tokenHash) {
      a.ws.close(1008, "Credential revoked");
      for (const t of terminals.values())
        if (t.nodeId === id) closeTerminal(t.id, "Credential revoked");
    }
  const sessionHashes = [
    ...new Set(
      [...browsers].map((b) => b.session).concat([...terminals.values()].map((t) => t.session)),
    ),
  ];
  if (sessionHashes.length) {
    const valid =
      await sql`SELECT s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash IN ${sql(sessionHashes)} AND s.expires_at>now() AND u.role='owner'`;
    const set = new Set(valid.map((s) => s.token_hash));
    for (const b of browsers) if (!set.has(b.session)) b.ws.close(1008, "Session expired");
    for (const t of terminals.values())
      if (!set.has(t.session)) closeTerminal(t.id, "Session expired");
  }
  for (const t of terminals.values())
    if (
      (!t.agent && Date.now() - t.opened > 10000) ||
      Date.now() - t.lastInput > 15 * 60000 ||
      Date.now() - t.opened > 3600000
    )
      closeTerminal(t.id, "Terminal timed out");
}
const timers: NodeJS.Timeout[] = [];
function periodic(ms: number, work: () => Promise<unknown>) {
  let busy = false;
  timers.push(
    setInterval(() => {
      if (busy || stopping) return;
      busy = true;
      void work()
        .catch((e) => logError("background task", e))
        .finally(() => {
          busy = false;
        });
    }, ms),
  );
}
await ensurePartitions();
await sql`UPDATE terminal_sessions SET ended_at=now(),reason='Gateway restarted' WHERE ended_at IS NULL`;
server.listen(cfg.gatewayPort, cfg.gatewayHost, () =>
  console.log(`Blink gateway listening on ${cfg.gatewayHost}:${cfg.gatewayPort}`),
);
periodic(2000, dispatch);
periodic(10000, validateConnections);
periodic(15000, async () => {
  const live: string[] = [];
  for (const [ws, last] of liveness) {
    if (Date.now() - last > 45000) ws.terminate();
    else if (ws.readyState === WebSocket.OPEN) ws.ping();
  }
  for (const [id, a] of agents)
    if (a.hello && Date.now() - (liveness.get(a.ws) ?? 0) < 30000) live.push(id);
  if (live.length) await sql`UPDATE servers SET last_seen=now() WHERE id IN ${sql(live)}`;
});
periodic(5000, async () => {
  broadcast();
});
periodic(15000, evaluateAlerts);
periodic(5000, deliverNotifications);
periodic(60000, aggregate);
periodic(3600000, retention);
async function shutdown() {
  if (stopping) return;
  stopping = true;
  timers.forEach(clearInterval);
  for (const id of [...terminals.keys()]) closeTerminal(id, "Gateway stopping");
  for (const ws of wss.clients) ws.terminate();
  server.close();
  lease.release();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
