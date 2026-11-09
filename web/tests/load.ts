import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";
import net from "node:net";
import postgres from "postgres";
import { WebSocket } from "ws";
const exec = promisify(execFile),
  count = 300,
  rounds = 6;
async function freePort() {
  const s = net.createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
const [pgPort, gatewayPort] = await Promise.all([freePort(), freePort()]);
const name = `blink-load-${randomBytes(4).toString("hex")}`,
  password = randomBytes(32).toString("hex"),
  local = resolve("../.local");
await mkdir(local, { recursive: true });
const dir = await mkdtemp(resolve(local, "load-"));
const env = {
  ...process.env,
  DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${pgPort}/blink`,
  ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  PUBLIC_URL: "http://localhost:3000",
  ALLOW_INSECURE_LOCALHOST: "true",
  TRUST_PROXY: "false",
  GATEWAY_PORT: String(gatewayPort),
  GATEWAY_HOST: "127.0.0.1",
};
const sql = postgres(env.DATABASE_URL, { max: 3, onnotice: () => {} });
let created = false,
  gateway: ReturnType<typeof spawn> | undefined;
const connections: WebSocket[] = [],
  timers: NodeJS.Timeout[] = [];
async function waitFor(fn: () => Promise<boolean>, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("load-test readiness timeout");
}
try {
  await exec(
    "docker",
    [
      "run",
      "--rm",
      "-d",
      "--name",
      name,
      "-e",
      "POSTGRES_PASSWORD",
      "-e",
      "POSTGRES_DB=blink",
      "-p",
      `127.0.0.1:${pgPort}:5432`,
      "--tmpfs",
      "/var/lib/postgresql:rw",
      "postgres:18",
    ],
    { env: { ...env, POSTGRES_PASSWORD: password } },
  );
  created = true;
  await waitFor(async () => {
    await sql`SELECT 1`;
    return true;
  });
  await exec(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], { env });
  const nodes = Array.from({ length: count }, (_, i) => {
    const credential = randomBytes(32).toString("base64url");
    return {
      id: randomUUID(),
      name: `load-${String(i).padStart(3, "0")}`,
      token_hash: createHash("sha256").update(credential).digest("hex"),
      credential,
      bootId: randomUUID(),
    };
  });
  await sql`INSERT INTO servers ${sql(
    nodes.map((n) => ({ id: n.id, name: n.name, token_hash: n.token_hash })),
    "id",
    "name",
    "token_hash",
  )}`;
  gateway = spawn(process.execPath, ["--import", "tsx", "realtime/index.ts"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = createWriteStream(resolve(dir, "gateway.log"));
  gateway.stdout?.pipe(log);
  gateway.stderr?.pipe(log);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${gatewayPort}/healthz`)).ok);
  const latencies: number[] = [],
    sent = new Map<string, number>();
  let acks = 0,
    failures = 0;
  const started = Date.now();
  await Promise.all(
    nodes.map(async (n, index) => {
      await new Promise((r) => setTimeout(r, index * 4));
      const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws/agent`, {
        headers: { Authorization: `Bearer ${n.credential}` },
      });
      connections.push(ws);
      ws.on("error", () => failures++);
      await once(ws, "open");
      const ready = new Promise<void>((resolve) =>
        ws.on("message", (data) => {
          const m = JSON.parse(data.toString());
          if (m.type === "welcome") resolve();
          if (m.type === "metrics.ack") {
            const t = sent.get(`${n.id}:${m.seq}`);
            if (t) {
              latencies.push(Date.now() - t);
              acks++;
            }
          }
        }),
      );
      ws.send(
        JSON.stringify({
          v: 1,
          type: "hello",
          info: {
            hostname: n.name,
            os: "Linux load simulator",
            kernel: "6.8",
            arch: "x86_64",
            cpuModel: "simulated",
            cpuCount: 2,
            version: "0.1.0",
            terminal: false,
            diagnostics: false,
          },
        }),
      );
      await ready;
      function sample(seq: number) {
        const at = new Date().toISOString();
        sent.set(`${n.id}:${seq}`, Date.now());
        ws.send(
          JSON.stringify({
            v: 1,
            type: "metrics",
            samples: [
              {
                bootId: n.bootId,
                seq,
                at,
                uptime: 100 + seq,
                cpu: 20 + (index % 50),
                cores: [20, 20],
                load: [0.5, 0.5, 0.5],
                memoryTotal: 2147483648,
                memoryUsed: 1073741824,
                swapTotal: 0,
                swapUsed: 0,
                disks: [
                  {
                    name: "/dev/vda",
                    mount: "/",
                    total: 21474836480,
                    used: 10737418240,
                    inodesTotal: 100000,
                    inodesUsed: 1000,
                  },
                ],
                networks: [
                  {
                    name: "eth0",
                    rx: seq * 1000,
                    tx: seq * 500,
                    rxDelta: 1000,
                    txDelta: 500,
                    rxRate: 200,
                    txRate: 100,
                  },
                ],
                diskReadRate: 1024,
                diskWriteRate: 512,
                temperatures: [],
              },
            ],
          }),
        );
      }
      for (let round = 1; round <= rounds; round++)
        timers.push(setTimeout(() => sample(round), (round - 1) * 5000));
    }),
  );
  await waitFor(async () => acks === count * rounds, 60000);
  const [stored] =
    await sql`SELECT count(*)::int AS samples,count(DISTINCT server_id)::int AS nodes FROM metric_samples`;
  assert.equal(failures, 0);
  assert.equal(stored.nodes, count);
  assert.equal(stored.samples, count * rounds);
  const [traffic] = await sql`SELECT sum(rx+tx)::text AS total FROM traffic_daily`;
  assert.equal(Number(traffic.total), count * rounds * 1500);
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  assert(p95 < 5000, `p95 ${p95}ms exceeds sampling interval`);
  const report = {
    nodes: count,
    samples: stored.samples,
    acks,
    failures,
    durationMs: Date.now() - started,
    ackP50Ms: latencies[Math.floor(latencies.length * 0.5)],
    ackP95Ms: p95,
    ackMaxMs: latencies.at(-1),
  };
  await writeFile(resolve(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Load test evidence: ${dir}`);
} finally {
  timers.forEach(clearTimeout);
  connections.forEach((w) => w.terminate());
  if (gateway && gateway.exitCode === null) {
    gateway.kill("SIGTERM");
    await Promise.race([
      once(gateway, "exit"),
      new Promise<void>((r) =>
        setTimeout(() => {
          gateway?.kill("SIGKILL");
          r();
        }, 5000),
      ),
    ]);
  }
  await sql.end();
  if (created) await exec("docker", ["stop", name]).catch(() => {});
}
