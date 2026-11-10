import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { chromium } from "@playwright/test";

const exec = promisify(execFile);
const pgName = `blink-subscriptions-${randomBytes(5).toString("hex")}`;
const children: ReturnType<typeof spawn>[] = [];
await mkdir(resolve("../.local"), { recursive: true });
const dir = await mkdtemp(resolve("../.local/subscriptions-"));
let pgCreated = false;
let closeDb: (() => Promise<void>) | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let agent: WebSocket | undefined;

async function freePort() {
  const socket = net.createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((done) => socket.close(() => done()));
  return port;
}
async function waitFor(check: () => Promise<boolean>, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      if (await check()) return;
    } catch {
      /* service starting */
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error("Service or database state did not become ready");
}
function start(name: string, args: string[]) {
  const child = spawn(process.execPath, args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = createWriteStream(resolve(dir, `${name}.log`));
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  children.push(child);
}

try {
  const [webPort, gatewayPort] = await Promise.all([freePort(), freePort()]);
  const origin = `http://localhost:${webPort}`;
  const password = randomBytes(24).toString("hex");
  await exec("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    pgName,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_DB=blink",
    "-p",
    "127.0.0.1::5432",
    "postgres:17-alpine",
  ]);
  pgCreated = true;
  const binding = (await exec("docker", ["port", pgName, "5432/tcp"])).stdout.trim();
  Object.assign(process.env, {
    DATABASE_URL: `postgres://postgres:${password}@${binding}/blink`,
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    PUBLIC_URL: origin,
    ALLOW_INSECURE_LOCALHOST: "true",
    TRUST_PROXY: "true",
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_PORT: String(gatewayPort),
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
  });
  const { sql } = await import("../src/db");
  closeDb = () => sql.end();
  await waitFor(async () => {
    await sql`SELECT 1`;
    return true;
  });
  for (const file of (await readdir("drizzle")).filter((f) => f.endsWith(".sql")).sort())
    await sql.unsafe(await readFile(`drizzle/${file}`, "utf8"));
  const { token, hash, encrypt } = await import("../src/server/crypto");
  const { instanceInput, credentials } = await import("../src/server/proxy-model");
  const owner = randomUUID(),
    member = randomUUID(),
    session = token(),
    memberSession = token(),
    staleSession = token();
  for (const [id, role] of [
    [owner, "owner"],
    [member, "member"],
  ])
    await sql`INSERT INTO users(id,username,role,password_hash,totp_secret) VALUES(${id},${role},${role},'test','test')`;
  for (const [raw, id] of [
    [session, owner],
    [memberSession, member],
    [staleSession, owner],
  ])
    await sql`INSERT INTO sessions(token_hash,user_id,expires_at,elevated_until) VALUES(${hash(raw)},${id},now()+interval '1 hour',now()+interval '1 hour')`;
  await sql`UPDATE sessions SET elevated_until=now()-interval '1 hour' WHERE token_hash=${hash(staleSession)}`;
  const servers = [randomUUID(), randomUUID(), randomUUID()];
  const agentToken = token();
  for (const [index, id] of servers.entries()) {
    await sql`INSERT INTO servers(id,name,info,last_seen,token_hash) VALUES(${id},${["东京 · 主节点", "香港 · IPv6", "普通监控节点"][index]},${sql.json({ os: index ? "Alpine Linux 3.22" : "Ubuntu 24.04 LTS", arch: "x86_64", cpuCount: 2 })},now()-interval '1 day',${index === 2 ? hash(agentToken) : null})`;
    if (index < 2)
      await sql`INSERT INTO proxy_hosts(server_id,addresses,desired_version,applied_version) VALUES(${id},${index ? ["2606:4700::1111"] : ["8.8.8.8", "2606:4700::1001"]},1,1)`;
  }
  const reality = randomUUID(),
    anytls = randomUUID(),
    exit = randomUUID(),
    pending = randomUUID();
  const realitySecret = credentials("reality");
  const specialPassword = "a+b/c==:@#?%";
  for (const [id, kind, name, server, state] of [
    [reality, "reality", "日本 REALITY 入口", servers[0], "active"],
    [anytls, "anytls", "IPv6 入口", servers[1], "active"],
    [exit, "shadowsocks2022", "SS2022 落地", servers[0], "active"],
    [pending, "anytls", "部署中入口", servers[0], "pending"],
  ]) {
    const spec = instanceInput.parse({
      serverId: server,
      kind,
      name,
      port: kind === "shadowsocks2022" ? 8388 : 443,
      domain: "node.example.com",
      upstream: "https://example.com",
      manageDns: false,
    });
    const secret =
      kind === "reality"
        ? realitySecret
        : kind === "anytls"
          ? { password: specialPassword }
          : credentials("shadowsocks2022");
    await sql`INSERT INTO proxy_instances(id,server_id,name,kind,spec,state,encrypted_credentials) VALUES(${id},${server},${name},${kind},${sql.json(spec)},${state},${encrypt(JSON.stringify(secret))})`;
  }

  start("web", [
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(webPort),
  ]);
  start("gateway", ["--import", "tsx", "realtime/index.ts"]);
  await Promise.all([
    waitFor(async () => (await fetch(`${origin}/login`)).status === 200),
    waitFor(async () => (await fetch(`http://127.0.0.1:${gatewayPort}/healthz`)).status === 200),
  ]);
  async function call(
    path: string,
    method = "GET",
    value?: unknown,
    options: { session?: string; origin?: string } = {},
  ) {
    return fetch(`${origin}/api/${path}`, {
      method,
      headers: {
        Cookie: `blink-dev=${options.session ?? session}`,
        Origin: options.origin ?? origin,
        "Content-Type": "application/json",
        "X-Blink-Client-IP": "127.0.0.1",
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  }
  async function ok(path: string, method = "GET", value?: unknown) {
    const response = await call(path, method, value);
    assert(response.ok, `${method} ${path} returned ${response.status}`);
    return response.json();
  }
  const base = "proxy/subscriptions";
  assert.equal((await call(base, "GET", undefined, { session: "" })).status, 401);
  assert.equal((await call(base, "GET", undefined, { session: memberSession })).status, 403);
  assert.equal((await call(base, "POST", {}, { origin: "https://evil.example.com" })).status, 403);
  assert.equal((await call(base, "POST", {}, { session: staleSession })).status, 428);

  agent = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws/agent`, {
    headers: {
      Authorization: `Bearer ${agentToken}`,
      "X-Blink-Client-IP": "::ffff:8.8.4.4",
      "X-Forwarded-For": "9.9.9.9",
    },
  });
  await once(agent, "open");
  agent.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      info: {
        hostname: "monitor",
        os: "Debian GNU/Linux 13",
        arch: "aarch64",
        kernel: "6.12",
        cpuModel: "ARM",
        cpuCount: 2,
        version: "0.1.0",
        terminal: false,
        diagnostics: false,
        proxy: false,
      },
    }),
  );
  await waitFor(
    async () =>
      (await sql`SELECT host(connection_ip) AS ip FROM servers WHERE id=${servers[2]}`)[0].ip ===
      "8.8.4.4",
  );
  const serverList = await ok("servers");
  assert.deepEqual(serverList.find((s: { id: string }) => s.id === servers[0]).addresses, [
    "8.8.8.8",
    "2606:4700::1001",
  ]);
  const monitor = await ok(`servers/${servers[2]}`);
  assert.equal(monitor.connection_ip, "8.8.4.4");
  assert.equal(monitor.info.os, "Debian GNU/Linux 13");
  agent.close();
  agent = undefined;

  assert.equal((await call(base, "POST", { name: "empty", nodeIds: [] })).status, 400);
  assert.equal((await call(base, "POST", { name: "exit", nodeIds: [exit] })).status, 400);
  assert.equal(
    (await sql`SELECT * FROM proxy_subscriptions`).length,
    0,
    "invalid selections roll back creation",
  );
  const created = await ok(base, "POST", { name: "日常订阅", nodeIds: [anytls, reality] });
  const rawToken = new URL(created.url).pathname.split("/").at(-1)!;
  const [stored] =
    await sql`SELECT token_hash,encrypted_token FROM proxy_subscriptions WHERE id=${created.id}`;
  assert.equal(stored.token_hash, hash(rawToken));
  assert(!stored.encrypted_token.includes(rawToken));
  const metadata = await ok(base);
  assert.equal(metadata.nodes.length, 3, "SS2022 is not offered as an entrance");
  assert(!JSON.stringify(metadata).includes(rawToken));
  assert(!JSON.stringify(metadata).includes(specialPassword));
  assert(!JSON.stringify(metadata).includes("privateKey"));
  const publicResponse = await fetch(created.url);
  assert.equal(publicResponse.status, 200, "subscription is accessible without admin cookies");
  assert.equal(publicResponse.headers.get("cache-control"), "no-store");
  assert.equal(
    Buffer.from(publicResponse.headers.get("profile-title")!.slice(7), "base64").toString(),
    "日常订阅",
  );
  const text = Buffer.from(await publicResponse.text(), "base64").toString("utf8");
  const urls = text.split("\n").map((uri) => new URL(uri));
  assert.equal(urls.length, 2, "offline agents still export deployed entrances");
  assert.equal(urls[0].protocol, "anytls:");
  assert.equal(decodeURIComponent(urls[0].username), specialPassword);
  assert.equal(urls[0].hostname, "[2606:4700::1111]");
  assert.equal(urls[1].protocol, "vless:");
  if ("privateKey" in realitySecret && realitySecret.privateKey)
    assert(!text.includes(realitySecret.privateKey));
  assert.equal((await ok(`${base}/${created.id}/link`, "POST", {})).url, created.url);
  assert.equal(
    (await call(`${base}/${created.id}/link`, "POST", {}, { session: staleSession })).status,
    428,
  );
  assert.equal((await fetch(`${origin}/sub/${token()}`)).status, 404);
  assert.equal((await fetch(`${origin}/sub/not-a-token`)).status, 404);
  await ok(`${base}/${created.id}`, "PATCH", { enabled: false });
  await ok(`${base}/${created.id}`, "PATCH", { name: "已改名" });
  assert.equal(
    (await fetch(created.url)).status,
    404,
    "renaming does not re-enable disabled subscriptions",
  );
  await ok(`${base}/${created.id}`, "PATCH", { enabled: true, name: "日常订阅" });
  const rotated = await ok(`${base}/${created.id}/rotate`, "POST", {});
  assert.notEqual(rotated.url, created.url);
  assert.equal((await fetch(created.url)).status, 404);
  assert.equal((await fetch(rotated.url)).status, 200);

  // Real browser flow: create, copy, reload, edit, retain input after a failed save.
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: "blink-dev", value: session, url: origin }]);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/`);
  await page.getByRole("textbox", { name: "搜索服务器" }).fill("8.8.4.4");
  await page.getByRole("link", { name: "普通监控节点", exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "东京 · 主节点", exact: true }).count(), 0);
  await page.getByRole("textbox", { name: "搜索服务器" }).fill("Ubuntu");
  await page.getByRole("link", { name: "东京 · 主节点", exact: true }).waitFor();
  await page.getByRole("button", { name: "复制 8.8.8.8", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "8.8.8.8");
  await page.getByRole("textbox", { name: "搜索服务器" }).fill("");
  await page.screenshot({ path: resolve(dir, "servers-desktop.png") });
  await page.getByRole("link", { name: "代理订阅", exact: true }).click();
  await page.getByRole("heading", { name: "日常订阅", exact: true }).waitFor();
  await page.screenshot({ path: resolve(dir, "subscriptions-desktop.png") });
  await page.getByRole("button", { name: "创建订阅", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("订阅名称").fill("手机使用");
  await dialog.getByRole("checkbox", { name: /IPv6 入口/ }).check();
  await dialog.getByRole("checkbox", { name: /日本 REALITY 入口/ }).check();
  await page.screenshot({ path: resolve(dir, "subscription-editor-desktop.png") });
  await dialog.getByRole("button", { name: "创建订阅", exact: true }).click();
  await page.getByRole("heading", { name: "订阅链接", exact: true }).waitFor();
  const uiUrl = await page.getByRole("textbox", { name: "订阅 URL" }).inputValue();
  await page.getByRole("button", { name: "复制订阅链接", exact: true }).click();
  await page.getByRole("button", { name: "已复制订阅链接" }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), uiUrl);
  assert.equal((await fetch(uiUrl)).status, 200);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.reload();
  await page.getByRole("heading", { name: "手机使用", exact: true }).waitFor();
  const uiItem = (await ok(base)).subscriptions.find(
    (s: { name: string }) => s.name === "手机使用",
  );
  const row = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "手机使用", exact: true }) });
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("订阅名称").fill("手机 · 已编辑");
  const editPath = `**/api/${base}/${uiItem.id}`;
  await page.route(editPath, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "测试保存失败，请重试" }),
    }),
  );
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  await dialog.getByText("测试保存失败，请重试", { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel("订阅名称").inputValue(), "手机 · 已编辑");
  assert.equal(await dialog.getByRole("checkbox", { name: /IPv6 入口/ }).isChecked(), true);
  await page.unroute(editPath);
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByRole("heading", { name: "手机 · 已编辑", exact: true }).waitFor();
  assert.equal(
    (await ok(base)).subscriptions.find((s: { id: string }) => s.id === uiItem.id).name,
    "手机 · 已编辑",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(dir, "subscriptions-mobile.png") });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "mobile page must not overflow horizontally",
  );
  await page.getByRole("button", { name: "创建订阅", exact: true }).click();
  await page.getByRole("dialog").getByLabel("订阅名称").fill("移动端订阅");
  await page.screenshot({ path: resolve(dir, "subscription-editor-mobile.png") });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  assert.deepEqual(errors, [], "browser must not report uncaught application errors");

  // Dynamic export must reflect updates and deletion without regenerating the URL.
  await sql`UPDATE proxy_hosts SET addresses=ARRAY['1.1.1.1'] WHERE server_id=${servers[0]}`;
  assert(
    Buffer.from(await (await fetch(rotated.url)).text(), "base64")
      .toString()
      .includes("@1.1.1.1:443"),
  );
  await sql`UPDATE proxy_hosts SET desired_version=2 WHERE server_id=${servers[0]}`;
  assert.equal(
    Buffer.from(await (await fetch(rotated.url)).text(), "base64")
      .toString()
      .split("\n").length,
    1,
  );
  await sql`UPDATE proxy_hosts SET applied_version=2 WHERE server_id=${servers[0]}`;
  await sql`UPDATE servers SET revoked=true WHERE id=${servers[1]}`;
  assert.equal(
    Buffer.from(await (await fetch(rotated.url)).text(), "base64")
      .toString()
      .split("\n").length,
    1,
  );
  await sql`UPDATE servers SET revoked=false WHERE id=${servers[1]}`;
  await sql`UPDATE proxy_instances SET encrypted_credentials=${encrypt("{}")} WHERE id=${anytls}`;
  assert(
    (await ok(base)).nodes.find((n: { instanceId: string }) => n.instanceId === anytls).reason,
  );
  await sql`UPDATE proxy_instances SET encrypted_credentials=${encrypt(JSON.stringify({ password: specialPassword }))} WHERE id=${anytls}`;
  await sql`DELETE FROM proxy_instances WHERE id=${reality}`;
  const deletedNode = (await ok(base)).subscriptions.find(
    (s: { id: string }) => s.id === created.id,
  ).nodes[1];
  assert.equal(deletedNode.instanceId, null);
  assert.equal(deletedNode.reason, "入口已删除");
  await sql`UPDATE proxy_instances SET state='disabled' WHERE id=${anytls}`;
  const empty = await fetch(rotated.url);
  assert.equal(empty.status, 503);
  assert.equal(empty.headers.get("retry-after"), "300");
  await ok(`${base}/${created.id}`, "DELETE");
  assert.equal((await fetch(rotated.url)).status, 404);
  assert.equal(
    (await sql`SELECT * FROM proxy_subscription_nodes WHERE subscription_id=${created.id}`).length,
    0,
  );
  assert.equal((await call(`${base}/${created.id}`, "PATCH", { name: "missing" })).status, 404);
  const audits = JSON.stringify(await sql`SELECT * FROM audit_events`);
  assert(!audits.includes(rawToken));
  assert(!audits.includes(specialPassword));
  console.log(
    `Subscription API, gateway IP capture and browser checks passed. Screenshots: ${dir}`,
  );
} finally {
  agent?.terminate();
  await browser?.close();
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(
    children.map((child) => (child.exitCode !== null ? Promise.resolve() : once(child, "exit"))),
  );
  await closeDb?.();
  if (pgCreated) await exec("docker", ["rm", "-f", pgName]).catch(() => {});
}
