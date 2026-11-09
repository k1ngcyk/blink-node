import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, readFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { resolve } from "node:path";
import net from "node:net";
import https from "node:https";
import { WebSocket } from "ws";
import { totp } from "../src/server/crypto";
import { agentVersion } from "../src/lib/agent-install";

const exec = promisify(execFile);
const root = resolve("..");
await mkdir(resolve(root, ".local"), { recursive: true });
const dir = await mkdtemp(resolve(root, ".local/docker-"));
await chmod(dir, 0o700);
const project = `blink-smoke-${randomBytes(4).toString("hex")}`;
const listener = net.createServer().listen(0, "127.0.0.1");
await once(listener, "listening");
const port = (listener.address() as net.AddressInfo).port;
await new Promise<void>((r) => listener.close(() => r()));
const origin = `https://localhost:${port}`;
const env = { ...process.env, BLINK_DOMAIN: "localhost" };
const password = randomBytes(32).toString("hex");
const appPassword = randomBytes(32).toString("hex");
const totpSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const base = JSON.parse(
  (
    await exec(
      "docker",
      [
        "compose",
        "--profile",
        "setup",
        "-f",
        resolve(root, "deploy/compose.yml"),
        "config",
        "--format",
        "json",
      ],
      { env },
    )
  ).stdout,
);
base.name = project;
for (const [name, network] of Object.entries(base.networks))
  (network as { name: string }).name = `${project}_${name}`;
for (const [name, volume] of Object.entries(base.volumes))
  (volume as { name: string }).name = `${project}_${name}`;
const values: Record<string, string> = {
  db_admin_password: password,
  db_app_password: appPassword,
  database_url: `postgres://blink:${appPassword}@postgres:5432/blink`,
  encryption_key: randomBytes(32).toString("hex"),
  admin_password: password,
  admin_totp: totpSecret,
};
for (const [name, value] of Object.entries(values)) {
  const path = resolve(dir, name);
  await writeFile(path, value, { mode: 0o600 });
  // Local Compose bind-mounts preserve UID/mode. The 0700 parent protects host
  // access; only explicitly granted containers receive each readable file.
  await chmod(path, 0o444);
  base.secrets[name].file = path;
}
for (const name of ["web", "gateway", "migrate", "admin"]) {
  base.services[name].environment.PUBLIC_URL = origin;
  base.services[name].image = `${project}-runtime`;
  base.services[name].build = { context: resolve(root, "web"), target: "runtime" };
}
base.services.caddy.ports = [
  { target: 443, published: String(port), host_ip: "127.0.0.1", protocol: "tcp" },
];
const caddy = (await readFile(resolve(root, "deploy/Caddyfile"), "utf8")).replace(
  "{$BLINK_DOMAIN} {",
  "{$BLINK_DOMAIN} {\n  tls internal",
);
await writeFile(resolve(dir, "Caddyfile"), caddy);
base.services.caddy.volumes.find(
  (v: { target: string }) => v.target === "/etc/caddy/Caddyfile",
).source = resolve(dir, "Caddyfile");
await writeFile(
  resolve(dir, "agent.toml"),
  `server_url = "http://localhost:3001"\nallow_insecure_localhost = true\nterminal_enabled = true\nterminal_user = "blink-agent"\n`,
  { mode: 0o444 },
);
base.volumes.agent_state = { name: `${project}_agent_state` };
base.services.agent = {
  build: {
    context: root,
    dockerfile: "deploy/agent/Dockerfile.test",
    target: "agent",
    args: { AGENT_VERSION: agentVersion },
  },
  network_mode: "service:gateway",
  command: ["--config", "/etc/blink.toml", "run"],
  read_only: true,
  cap_drop: ["ALL"],
  security_opt: ["no-new-privileges:true"],
  pids_limit: 128,
  volumes: [
    {
      type: "bind",
      source: resolve(dir, "agent.toml"),
      target: "/etc/blink.toml",
      read_only: true,
    },
    {
      type: "bind",
      source: resolve(dir, "enrollment"),
      target: "/run/enrollment",
      read_only: true,
    },
    { type: "volume", source: "agent_state", target: "/var/lib/blink-agent" },
  ],
  depends_on: { gateway: { condition: "service_healthy" } },
};
await writeFile(resolve(dir, "enrollment"), "", { mode: 0o444 });
const file = resolve(dir, "compose.json");
await writeFile(file, JSON.stringify(base));
const args = ["compose", "-p", project, "-f", file];
async function compose(extra: string[], log?: string) {
  try {
    const result = await exec("docker", [...args, ...extra], { env, maxBuffer: 16 * 1024 * 1024 });
    if (log) await writeFile(resolve(dir, log), result.stdout + result.stderr);
    return result;
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string };
    await writeFile(resolve(dir, log ?? "failure.log"), (e.stdout ?? "") + (e.stderr ?? ""));
    throw new Error(`Docker ${extra.join(" ")} failed. See ${dir}/${log ?? "failure.log"}`);
  }
}
let ca: Buffer;
let cookie = "";
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return new Promise<{ status: number; headers: httpHeaders; text: string }>((resolve, reject) => {
    const req = https.request(
      `${origin}${path}`,
      {
        ca,
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json", Origin: origin } : {}),
          ...extra,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
      },
    );
    req.setTimeout(10000, () => req.destroy(new Error("HTTPS timeout")));
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
type httpHeaders = import("node:http").IncomingHttpHeaders;
async function until(fn: () => Promise<boolean>, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Docker smoke condition timed out");
}
try {
  await compose(["build"], "build.log");
  await compose(["up", "-d", "--wait", "postgres"], "postgres-start.log");
  await compose(["run", "--rm", "migrate"], "migrate.log");
  await compose(["--profile", "setup", "run", "--rm", "admin"], "admin.log");
  await compose(
    ["up", "-d", "--wait", "--wait-timeout", "120", "web", "gateway", "caddy"],
    "startup.log",
  );
  await compose([
    "cp",
    "caddy:/data/caddy/pki/authorities/local/root.crt",
    resolve(dir, "root.crt"),
  ]);
  ca = await readFile(resolve(dir, "root.crt"));
  const releasePath = `/downloads/agent/v${agentVersion}`;
  const installer = await request(`${releasePath}/install.sh`);
  assert.equal(installer.status, 200);
  assert(installer.text.includes(`VERSION="${agentVersion}"`));
  assert.equal((await request(`${releasePath}/SHA256SUMS`)).status, 200);
  for (const arch of ["amd64", "arm64"]) {
    const artifact = await request(`${releasePath}/blink-agent-linux-${arch}.tar.gz`, "HEAD");
    assert.equal(artifact.status, 200);
    assert(Number(artifact.headers["content-length"]) > 1000000);
  }
  const page = await request("/login");
  assert.equal(page.status, 200);
  assert(page.headers["strict-transport-security"]);
  assert(String(page.headers["content-security-policy"]).includes("nonce-"));
  assert.equal((await request("/api/servers")).status, 401);
  const login = await request("/api/auth/login", "POST", {
    username: "admin",
    password,
    code: totp(totpSecret, Math.floor(Date.now() / 30000)),
  });
  assert.equal(login.status, 200, login.text);
  const setCookie = login.headers["set-cookie"]![0];
  assert(setCookie.startsWith("__Host-blink="));
  assert(
    setCookie.includes("Secure") &&
      setCookie.includes("HttpOnly") &&
      setCookie.includes("SameSite=Strict"),
  );
  cookie = setCookie.split(";")[0];
  assert.equal((await request("/api/session")).status, 200);
  assert.equal(
    (await request("/api/servers", "POST", { name: "forged" }, { Origin: "https://evil.example" }))
      .status,
    403,
  );
  const created = await request("/api/servers", "POST", { name: "Docker HTTPS smoke" });
  assert.equal(created.status, 201, created.text);
  const enrollment = JSON.parse(created.text);
  await chmod(resolve(dir, "enrollment"), 0o600);
  await writeFile(resolve(dir, "enrollment"), enrollment.enrollmentToken);
  await chmod(resolve(dir, "enrollment"), 0o444);
  await compose(
    [
      "run",
      "--rm",
      "--no-deps",
      "agent",
      "--config",
      "/etc/blink.toml",
      "enroll",
      "--token-file",
      "/run/enrollment",
    ],
    "agent-enroll.log",
  );
  await compose(["up", "-d", "--no-deps", "agent"], "agent-start.log");
  await until(async () => {
    const data = JSON.parse((await request(`/api/servers/${enrollment.id}`)).text);
    await writeFile(resolve(dir, "agent-observed.json"), JSON.stringify(data));
    return !!data.latest && data.info.terminal && data.info.os.includes("Debian");
  });
  const ticket = JSON.parse(
    (await request(`/api/servers/${enrollment.id}/terminal-ticket`, "POST", {})).text,
  ).ticket;
  const terminal = new WebSocket(`${origin.replace("https", "wss")}/ws/terminal`, {
    ca,
    headers: { Origin: origin, Cookie: cookie },
  });
  let ready = false,
    output = "";
  terminal.on("message", (data, binary) => {
    if (binary) output += data.toString();
    else if (JSON.parse(data.toString()).type === "ready") ready = true;
  });
  await once(terminal, "open");
  terminal.send(JSON.stringify({ type: "auth", ticket }));
  await until(async () => ready);
  terminal.send(JSON.stringify({ type: "resize", cols: 100, rows: 32 }));
  terminal.send(
    JSON.stringify({ type: "input", data: "id -un; stty size; printf LINUX_%s_OK\\\\n PTY\r" }),
  );
  await until(
    async () =>
      output.includes("LINUX_PTY_OK") &&
      output.includes("32 100") &&
      output.includes("blink-agent"),
  );
  terminal.send(
    JSON.stringify({ type: "input", data: "sleep 300 & printf CHILD_%s_PID\\\\n $!\r" }),
  );
  await until(async () => /CHILD_(\d+)_PID/.test(output));
  const child = /CHILD_(\d+)_PID/.exec(output)![1];
  terminal.close();
  await once(terminal, "close");
  await until(async () => {
    const r = await compose(
      [
        "exec",
        "-T",
        "agent",
        "sh",
        "-c",
        `test ! -e /proc/${child}/stat || grep -q ') Z ' /proc/${child}/stat`,
      ],
      "child-cleanup.log",
    ).then(
      () => true,
      () => false,
    );
    return r;
  });
  const ws = new WebSocket(`${origin.replace("https", "wss")}/ws/live`, {
    ca,
    headers: { Origin: origin, Cookie: cookie },
  });
  const message = once(ws, "message");
  await once(ws, "open");
  assert.equal(JSON.parse(String((await message)[0])).type, "ready");
  ws.close();
  await once(ws, "close");
  const badEnrollment = await request("/agent/enroll", "POST", {
    token: randomBytes(32).toString("base64url"),
    credential: randomBytes(32).toString("base64url"),
  });
  assert.equal(badEnrollment.status, 401);
  const privileges = (
    await compose([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "blink",
      "-Atc",
      "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='blink'",
    ])
  ).stdout.trim();
  assert.equal(privileges, "f|f|f|f|f");
  const processes = (await compose(["ps", "--format", "json"])).stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((x) => {
      const value = JSON.parse(x);
      return Array.isArray(value) ? value : [value];
    });
  for (const service of processes) {
    if (service.Service !== "caddy")
      assert((service.Publishers ?? []).every((p: { PublishedPort: number }) => !p.PublishedPort));
  }
  const uid = (await compose(["exec", "-T", "web", "id", "-u"])).stdout.trim();
  assert.notEqual(uid, "0");
  const singleton = await compose(["run", "--rm", "--no-deps", "gateway"], "singleton.log").then(
    () => false,
    () => true,
  );
  assert(singleton);
  await writeFile(
    resolve(dir, "verification.json"),
    JSON.stringify(
      {
        ok: true,
        date: new Date().toISOString(),
        checks: [
          "actual-compose-build",
          "postgres-non-superuser",
          "non-root-web",
          "HTTPS-local-CA",
          "secure-cookie-login",
          "CSRF",
          "CSP",
          "WSS-proxy",
          "enrollment-proxy",
          "single-gateway",
          "private-service-ports",
          "Linux-non-root-Agent",
          "Linux-PTY-resize",
          "Linux-child-cleanup",
          "self-hosted-release-downloads",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS actual Docker deployment, HTTPS/WSS, secure login, least-privilege database and singleton gateway. Evidence: ${dir}`,
  );
} finally {
  await compose(["logs", "--no-color", "--tail", "100"], "services.log").catch(() => {});
  await compose(["down", "--volumes", "--remove-orphans"], "cleanup.log");
}
