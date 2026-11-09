import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import net from "node:net";
import http from "node:http";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { chromium } from "@playwright/test";
import { once } from "node:events";
import { agentVersion } from "../src/lib/agent-install";

const exec = promisify(execFile),
  children: ReturnType<typeof spawn>[] = [],
  sockets = new Set<net.Socket>();
const root = resolve(".."),
  local = resolve(root, ".local");
await mkdir(local, { recursive: true });
const dir = await mkdtemp(resolve(local, "integration-"));
const pgName = `blink-test-${randomBytes(5).toString("hex")}`;
let pgCreated = false,
  proxy: http.Server | undefined;
let closeDb: (() => Promise<void>) | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function freePort() {
  const s = net.createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
const [pgPort, webPort, gatewayPort, publicPort] = await Promise.all([
  freePort(),
  freePort(),
  freePort(),
  freePort(),
]);
const origin = `http://localhost:${publicPort}`,
  password = randomBytes(24).toString("base64url"),
  totpSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const env = {
  ...process.env,
  PUBLIC_URL: origin,
  ALLOW_INSECURE_LOCALHOST: "true",
  ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${pgPort}/blink`,
  GATEWAY_PORT: String(gatewayPort),
  GATEWAY_HOST: "127.0.0.1",
  TRUST_PROXY: "false",
  NODE_ENV: "production" as const,
  ADMIN_PASSWORD_FILE: resolve(dir, "password"),
  ADMIN_TOTP_SECRET_FILE: resolve(dir, "totp"),
  ADMIN_USERNAME: "admin",
};
Object.assign(process.env, env);
function start(name: string, command: string, args: string[], cwd = process.cwd()) {
  const p = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(p);
  const log = createWriteStream(resolve(dir, `${name}.log`));
  p.stdout?.pipe(log);
  p.stderr?.pipe(log);
  return p;
}
async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  timeout = 30000,
): Promise<T> {
  const until = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (predicate(v)) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Condition timed out: ${last instanceof Error ? last.message : "not ready"}`);
}
let cookie = "";
async function call(
  path: string,
  method = "GET",
  data?: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${origin}/api/${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method !== "GET" ? { Origin: origin, "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
async function ok<T = Record<string, unknown>>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const response = await call(path, method, data);
  const value = await response.json();
  assert(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
  return value as T;
}
async function connectWs(path: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(origin.replace("http", "ws") + path, {
    headers: { Origin: origin, Cookie: cookie, ...headers },
  });
  await once(ws, "open");
  return ws;
}
async function rejectWs(path: string, headers: Record<string, string>, expected: number) {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(origin.replace("http", "ws") + path, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("WS rejection timeout"));
    }, 5000);
    ws.on("open", () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error("Unauthorized WebSocket accepted"));
    });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      assert.equal(res.statusCode, expected);
      res.destroy();
      resolve();
    });
    ws.on("error", () => {});
  });
}
try {
  await writeFile(env.ADMIN_PASSWORD_FILE, password, { mode: 0o600 });
  await writeFile(env.ADMIN_TOTP_SECRET_FILE, totpSecret, { mode: 0o600 });
  await exec(
    "docker",
    [
      "run",
      "--rm",
      "-d",
      "--name",
      pgName,
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
  pgCreated = true;
  await waitFor(
    () => exec("docker", ["exec", pgName, "pg_isready", "-U", "postgres"]),
    (r) => r.stdout.includes("accepting connections"),
  );
  await exec(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], { env });
  await exec(process.execPath, ["--import", "tsx", "scripts/admin.ts"], { env });
  const { sql } = await import("../src/db");
  closeDb = () => sql.end();
  const { totp, token, hash, encrypt } = await import("../src/server/crypto");
  const { ingest, aggregate } = await import("../src/server/metrics");
  const { evaluateAlerts, deliverNotifications } = await import("../src/server/alerts");
  const { metricSchema } = await import("../src/server/protocol");
  start("web", process.execPath, [
    "node_modules/next/dist/bin/next",
    "start",
    "-H",
    "127.0.0.1",
    "-p",
    String(webPort),
  ]);
  const gateway = start("gateway", process.execPath, ["--import", "tsx", "realtime/index.ts"]);
  proxy = http.createServer((req, res) => {
    const gw = req.url?.startsWith("/agent/");
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: gw ? gatewayPort : webPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.statusCode = 502;
      res.end();
    });
    req.pipe(upstream);
  });
  proxy.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  proxy.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(gatewayPort, "127.0.0.1", () => {
      upstream.write(
        `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n")}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  proxy.listen(publicPort, "127.0.0.1");
  await once(proxy, "listening");
  await waitFor(
    () => fetch(`${origin}/login`),
    (r) => r.status === 200,
  );
  await waitFor(
    () => fetch(`http://127.0.0.1:${gatewayPort}/healthz`),
    (r) => r.ok,
  );
  assert.equal((await call("servers")).status, 401);
  assert.equal(
    (
      await call(
        "auth/login",
        "POST",
        { username: "admin", password, code: totp(totpSecret, Math.floor(Date.now() / 30000)) },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const login = await call("auth/login", "POST", {
    username: "admin",
    password,
    code: totp(totpSecret, Math.floor(Date.now() / 30000)),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.getSetCookie()[0].split(";")[0];
  assert(login.headers.getSetCookie()[0].includes("HttpOnly"));
  assert(login.headers.getSetCookie()[0].includes("SameSite=Strict"));
  assert.equal(
    (
      await call("auth/login", "POST", {
        username: "admin",
        password,
        code: totp(totpSecret, Math.floor(Date.now() / 30000)),
      })
    ).status,
    401,
  );
  const html = await fetch(origin, { headers: { cookie } });
  const csp = html.headers.get("content-security-policy") ?? "";
  assert(
    csp.includes("nonce-") &&
      csp.includes("frame-ancestors 'none'") &&
      !csp.includes("'unsafe-eval'"),
  );
  const session = await ok("session");
  assert.equal(session.role, "owner");
  const enrollment = await ok<{ id: string; enrollmentToken: string }>("servers", "POST", {
    name: "集成测试服务器",
    groupName: "验证环境",
    tags: ["integration"],
  });
  console.log("PASS authentication, TOTP replay, origin validation and CSP");
  const memberToken = token();
  const [member] =
    await sql`INSERT INTO users(username,password_hash,role,totp_secret) VALUES('test-member','disabled','member','disabled') RETURNING id`;
  await sql`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(${hash(memberToken)},${member.id},now()+interval '1 hour')`;
  assert.equal(
    (await call("servers", "GET", undefined, { cookie: `blink-dev=${memberToken}` })).status,
    403,
  );
  await rejectWs("/ws/live", { Origin: "https://evil.example", Cookie: cookie }, 403);
  await rejectWs("/ws/agent", {}, 401);
  console.log("PASS owner-only authorization and WebSocket origin/credential rejection");
  const tokenFile = resolve(dir, "enroll"),
    configFile = resolve(dir, "agent.toml");
  await writeFile(tokenFile, enrollment.enrollmentToken, { mode: 0o600 });
  await writeFile(
    configFile,
    `server_url = "${origin}"\nstate_file = "${resolve(dir, "identity.json")}"\nspool_file = "${resolve(dir, "spool.json")}"\nallow_insecure_localhost = true\nterminal_enabled = true\nterminal_user = "${userInfo().username}"\nallow_root_terminal = ${process.getuid?.() === 0}\n`,
    { mode: 0o600 },
  );
  await exec("cargo", ["build", "--locked"], {
    cwd: resolve(root, "agent"),
    maxBuffer: 4 * 1024 * 1024,
  });
  const agentBinary = resolve(root, "agent/target/debug/blink-agent");
  await exec(agentBinary, ["--config", configFile, "enroll", "--token-file", tokenFile], { env });
  const stolen = await fetch(`${origin}/agent/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: enrollment.enrollmentToken, credential: token() }),
  });
  assert.equal(stolen.status, 401);
  const identity = JSON.parse(await readFile(resolve(dir, "identity.json"), "utf8"));
  const agent = start("agent", agentBinary, ["--config", configFile, "run"]);
  const serverData = await waitFor(
    () => ok<{ latest: unknown; info: { terminal: boolean } }>(`servers/${enrollment.id}`),
    (s) => !!s.latest,
    30000,
  );
  assert(serverData.info.terminal);
  metricSchema.parse(serverData.latest);
  const sample = metricSchema.parse(serverData.latest);
  const before =
    await sql`SELECT coalesce(sum(rx+tx),0)::text AS n FROM traffic_daily WHERE server_id=${enrollment.id}`;
  await ingest(enrollment.id, [sample, sample]);
  const after =
    await sql`SELECT coalesce(sum(rx+tx),0)::text AS n FROM traffic_daily WHERE server_id=${enrollment.id}`;
  assert.equal(before[0].n, after[0].n);
  const old = {
    ...sample,
    seq: 900000,
    bootId: randomUUID(),
    at: new Date(Date.now() - 120000).toISOString(),
    cpu: 99,
  };
  await ingest(enrollment.id, [old]);
  await aggregate();
  const history = await ok<unknown[]>(`servers/${enrollment.id}/history?range=24h`);
  assert(history.length > 0);
  console.log("PASS real Rust enrollment, hardware telemetry, replay deduplication and rollups");
  const ticket = await ok<{ ticket: string }>(
    `servers/${enrollment.id}/terminal-ticket`,
    "POST",
    {},
  );
  const ws = await connectWs("/ws/terminal");
  let output = "",
    ready = false;
  ws.on("message", (data, binary) => {
    if (binary) output += data.toString();
    else if (JSON.parse(data.toString()).type === "ready") ready = true;
  });
  ws.send(JSON.stringify({ type: "auth", ticket: ticket.ticket }));
  await waitFor(
    async () => ready,
    (v) => v,
    15000,
  );
  ws.send(JSON.stringify({ type: "resize", cols: 110, rows: 35 }));
  ws.send(JSON.stringify({ type: "input", data: "printf 'BLINK_%s_OK\\n' TERMINAL\r" }));
  await waitFor(
    async () => output,
    (v) => v.includes("BLINK_TERMINAL_OK"),
  );
  ws.send(JSON.stringify({ type: "input", data: "stty size\r" }));
  await waitFor(
    async () => output,
    (v) => v.includes("35 110"),
  );
  // Wait until a foreground process has installed its signal handler. Sending
  // Ctrl+C and the next command together can flush the terminal input queue.
  ws.send(
    JSON.stringify({
      type: "input",
      data: `sh -c 'trap "printf CTRL_%s_OK\\\\n C; exit 0" INT; printf SLEEP_%s_READY\\\\n TEST; sleep 30'\r`,
    }),
  );
  await waitFor(
    async () => output,
    (v) => v.includes("SLEEP_TEST_READY"),
  );
  ws.send(JSON.stringify({ type: "input", data: "\u0003" }));
  await waitFor(
    async () => output,
    (v) => v.includes("CTRL_C_OK"),
  );
  const replay = await connectWs("/ws/terminal");
  const replayClosed = once(replay, "close");
  replay.send(JSON.stringify({ type: "auth", ticket: ticket.ticket }));
  const [code] = await replayClosed;
  assert.equal(code, 1008);
  ws.close();
  await waitFor(
    () => sql`SELECT ended_at FROM terminal_sessions WHERE server_id=${enrollment.id}`,
    (r) => r.length > 0 && r.every((x) => x.ended_at),
  );
  const job = await ok<{ id: string }>(`servers/${enrollment.id}/diagnostics`, "POST", {
    kind: "processes",
  });
  await waitFor(
    () => ok<{ state: string; result: string }>(`jobs/${job.id}`),
    (j) => j.state === "done",
  );
  console.log(
    "PASS real PTY output, resize, Ctrl+C, single-use terminal ticket, cleanup and diagnostics",
  );
  for (const target of ["http://169.254.169.254/", "http://127.0.0.1/", "http://2130706433/"])
    assert.equal(
      (
        await call("checks", "POST", {
          name: "SSRF",
          kind: "http",
          target,
          serverId: null,
          intervalSeconds: 60,
        })
      ).status,
      400,
    );
  assert.equal(
    (await call("servers", "POST", { name: "forged" }, { Origin: "https://evil.example" })).status,
    403,
  );
  await sql`UPDATE sessions SET elevated_until=now()-interval '1 minute' WHERE token_hash=${hash(cookie.split("=")[1])}`;
  assert.equal((await call(`servers/${enrollment.id}/terminal-ticket`, "POST", {})).status, 428);
  await sql`UPDATE sessions SET elevated_until=now()+interval '10 minutes' WHERE token_hash=${hash(cookie.split("=")[1])}`;
  const rule = await ok<{ id: string }>("rules", "POST", {
    name: "测试 CPU 阈值",
    metric: "cpu",
    serverId: enrollment.id,
    threshold: 0,
    recovery: 0,
    durationSeconds: 0,
  });
  await evaluateAlerts();
  const alerts = await ok<{ rule_id: string; state: string }[]>("alerts");
  assert(alerts.some((a) => a.rule_id === rule.id && a.state === "firing"));
  await ok(`rules/${rule.id}`, "DELETE");
  const central = await ok<{ id: string }>("rules", "POST", {
    name: "Master 检查回归",
    metric: "check",
    serverId: null,
    threshold: 1,
    recovery: 0,
    durationSeconds: 0,
  });
  const [check] =
    await sql`INSERT INTO checks(name,kind,target,last_run,latest) VALUES('Master 故障测试','tcp','1.1.1.1:443',now(),${sql.json({ ok: false, at: new Date().toISOString() })}) RETURNING id`;
  await evaluateAlerts();
  assert(
    (await ok<{ rule_id: string; check_id: string; state: string }[]>("alerts")).some(
      (a) => a.rule_id === central.id && a.check_id === check.id && a.state === "firing",
    ),
  );
  await sql`UPDATE checks SET latest=${sql.json({ ok: true, at: new Date().toISOString() })} WHERE id=${check.id}`;
  await evaluateAlerts();
  assert(
    (await ok<{ rule_id: string; state: string }[]>("alerts")).some(
      (a) => a.rule_id === central.id && a.state === "resolved",
    ),
  );
  await ok(`rules/${central.id}`, "DELETE");
  await ok(`checks/${check.id}`, "DELETE");
  console.log("PASS SSRF defenses, high-privilege step-up and alert evaluation");

  browser = await chromium.launch({
    headless: true,
    args: ["--use-mock-keychain", "--password-store=basic"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  await context.addCookies([
    {
      name: "blink-dev",
      value: cookie.split("=")[1],
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (e) => browserErrors.push(e.message));
  await page.goto(origin);
  await page.getByText("集成测试服务器", { exact: true }).waitFor();
  await page.screenshot({ path: resolve(dir, "dashboard-desktop.png") });
  await page.getByRole("button", { name: "添加服务器", exact: true }).click();
  await page.getByLabel("服务器名称", { exact: true }).fill("一键安装测试");
  await page.getByRole("button", { name: "生成接入凭证", exact: true }).click();
  const installCommand = page.getByRole("textbox", { name: "一键安装命令" });
  await installCommand.waitFor();
  assert(
    (await installCommand.inputValue()).includes(`/downloads/agent/v${agentVersion}/install.sh`),
  );
  assert(!(await installCommand.inputValue()).includes("--enable-terminal"));
  await page.getByRole("checkbox", { name: "启用网页终端" }).check();
  assert((await installCommand.inputValue()).includes("--enable-terminal"));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "复制一键安装命令", exact: true }).click();
  await page.getByRole("button", { name: "已复制安装命令", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    await installCommand.inputValue(),
  );
  // Do not store an active enrollment token in screenshot artifacts.
  await installCommand.evaluate((el) => {
    (el as HTMLTextAreaElement).value = (el as HTMLTextAreaElement).value.replace(
      /[A-Za-z0-9_-]{43}/g,
      "<一次性接入凭证已隐藏>",
    );
  });
  await page.screenshot({ path: resolve(dir, "one-click-install.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "集成测试服务器", exact: true }).click();
  await page.getByRole("heading", { name: "历史趋势" }).waitFor();
  await page.screenshot({ path: resolve(dir, "detail-desktop.png") });
  await page.getByRole("tab", { name: "网页终端" }).click();
  await page.getByRole("button", { name: "连接终端", exact: true }).click();
  await page.getByText("已连接", { exact: true }).waitFor();
  await page.locator(".xterm-helper-textarea").fill("printf 'BROWSER_%s_OK\\n' PTY");
  await page.keyboard.press("Enter");
  await waitFor(
    async () => page.locator(".xterm-rows").innerText(),
    (v) => v.includes("BROWSER_PTY_OK"),
  );
  await page.screenshot({ path: resolve(dir, "terminal-desktop.png") });
  await page.getByRole("button", { name: "关闭会话 1", exact: true }).click();
  await page.getByRole("tab", { name: "服务器设置" }).click();
  await page.locator('textarea[name="notes"]').fill("已验证保存与刷新");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByText("设置已保存", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("tab", { name: "服务器设置" }).click();
  assert.equal(await page.locator('textarea[name="notes"]').inputValue(), "已验证保存与刷新");
  await page.goto(`${origin}/checks`);
  await page.getByRole("button", { name: "添加检查" }).first().click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({ path: resolve(dir, "check-dialog.png") });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await sql`UPDATE servers SET info=info || '{"proxy":true}'::jsonb WHERE id=${enrollment.id}`;
  const { receiveProxyStatus } = await import("../src/server/proxy");
  await sql`INSERT INTO proxy_hosts(server_id) VALUES(${enrollment.id}) ON CONFLICT DO NOTHING`;
  const nodeStatus = {
    checkedAt: new Date().toISOString(),
    network: {
      checkedAt: new Date().toISOString(),
      addresses: [
        { address: "1.1.1.1", source: "interface", interface: "eth0" },
        { address: "2606:4700::1111", source: "ip.sb" },
      ],
    },
    ufwState: "active",
    ufw: "Status: active\nDefault: deny (incoming), allow (outgoing)\n22/tcp ALLOW Anywhere",
  };
  await receiveProxyStatus(enrollment.id, nodeStatus);
  await page.goto(`${origin}/proxies`);
  await page.getByRole("combobox", { name: "代理服务器" }).selectOption(enrollment.id);
  await waitFor(
    () => page.getByLabel("公网 IP（IPv4 / IPv6）").inputValue(),
    (value) => value === "1.1.1.1, 2606:4700::1111",
  );
  await page.getByText("已启用", { exact: true }).waitFor();
  await page.getByText("查看 UFW 状态与规则", { exact: true }).click();
  await page.getByText(/22\/tcp ALLOW Anywhere/).waitFor();
  await page.getByLabel("公网 IP（IPv4 / IPv6）").fill("8.8.8.8");
  await receiveProxyStatus(enrollment.id, {
    ...nodeStatus,
    ufwState: "inactive",
    ufw: "Status: inactive",
  });
  await page.getByText("未启用", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("公网 IP（IPv4 / IPv6）").inputValue(),
    "8.8.8.8",
    "status polling preserves unsaved address edits",
  );
  await page.screenshot({ path: resolve(dir, "proxy-network-mobile.png") });
  const hostSaved = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/proxy/hosts/${enrollment.id}`) && r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "保存节点设置", exact: true }).click();
  const hostResponse = await hostSaved;
  assert(hostResponse.ok(), await hostResponse.text());
  await waitFor(
    () => ok<{ addresses: string[] }>(`proxy/hosts/${enrollment.id}`),
    (h) => h.addresses[0] === "8.8.8.8",
  );
  await page.getByRole("button", { name: "安装代理", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.equal(await page.getByLabel("监听端口", { exact: true }).inputValue(), "443");
  await page.getByRole("button", { name: "添加规则", exact: true }).click();
  await page.getByLabel("规则 1 匹配值").fill("example.com");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: resolve(dir, "proxy-dialog-mobile.png") });
  await page.getByLabel("协议", { exact: true }).selectOption("shadowsocks2022");
  await page.getByLabel("名称", { exact: true }).fill("浏览器测试出口");
  await page.getByRole("button", { name: "安装并应用", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("cell", { name: /浏览器测试出口/ }).waitFor();
  await page.getByRole("cell", { name: "8.8.8.8:8388", exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: resolve(dir, "proxy-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await page.getByText("集成测试服务器", { exact: true }).waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: resolve(dir, "dashboard-mobile.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: resolve(dir, "dashboard-dark.png") });
  await page.goto(`${origin}/settings`);
  await page.getByRole("heading", { name: "安全验证" }).waitFor();
  await page.goto(`${origin}/audit`);
  await page.getByRole("heading", { name: "操作审计" }).waitFor();
  assert.deepEqual(browserErrors, []);
  await context.close();
  await browser.close();
  browser = undefined;
  console.log(
    "PASS browser desktop/mobile/dark, navigation, persisted edits and error-free hydration",
  );

  const beforeSeq = (await ok<{ latest: { seq: number } }>(`servers/${enrollment.id}`)).latest.seq;
  gateway.kill("SIGTERM");
  await once(gateway, "exit");
  // With the worker stopped, exercise durable notification transitions and
  // transport failures deterministically without sending to real recipients.
  const signingSecret = randomBytes(32).toString("hex");
  const [channel] =
    await sql`INSERT INTO channels(name,kind,encrypted_config) VALUES('test-webhook','webhook',${encrypt(JSON.stringify({ url: "https://127.0.0.1/never-contacted", secret: signingSecret }))}) RETURNING id`;
  const [notifyRule] =
    await sql`INSERT INTO alert_rules(name,metric,threshold,recovery,duration_seconds) VALUES('delivery-test','check',1,0,0) RETURNING id`;
  const [notifyCheck] =
    await sql`INSERT INTO checks(name,kind,target,last_run,latest) VALUES('delivery-test','tcp','1.1.1.1:443',now(),${sql.json({ ok: false, at: new Date().toISOString() })}) RETURNING id`;
  await evaluateAlerts();
  await evaluateAlerts();
  const deliveries =
    await sql`SELECT * FROM notification_outbox WHERE channel_id=${channel.id} AND payload->>'ruleId'=${notifyRule.id}`;
  assert.equal(deliveries.length, 1, "firing alerts must not enqueue duplicate notifications");
  const payloads: { state: string; id: string }[] = [];
  const transport: Parameters<typeof deliverNotifications>[0] = async (_url, options) => {
    const timestamp = options!.headers!["X-Blink-Timestamp"];
    assert.equal(
      options!.headers!["X-Blink-Signature"],
      `sha256=${createHmac("sha256", signingSecret).update(`${timestamp}.${options!.body}`).digest("hex")}`,
    );
    const payload = JSON.parse(options!.body!);
    if (payload.ruleId === notifyRule.id) payloads.push(payload);
    return { status: 503, certificateDays: null };
  };
  await deliverNotifications(transport);
  const [failed] = await sql`SELECT * FROM notification_outbox WHERE id=${deliveries[0].id}`;
  assert.equal(failed.attempts, 1);
  assert.equal(failed.delivered_at, null);
  assert(new Date(failed.next_attempt).getTime() > Date.now());
  await sql`UPDATE notification_outbox SET next_attempt=now() WHERE channel_id=${channel.id}`;
  await deliverNotifications(async (url, options) => {
    await transport(url, options);
    return { status: 204, certificateDays: null };
  });
  const [delivered] = await sql`SELECT * FROM notification_outbox WHERE id=${deliveries[0].id}`;
  assert.equal(delivered.attempts, 2);
  assert(delivered.delivered_at);
  assert.equal(payloads[0].id, payloads[1].id);
  await sql`UPDATE checks SET latest=${sql.json({ ok: true, at: new Date().toISOString() })} WHERE id=${notifyCheck.id}`;
  await evaluateAlerts();
  const recovery =
    await sql`SELECT payload FROM notification_outbox WHERE channel_id=${channel.id} AND payload->>'ruleId'=${notifyRule.id} AND payload->>'state'='resolved'`;
  assert.equal(recovery.length, 1);
  await sql`DELETE FROM channels WHERE id=${channel.id}`;
  await sql`DELETE FROM alert_rules WHERE id=${notifyRule.id}`;
  await sql`DELETE FROM checks WHERE id=${notifyCheck.id}`;
  console.log(
    "PASS encrypted webhook credentials, HMAC signature, deduplicated firing/recovery and durable retry",
  );
  await new Promise((r) => setTimeout(r, 6500));
  start("gateway-restart", process.execPath, ["--import", "tsx", "realtime/index.ts"]);
  await waitFor(
    () => ok<{ latest: { seq: number } }>(`servers/${enrollment.id}`),
    (s) => s.latest.seq > beforeSeq + 2,
    45000,
  );
  await ok(`servers/${enrollment.id}/revoke`, "POST", {});
  await waitFor(
    () => sql`SELECT token_hash,revoked FROM servers WHERE id=${enrollment.id}`,
    (r) => r[0].revoked && r[0].token_hash === null,
  );
  await rejectWs("/ws/agent", { Authorization: `Bearer ${identity.credential}` }, 401);
  agent.kill("SIGTERM");
  await once(agent, "exit");
  await ok("auth/logout", "POST", {});
  assert.equal((await call("servers")).status, 401);
  console.log("PASS gateway restart/reconnect, credential revocation and logout invalidation");
  await writeFile(
    resolve(dir, "verification.json"),
    JSON.stringify(
      {
        ok: true,
        date: new Date().toISOString(),
        checks: [
          "auth",
          "totp-replay",
          "csrf",
          "owner-role",
          "ws-origin",
          "enrollment",
          "rust-telemetry",
          "dedup",
          "rollup",
          "pty",
          "resize",
          "ctrl-c",
          "ticket-replay",
          "diagnostics",
          "ssrf",
          "step-up",
          "alerts",
          "browser",
          "reconnect",
          "revocation",
        ],
      },
      null,
      2,
    ),
  );
  console.log(`Integration passed. Evidence: ${dir}`);
} finally {
  if (browser) await browser.close();
  for (const p of children) if (p.exitCode === null && !p.killed) p.kill("SIGTERM");
  await Promise.all(
    children
      .filter((p) => p.exitCode === null)
      .map((p) =>
        Promise.race([
          once(p, "exit"),
          new Promise<void>((r) =>
            setTimeout(() => {
              if (p.exitCode === null) p.kill("SIGKILL");
              r();
            }, 5000),
          ),
        ]),
      ),
  );
  for (const socket of sockets) socket.destroy();
  if (proxy) await new Promise<void>((r) => proxy!.close(() => r()));
  if (closeDb) await closeDb();
  if (pgCreated) await exec("docker", ["stop", pgName]).catch(() => {});
}
