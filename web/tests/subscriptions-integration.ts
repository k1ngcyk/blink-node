import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { chromium, expect, type WebSocketRoute } from "@playwright/test";
import jsQR from "jsqr";

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

async function decryptSubscription(response: Response, password: string) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("subscription-encryption"), "true");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = Buffer.from(await response.text(), "base64");
  const cipher = createDecipheriv(
    "aes-128-cbc",
    createHash("md5").update(password, "utf8").digest(),
    data.subarray(0, 16),
  );
  return Buffer.concat([cipher.update(data.subarray(16)), cipher.final()]).toString("utf8");
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
  // Simulate an existing installation, including subscriptions from the optional-encryption version.
  await sql`CREATE TABLE blink_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const file of (await readdir("drizzle"))
    .filter((f) => f.endsWith(".sql") && f <= "0006_subscription_encryption.sql")
    .sort()) {
    await sql.unsafe(await readFile(`drizzle/${file}`, "utf8"));
    await sql`INSERT INTO blink_migrations(name) VALUES(${file})`;
  }
  const { token, hash, encrypt, decrypt, totp } = await import("../src/server/crypto");
  const migrationIds = [randomUUID(), randomUUID(), randomUUID()];
  const migrationPassword = token();
  const previousCiphertext = encrypt(migrationPassword);
  const migrationToken = token();
  for (const [index, id] of migrationIds.entries()) {
    const raw = index === 0 ? migrationToken : token();
    await sql`INSERT INTO proxy_subscriptions(id,name,enabled,token_hash,encrypted_token,encrypted_password)
      VALUES(${id},'Legacy',${index !== 1},${hash(raw)},${encrypt(raw)},${index === 2 ? previousCiphertext : null})`;
  }
  const { migrateDatabase } = await import("../src/db/migrate");
  const encryptionKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = "invalid";
  await assert.rejects(migrateDatabase());
  process.env.ENCRYPTION_KEY = encryptionKey;
  assert.equal(
    (await sql`SELECT id FROM proxy_subscriptions WHERE encrypted_password IS NULL`).length,
    2,
  );
  assert.equal(
    (await sql`SELECT 1 FROM blink_migrations WHERE name='0007_require_subscription_encryption.ts'`)
      .length,
    0,
  );
  await migrateDatabase();
  const migrated = await sql`SELECT * FROM proxy_subscriptions ORDER BY id`;
  const migratedFirst = migrated.find((row) => row.id === migrationIds[0])!;
  const migratedSecond = migrated.find((row) => row.id === migrationIds[1])!;
  const migratedPassword = decrypt(migratedFirst.encrypted_password);
  assert.match(migratedPassword, /^[a-f0-9]{48}$/);
  assert.notEqual(migratedPassword, decrypt(migratedSecond.encrypted_password));
  assert.equal(migratedSecond.enabled, false);
  assert.equal(migratedFirst.token_hash, hash(migrationToken));
  assert.equal(decrypt(migratedFirst.encrypted_token), migrationToken);
  assert.equal(migratedFirst.display_name, null, "legacy subscriptions keep their default name");
  assert.equal(
    migrated.find((row) => row.id === migrationIds[2])!.encrypted_password,
    previousCiphertext,
  );
  await migrateDatabase();
  assert.deepEqual(
    await sql`SELECT * FROM proxy_subscriptions ORDER BY id`,
    migrated,
    "migration reruns preserve secrets",
  );
  await assert.rejects(
    sql`UPDATE proxy_subscriptions SET encrypted_password=NULL WHERE id=${migrationIds[0]}`,
  );
  const totpSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
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

  await sql`INSERT INTO proxy_subscription_nodes(subscription_id,instance_id,name,position) VALUES(${migrationIds[0]},${anytls},'legacy node',0)`;
  assert(
    (
      await decryptSubscription(await fetch(`${origin}/sub/${migrationToken}`), migratedPassword)
    ).startsWith("anytls://"),
  );
  assert.equal(
    (await ok(`${base}/${migrationIds[0]}/link`, "POST", {})).encryptionPassword,
    migratedPassword,
  );
  await sql`DELETE FROM proxy_subscriptions WHERE id IN ${sql(migrationIds)}`;
  const defaultPassword = token();
  assert.equal(
    (await call(base, "POST", { name: "empty", nodeIds: [], encryptionPassword: defaultPassword }))
      .status,
    400,
  );
  assert.equal(
    (
      await call(base, "POST", {
        name: "exit",
        nodeIds: [exit],
        encryptionPassword: defaultPassword,
      })
    ).status,
    400,
  );
  assert.equal((await call(base, "POST", { name: "no password", nodeIds: [anytls] })).status, 400);
  assert.equal(
    (
      await call(base, "POST", {
        name: "null password",
        nodeIds: [anytls],
        encryptionPassword: null,
      })
    ).status,
    400,
  );
  assert.equal(
    (await sql`SELECT * FROM proxy_subscriptions`).length,
    0,
    "invalid selections roll back creation",
  );
  const created = await ok(base, "POST", {
    name: "日常订阅",
    nodeIds: [anytls, reality],
    encryptionPassword: defaultPassword,
  });
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
  assert.equal(metadata.subscriptions[0].encrypted, true);
  assert.equal(metadata.subscriptions[0].displayName, null);
  assert(
    metadata.subscriptions[0].nodes.every(
      (node: { displayName: string | null }) => node.displayName === null,
    ),
  );
  const publicResponse = await fetch(created.url);
  assert.equal(publicResponse.status, 200, "subscription is accessible without admin cookies");
  assert.equal(publicResponse.headers.get("cache-control"), "no-store");
  assert.equal(publicResponse.headers.get("subscription-encryption"), "true");
  assert.equal(
    Buffer.from(publicResponse.headers.get("profile-title")!.slice(7), "base64").toString(),
    "日常订阅",
  );
  const text = await decryptSubscription(publicResponse, defaultPassword);
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

  // Encryption is independent of the token and node credentials, and never exposed in lists.
  const encryptionPassword = " 订阅密码🔐-0123456789 ";
  const nextPassword = randomBytes(24).toString("hex");
  assert.equal(
    (await call(base, "POST", { name: "weak", nodeIds: [anytls], encryptionPassword: "short" }))
      .status,
    400,
  );
  const encrypted = await ok(base, "POST", {
    name: "加密订阅",
    nodeIds: [anytls, reality],
    encryptionPassword,
  });
  const [encryptedRow] =
    await sql`SELECT encrypted_password FROM proxy_subscriptions WHERE id=${encrypted.id}`;
  assert.notEqual(encryptedRow.encrypted_password, encryptionPassword);
  assert.equal(decrypt(encryptedRow.encrypted_password), encryptionPassword);
  assert.equal(encrypted.encryptionPassword, encryptionPassword);
  const encryptedList = await ok(base);
  assert.equal(
    encryptedList.subscriptions.find((s: { id: string }) => s.id === encrypted.id).encrypted,
    true,
  );
  assert(!JSON.stringify(encryptedList).includes(encryptionPassword));
  assert(!JSON.stringify(encryptedList).includes(encryptedRow.encrypted_password));
  assert.equal(await decryptSubscription(await fetch(encrypted.url), encryptionPassword), text);
  const firstPayload = await (await fetch(encrypted.url)).text();
  const secondPayload = await (await fetch(encrypted.url)).text();
  assert.notEqual(firstPayload, secondPayload, "each download uses a fresh IV");
  assert(!Buffer.from(firstPayload, "base64").includes(Buffer.from(specialPassword)));
  for (const [path, method, value] of [
    [`${base}/${encrypted.id}/link`, "POST", {}],
    [`${base}/${encrypted.id}/rotate`, "POST", {}],
    [`${base}/${encrypted.id}`, "PATCH", { encryptionPassword: nextPassword }],
  ] as const) {
    assert.equal((await call(path, method, value, { session: staleSession })).status, 428);
    assert.equal((await call(path, method, value, { session: memberSession })).status, 403);
    assert.equal(
      (await call(path, method, value, { origin: "https://evil.example.com" })).status,
      403,
    );
  }
  const access = await call(`${base}/${encrypted.id}/link`, "POST", {});
  assert.equal(access.headers.get("cache-control"), "no-store");
  assert.equal((await access.json()).encryptionPassword, encryptionPassword);
  await ok(`${base}/${encrypted.id}`, "PATCH", { name: "保留密码", enabled: false });
  assert.equal((await fetch(encrypted.url)).status, 404);
  await ok(`${base}/${encrypted.id}`, "PATCH", { enabled: true });
  assert.equal(await decryptSubscription(await fetch(encrypted.url), encryptionPassword), text);
  const encryptedRotated = await ok(`${base}/${encrypted.id}/rotate`, "POST", {});
  assert.equal(encryptedRotated.encryptionPassword, encryptionPassword);
  assert.equal((await fetch(encrypted.url)).status, 404);
  assert.equal(
    await decryptSubscription(await fetch(encryptedRotated.url), encryptionPassword),
    text,
  );
  await ok(`${base}/${encrypted.id}`, "PATCH", { encryptionPassword: nextPassword });
  assert.equal(await decryptSubscription(await fetch(encryptedRotated.url), nextPassword), text);
  assert.notEqual(
    await decryptSubscription(await fetch(encryptedRotated.url), encryptionPassword).catch(
      () => null,
    ),
    text,
  );
  // A failed membership update must also roll back the new password.
  assert.equal(
    (await call(`${base}/${encrypted.id}`, "PATCH", { nodeIds: [exit], encryptionPassword }))
      .status,
    400,
  );
  assert.equal(
    (await ok(`${base}/${encrypted.id}/link`, "POST", {})).encryptionPassword,
    nextPassword,
  );
  for (const value of [null, ""]) {
    assert.equal(
      (await call(`${base}/${encrypted.id}`, "PATCH", { encryptionPassword: value })).status,
      400,
    );
    assert.equal(await decryptSubscription(await fetch(encryptedRotated.url), nextPassword), text);
  }
  await ok(`${base}/${encrypted.id}`, "PATCH", { encryptionPassword, nodeIds: [pending] });
  const unavailable = await fetch(encryptedRotated.url);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("subscription-encryption"), null);
  await ok(`${base}/${encrypted.id}`, "DELETE");
  assert.equal((await fetch(encryptedRotated.url)).status, 404);

  // Client display names belong to a subscription, never to the underlying instance.
  const clientTitle = "随身网络 / #1 & 😀";
  const realityAlias = "日本 · 自定义 #1 / 😀";
  const anytlsAlias = "香港 · 自定义 & #2";
  const named = await ok(base, "POST", {
    name: "面板内部名称",
    displayName: ` ${clientTitle} `,
    nodeIds: [anytls, reality],
    encryptionPassword: defaultPassword,
    nodeDisplayNames: { [reality]: realityAlias },
  });
  assert.equal(named.displayName, clientTitle);
  const namedResponse = await fetch(named.url);
  assert.equal(
    Buffer.from(namedResponse.headers.get("profile-title")!.slice(7), "base64").toString(),
    clientTitle,
  );
  const namedUris = (await decryptSubscription(namedResponse, defaultPassword)).split("\n");
  assert.equal(decodeURIComponent(new URL(namedUris[1]).hash.slice(1)), realityAlias);
  assert.equal(namedUris[0], text.split("\n")[0]);
  assert.equal(namedUris[1].split("#")[0], text.split("\n")[1].split("#")[0]);
  assert.equal(await decryptSubscription(await fetch(rotated.url), defaultPassword), text);
  await ok(`${base}/${named.id}`, "PATCH", { name: "仅面板改名", nodeIds: [reality, anytls] });
  await ok(`${base}/${named.id}`, "PATCH", { nodeDisplayNames: { [anytls]: anytlsAlias } });
  const namedMetadata = (await ok(base)).subscriptions.find(
    (s: { id: string }) => s.id === named.id,
  );
  assert.equal(namedMetadata.displayName, clientTitle);
  assert.deepEqual(
    namedMetadata.nodes.map((n: { displayName: string }) => n.displayName),
    [realityAlias, anytlsAlias],
  );
  assert.equal((await ok(`${base}/${named.id}/link`, "POST", {})).displayName, clientTitle);
  const namedRotated = await ok(`${base}/${named.id}/rotate`, "POST", {});
  assert.equal(namedRotated.displayName, clientTitle);
  assert.equal((await fetch(named.url)).status, 404);
  assert.deepEqual(
    (await decryptSubscription(await fetch(namedRotated.url), defaultPassword))
      .split("\n")
      .map((uri) => decodeURIComponent(new URL(uri).hash.slice(1))),
    [realityAlias, anytlsAlias],
  );
  const invalidNames = {
    displayName: "不应保存",
    nodeDisplayNames: { [anytls]: "不应保存", [pending]: "未选节点" },
  };
  const beforeInvalidNames = (await ok(base)).subscriptions.find(
    (s: { id: string }) => s.id === named.id,
  );
  assert.equal(
    (await call(`${base}/${named.id}`, "PATCH", invalidNames, { session: staleSession })).status,
    428,
  );
  assert.equal((await call(`${base}/${named.id}`, "PATCH", invalidNames)).status, 400);
  assert.deepEqual(
    (await ok(base)).subscriptions.find((s: { id: string }) => s.id === named.id),
    beforeInvalidNames,
    "invalid member aliases roll back all changes, including timestamps",
  );
  assert.equal(
    (
      await call(base, "POST", {
        name: "invalid alias",
        nodeIds: [anytls],
        encryptionPassword: defaultPassword,
        nodeDisplayNames: { [reality]: "not selected" },
      })
    ).status,
    400,
  );
  await sql`UPDATE proxy_instances SET name='源节点改名' WHERE id=${reality}`;
  assert.equal(
    decodeURIComponent(
      new URL(
        (await decryptSubscription(await fetch(namedRotated.url), defaultPassword)).split("\n")[0],
      ).hash.slice(1),
    ),
    realityAlias,
  );
  await ok(`${base}/${named.id}`, "PATCH", {
    displayName: " ",
    nodeDisplayNames: { [reality]: null, [anytls]: "" },
  });
  assert.equal((await ok(`${base}/${named.id}/link`, "POST", {})).displayName, "仅面板改名");
  assert.equal(
    decodeURIComponent(
      new URL(
        (await decryptSubscription(await fetch(namedRotated.url), defaultPassword)).split("\n")[0],
      ).hash.slice(1),
    ),
    "东京 · 主节点 · 源节点改名",
  );
  await sql`UPDATE proxy_instances SET name='日本 REALITY 入口' WHERE id=${reality}`;
  await ok(`${base}/${named.id}`, "PATCH", {
    nodeDisplayNames: { [reality]: realityAlias },
    nodeIds: [reality, anytls],
  });
  await ok(`${base}/${named.id}`, "PATCH", { nodeIds: [anytls] });
  await ok(`${base}/${named.id}`, "PATCH", { nodeIds: [reality, anytls] });
  assert.equal(
    (await ok(base)).subscriptions.find((s: { id: string }) => s.id === named.id).nodes[0]
      .displayName,
    null,
    "removing a member also removes its alias",
  );
  await ok(`${base}/${named.id}`, "DELETE");

  // Real browser flow: create, copy, reload, edit, retain input after a failed save.
  browser = await chromium.launch({
    headless: true,
    args: ["--use-mock-keychain", "--password-store=basic"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: "blink-dev", value: session, url: origin }]);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await context.newPage();
  const shot = (name: string) =>
    page.screenshot({ path: resolve(dir, name), animations: "disabled" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/`);
  await page.getByRole("textbox", { name: "搜索服务器" }).fill("8.8.4.4");
  await page.getByRole("link", { name: "普通监控节点", exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "东京 · 主节点", exact: true }).count(), 0);
  await page.getByRole("textbox", { name: "搜索服务器" }).fill("Ubuntu");
  await page.getByRole("link", { name: "东京 · 主节点", exact: true }).waitFor();
  await page.getByRole("link", { name: "东京 · 主节点", exact: true }).click();
  await page.getByRole("tab", { name: "服务器设置" }).click();
  await page.reload();
  assert.equal(
    await page.getByRole("tab", { name: "服务器设置" }).getAttribute("aria-selected"),
    "true",
  );
  await page.getByRole("link", { name: "全部服务器", exact: true }).click();
  assert.equal(
    await page.getByRole("textbox", { name: "搜索服务器" }).inputValue(),
    "Ubuntu",
    "return to list retains filters",
  );
  await page.getByRole("button", { name: "复制 8.8.8.8", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "8.8.8.8");
  await page.getByRole("textbox", { name: "搜索服务器" }).fill("");
  await expect(page.getByRole("textbox", { name: "搜索服务器" })).toHaveValue("");
  await expect(page.locator(".server-table tbody tr")).toHaveCount(3);
  await shot("servers-desktop.png");
  assert.equal(await page.locator(".os-ubuntu").count(), 1);
  assert.equal(await page.locator(".os-alpine").count(), 1);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("servers-dark.png");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("servers-mobile.png");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("dialog").getByRole("link", { name: "代理订阅", exact: true }).click();
  await page.getByRole("heading", { name: "代理订阅", exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("link", { name: "代理订阅", exact: true }).click();
  await page.getByRole("heading", { name: "日常订阅", exact: true }).waitFor();
  await shot("subscriptions-desktop.png");
  await page.getByRole("button", { name: "创建订阅", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("订阅名称", { exact: true }).fill("手机使用");
  const uiTitle = "我的小火箭 · 专用";
  const uiNodeName = "东京 · 手机专用 🚀";
  await dialog.getByLabel("Shadowrocket 订阅名称", { exact: true }).fill(uiTitle);
  await dialog.getByRole("checkbox", { name: /IPv6 入口/ }).check();
  await dialog.getByRole("checkbox", { name: /日本 REALITY 入口/ }).check();
  await dialog.getByLabel("日本 REALITY 入口 的客户端显示名称", { exact: true }).fill(uiNodeName);
  await dialog.getByRole("checkbox", { name: /日本 REALITY 入口/ }).uncheck();
  await expect(
    dialog.getByLabel("日本 REALITY 入口 的客户端显示名称", { exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: /日本 REALITY 入口/ }).check();
  await expect(
    dialog.getByLabel("日本 REALITY 入口 的客户端显示名称", { exact: true }),
  ).toHaveValue(uiNodeName);
  await expect(dialog.getByRole("button", { name: "创建订阅", exact: true })).toBeDisabled();
  assert.equal(await dialog.getByRole("checkbox", { name: /加密/ }).count(), 0);
  await dialog.getByRole("button", { name: "生成随机密码" }).click();
  const uiPassword = await dialog.getByLabel("加密密码", { exact: true }).inputValue();
  assert.match(uiPassword, /^[a-f0-9]{48}$/);
  await shot("subscription-editor-desktop.png");
  // Expiry is recovered inside the existing editor, without losing its draft.
  await sql`UPDATE users SET totp_secret=${encrypt(totpSecret)} WHERE id=${owner}`;
  await sql`UPDATE sessions SET elevated_until=now()-interval '1 minute' WHERE token_hash=${hash(session)}`;
  let createRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/${base}` && request.method() === "POST")
      createRequests++;
  });
  await dialog.getByRole("button", { name: "创建订阅", exact: true }).click();
  await page.getByRole("heading", { name: "验证身份以继续" }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 1, "verification reuses the editor surface");
  await shot("verification-desktop.png");
  const currentStep = Math.floor(Date.now() / 30000);
  const validCodes = [-1, 0, 1].map((offset) => totp(totpSecret, currentStep + offset));
  const invalidCode = ["000000", "111111", "222222", "333333"].find(
    (code) => !validCodes.includes(code),
  )!;
  await dialog.getByLabel("动态验证码", { exact: true }).fill(invalidCode);
  await dialog.getByRole("button", { name: "验证并继续", exact: true }).click();
  await dialog.getByText("动态验证码不正确", { exact: true }).waitFor();
  assert.equal(createRequests, 1, "invalid code must not replay a mutation");
  await dialog.getByRole("button", { name: "返回，保留已填内容", exact: true }).click();
  assert.equal(await dialog.getByLabel("订阅名称", { exact: true }).inputValue(), "手机使用");
  assert.equal(
    await dialog.getByLabel("Shadowrocket 订阅名称", { exact: true }).inputValue(),
    uiTitle,
  );
  assert.equal(
    await dialog.getByLabel("日本 REALITY 入口 的客户端显示名称", { exact: true }).inputValue(),
    uiNodeName,
  );
  assert.equal(await dialog.getByLabel("加密密码", { exact: true }).inputValue(), uiPassword);
  assert.equal(await dialog.getByRole("checkbox", { name: /IPv6 入口/ }).isChecked(), true);
  assert.equal((await sql`SELECT id FROM proxy_subscriptions WHERE name='手机使用'`).length, 0);
  await dialog.getByRole("button", { name: "创建订阅", exact: true }).click();
  await page.getByRole("heading", { name: "验证身份以继续" }).waitFor();
  await dialog
    .getByLabel("动态验证码", { exact: true })
    .fill(totp(totpSecret, Math.floor(Date.now() / 30000)));
  await dialog.getByLabel("动态验证码", { exact: true }).press("Enter");
  await page.getByRole("heading", { name: "订阅链接", exact: true }).waitFor();
  assert.equal(createRequests, 3, "two blocked attempts and exactly one resumed mutation");
  assert.equal((await sql`SELECT id FROM proxy_subscriptions WHERE name='手机使用'`).length, 1);
  const readQr = async () => {
    const pixels = await page
      .getByRole("img", { name: "Shadowrocket 订阅二维码" })
      .evaluate(async (element) => {
        const image = new Image();
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(element))}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(element.getBoundingClientRect().width);
        canvas.height = canvas.width;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return {
          width: canvas.width,
          height: canvas.height,
          data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
        };
      });
    const code = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
    assert(code, "rendered QR must decode at its displayed size");
    const match = /^sub:\/\/([A-Za-z0-9+/]+)\?password=([^#]+)#(.*)$/.exec(code.data);
    assert(
      match,
      "QR must match native export: unpadded standard Base64, password query, name fragment",
    );
    return {
      url: Buffer.from(match[1], "base64").toString("utf8"),
      password: decodeURIComponent(match[2]),
      name: decodeURIComponent(match[3]),
    };
  };
  const qr = await readQr();
  // Pixel decoding verifies the payload, not Shadowrocket saving its password.
  // Keep a manual fallback in the default QR view until client-side import is
  // verified, including when clipboard access is unavailable.
  assert.equal(qr.password, uiPassword);
  assert.equal(qr.name, uiTitle);
  await expect(page.getByText(/扫码可能不会自动填入 Password/)).toBeVisible();
  await expect(page.getByLabel("订阅加密密码", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  // Keep tsx/esbuild's function-name helper out of the browser execution context.
  await page.evaluate(`(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async () => {
        throw new DOMException("Permission denied", "NotAllowedError");
      },
    });
  })()`);
  await page.getByRole("button", { name: "复制密码", exact: true }).click();
  await expect(
    page.getByText("无法访问剪贴板，请显示密码后手动选择并复制", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "显示密码", exact: true }).click();
  await expect(page.getByLabel("订阅加密密码", { exact: true })).toHaveAttribute("type", "text");
  await expect(page.getByLabel("订阅加密密码", { exact: true })).toHaveValue(uiPassword);
  await page.getByRole("button", { name: "隐藏密码", exact: true }).click();
  await page.evaluate(() => Reflect.deleteProperty(navigator.clipboard, "writeText"));
  await page.getByRole("button", { name: "复制密码", exact: true }).click();
  await page.getByRole("button", { name: "已复制密码", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), uiPassword);
  await expect(
    page.getByText("无法访问剪贴板，请显示密码后手动选择并复制", { exact: true }),
  ).toHaveCount(0);
  await shot("subscription-qr-desktop.png");
  await page.emulateMedia({ colorScheme: "dark" });
  assert.deepEqual(await readQr(), qr, "QR stays scannable in dark mode");
  await shot("subscription-qr-dark.png");
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("tab", { name: "手动复制", exact: true }).click();
  const uiUrl = await page.getByRole("textbox", { name: "订阅 URL" }).inputValue();
  assert.equal(await page.getByLabel("订阅名称（Alias）", { exact: true }).inputValue(), uiTitle);
  assert.equal(qr.url, uiUrl);
  await page.getByRole("button", { name: "复制订阅链接", exact: true }).click();
  await page.getByRole("button", { name: "已复制订阅链接" }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), uiUrl);
  assert.equal(
    await page.getByLabel("订阅加密密码", { exact: true }).getAttribute("type"),
    "password",
  );
  await page.getByRole("button", { name: "已复制密码", exact: true }).click();
  await page.getByRole("button", { name: "已复制密码", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), uiPassword);
  assert((await decryptSubscription(await fetch(uiUrl), uiPassword)).includes("anytls://"));
  assert(
    (await decryptSubscription(await fetch(uiUrl), uiPassword))
      .split("\n")
      .some((uri) => decodeURIComponent(new URL(uri).hash.slice(1)) === uiNodeName),
  );
  await shot("subscription-encrypted-link-desktop.png");
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
  assert.equal(
    await dialog.getByLabel("Shadowrocket 订阅名称", { exact: true }).inputValue(),
    uiTitle,
  );
  assert.equal(
    await dialog.getByLabel("日本 REALITY 入口 的客户端显示名称", { exact: true }).inputValue(),
    uiNodeName,
  );
  const uiNextTitle = "我的小火箭 · 已改名";
  const uiNextNodeName = "东京 · 更新后的名称 #1";
  await dialog.getByLabel("Shadowrocket 订阅名称", { exact: true }).fill(uiNextTitle);
  await dialog
    .getByLabel("日本 REALITY 入口 的客户端显示名称", { exact: true })
    .fill(uiNextNodeName);
  assert.equal(await dialog.getByRole("checkbox", { name: /加密/ }).count(), 0);
  assert.equal(
    await dialog.getByLabel("加密密码", { exact: true }).inputValue(),
    "",
    "editor does not fetch the existing secret",
  );
  await dialog.getByRole("button", { name: "生成随机密码" }).click();
  const uiNextPassword = await dialog.getByLabel("加密密码", { exact: true }).inputValue();
  assert.notEqual(uiNextPassword, uiPassword);
  await dialog.getByLabel("订阅名称", { exact: true }).fill("手机 · 已编辑");
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
  assert.equal(await dialog.getByLabel("订阅名称", { exact: true }).inputValue(), "手机 · 已编辑");
  assert.equal(
    await dialog.getByLabel("Shadowrocket 订阅名称", { exact: true }).inputValue(),
    uiNextTitle,
  );
  assert.equal(
    await dialog.getByLabel("日本 REALITY 入口 的客户端显示名称", { exact: true }).inputValue(),
    uiNextNodeName,
  );
  assert.equal(await dialog.getByLabel("加密密码", { exact: true }).inputValue(), uiNextPassword);
  assert.equal(await dialog.getByRole("checkbox", { name: /IPv6 入口/ }).isChecked(), true);
  await page.unroute(editPath);
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByRole("heading", { name: "手机 · 已编辑", exact: true }).waitFor();
  assert((await decryptSubscription(await fetch(uiUrl), uiNextPassword)).includes("anytls://"));
  assert.equal(
    (await ok(base)).subscriptions.find((s: { id: string }) => s.id === uiItem.id).name,
    "手机 · 已编辑",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("subscriptions-mobile.png");
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "mobile page must not overflow horizontally",
  );
  await page.getByRole("button", { name: "创建订阅", exact: true }).click();
  await page.getByRole("dialog").getByLabel("订阅名称", { exact: true }).fill("移动端订阅");
  await shot("subscription-editor-mobile.png");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  // A page-level action uses the standalone challenge. Replayed TOTP stays here.
  await sql`UPDATE sessions SET elevated_until=now()-interval '1 minute' WHERE token_hash=${hash(session)}`;
  await page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "手机 · 已编辑", exact: true }) })
    .getByRole("button", { name: "订阅链接", exact: true })
    .click();
  await page.getByRole("heading", { name: "验证身份以继续" }).waitFor();
  await shot("verification-mobile.png");
  const replay = totp(totpSecret, Math.floor(Date.now() / 30000));
  await sql`UPDATE users SET last_totp_step=${Math.floor(Date.now() / 30000)} WHERE id=${owner}`;
  await page.getByRole("dialog").getByLabel("动态验证码", { exact: true }).fill(replay);
  await page.getByRole("button", { name: "验证并继续", exact: true }).click();
  await page.getByText("验证码已使用，请等待身份验证器显示下一组验证码", { exact: true }).waitFor();
  await page.getByRole("button", { name: "返回，保留已填内容", exact: true }).click();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await sql`UPDATE sessions SET elevated_until=now()+interval '10 minutes' WHERE token_hash=${hash(session)}`;
  const editedRow = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "手机 · 已编辑", exact: true }) });
  await editedRow.getByRole("button", { name: "订阅链接", exact: true }).click();
  assert.deepEqual(await readQr(), { url: uiUrl, password: uiNextPassword, name: uiNextTitle });
  await expect(page.getByLabel("订阅加密密码", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  await page.getByRole("button", { name: "复制密码", exact: true }).click();
  await page.getByRole("button", { name: "已复制密码", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), uiNextPassword);
  await shot("subscription-qr-mobile.png");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole("tab", { name: "手动复制", exact: true }).click();
  assert.equal(await page.getByLabel("订阅加密密码", { exact: true }).inputValue(), uiNextPassword);
  await page.getByRole("button", { name: "显示密码", exact: true }).click();
  assert.equal(await page.getByLabel("订阅加密密码", { exact: true }).getAttribute("type"), "text");
  await page.getByRole("button", { name: "隐藏密码", exact: true }).click();
  await shot("subscription-encrypted-link-mobile.png");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await editedRow.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Shadowrocket 订阅名称", { exact: true }).fill("");
  await page
    .getByRole("dialog")
    .getByLabel("日本 REALITY 入口 的客户端显示名称", { exact: true })
    .fill("");
  assert.equal(
    await page.getByRole("dialog").getByLabel("加密密码", { exact: true }).inputValue(),
    "",
  );
  await page.getByRole("dialog").getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  assert((await decryptSubscription(await fetch(uiUrl), uiNextPassword)).includes("anytls://"));
  await expect(editedRow.getByText("已加密", { exact: true })).toHaveCount(1);
  const resetNames = (await ok(base)).subscriptions.find((s: { id: string }) => s.id === uiItem.id);
  assert.equal(resetNames.displayName, null);
  assert(
    resetNames.nodes.every((node: { displayName: string | null }) => node.displayName === null),
  );
  await editedRow.getByRole("button", { name: "订阅链接", exact: true }).click();
  assert.equal((await readQr()).name, "手机 · 已编辑");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/settings?section=dns`);
  await page.getByRole("heading", { name: "代理节点 · DNS 与证书" }).waitFor();
  await shot("settings-desktop.png");
  await page.goto(`${origin}/proxies`);
  await page.getByRole("heading", { name: "已管理的代理" }).waitFor();
  await page.getByLabel("代理服务器").selectOption(servers[0]);
  await page.getByRole("cell", { name: /日本 REALITY 入口/ }).waitFor();
  await page.getByText("节点连接与防火墙", { exact: true }).waitFor();
  await shot("proxies-desktop.png");
  await page.goto(`${origin}/servers/${servers[0]}`);
  await page.getByRole("heading", { name: "东京 · 主节点", exact: true }).waitFor();
  await shot("detail-desktop.png");
  // Terminal tickets are real API calls; the PTY transport is simulated here.
  await sql`UPDATE servers SET last_seen=now(),info=info || '{"terminal":true}'::jsonb WHERE id=${servers[0]}`;
  await sql`UPDATE sessions SET elevated_until=now()-interval '1 minute' WHERE token_hash=${hash(session)}`;
  await sql`UPDATE users SET last_totp_step=0 WHERE id=${owner}`;
  let terminalSocket: WebSocketRoute | undefined;
  let socketCount = 0;
  let closedSockets = 0;
  const terminalInputs: string[] = [];
  const terminalSizes: { cols: number; rows: number }[] = [];
  await page.routeWebSocket("**/ws/terminal", (socket) => {
    terminalSocket = socket;
    socketCount++;
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "auth") {
        socket.send(JSON.stringify({ type: "ready" }));
        socket.send(
          Buffer.from(
            "\x1b[32mblink@tokyo\x1b[0m:~$ systemctl status blink-agent\r\n\x1b[32m●\x1b[0m blink-agent.service — Blink Node Agent\r\n  Active: active (running)\r\n  Memory: 18.4M\r\n\r\n\x1b[32mblink@tokyo\x1b[0m:~$ ",
          ),
        );
      }
      if (message.type === "input") terminalInputs.push(message.data);
      if (message.type === "resize") terminalSizes.push(message);
    });
    socket.onClose(() => {
      closedSockets++;
    });
  });
  await page.getByRole("tab", { name: "网页终端", exact: true }).click();
  await page.getByRole("button", { name: "连接终端", exact: true }).click();
  await page.getByRole("heading", { name: "验证身份以继续" }).waitFor();
  await page.getByRole("button", { name: "返回，保留已填内容", exact: true }).click();
  assert.equal((await sql`SELECT * FROM terminal_tickets WHERE server_id=${servers[0]}`).length, 0);
  assert.equal(socketCount, 0, "cancel must not open a terminal");
  await page.getByRole("button", { name: "连接终端", exact: true }).click();
  await page.getByRole("heading", { name: "验证身份以继续" }).waitFor();
  await page
    .getByRole("dialog")
    .getByLabel("动态验证码", { exact: true })
    .fill(totp(totpSecret, Math.floor(Date.now() / 30000)));
  await page.getByRole("button", { name: "验证并继续", exact: true }).click();
  await page.getByText("已连接", { exact: true }).waitFor();
  assert.equal(socketCount, 1);
  const firstTerminalSocket = terminalSocket!;
  await expect.poll(() => terminalSizes.length).toBeGreaterThan(0);
  const initialColumns = terminalSizes.at(-1)!.cols;
  await page.getByLabel("终端字号", { exact: true }).selectOption("18");
  await expect.poll(() => terminalSizes.at(-1)!.cols).toBeLessThan(initialColumns);
  await page.getByLabel("终端字号", { exact: true }).selectOption("14");
  await page.getByRole("button", { name: "搜索终端内容", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索终端内容", exact: true }).fill("active (running)");
  await expect(page.getByRole("button", { name: "复制选中内容", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "复制选中内容", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "active (running)");
  await page.getByRole("button", { name: "关闭搜索", exact: true }).click();
  await page.getByRole("button", { name: "Tab", exact: true }).click();
  await expect.poll(() => terminalInputs.at(-1)).toBe("\t");
  await page.getByRole("button", { name: "Ctrl C", exact: true }).click();
  await expect.poll(() => terminalInputs.at(-1)).toBe("\x03");
  await page.getByRole("button", { name: "Ctrl 组合键", exact: true }).click();
  await page.getByRole("textbox", { name: "终端输入", exact: true }).press("d");
  await expect.poll(() => terminalInputs.at(-1)).toBe("\x04");
  await expect(page.getByRole("button", { name: "Ctrl 组合键", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  // Bracketed paste and application-mode cursor sequences must survive the UI helpers.
  terminalSocket!.send(Buffer.from("\x1b[?2004h\x1b[?1h"));
  await page.getByRole("button", { name: "方向上", exact: true }).click();
  await expect.poll(() => terminalInputs.at(-1)).toBe("\x1bOA");
  await page.evaluate(() => navigator.clipboard.writeText("中文 pasted\nsecond line"));
  await page.getByRole("button", { name: "粘贴", exact: true }).click();
  await expect.poll(() => terminalInputs.at(-1)).toBe("\x1b[200~中文 pasted\rsecond line\x1b[201~");
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await expect(page.getByRole("tab", { name: "会话 2", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page
    .locator(".terminal-session:not([hidden])")
    .getByText("已连接", { exact: true })
    .waitFor();
  assert.equal(socketCount, 2);
  await page.getByRole("tab", { name: "会话 1", exact: true }).click();
  await expect(page.locator(".terminal-session:not([hidden]) .xterm-rows")).toContainText(
    "blink-agent.service",
  );
  await page.getByRole("button", { name: "关闭会话 2", exact: true }).click();
  await expect.poll(() => closedSockets).toBe(1);
  await page.getByRole("tab", { name: "监控概览", exact: true }).click();
  await page.getByRole("tab", { name: "网页终端", exact: true }).click();
  await page.getByText("已连接", { exact: true }).waitFor();
  assert.equal(socketCount, 2, "switching tabs preserves the terminal session");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("terminal-mobile.png");
  await page.getByRole("button", { name: "打开键盘", exact: true }).click();
  await expect(page.locator(".terminal-workspace")).toHaveClass(/terminal-expanded/);
  await expect(page.getByRole("textbox", { name: "终端输入", exact: true })).toBeFocused();
  await expect
    .poll(async () => (await page.locator(".terminal-workspace").boundingBox())?.height)
    .toBe(844);
  await shot("terminal-mobile-focus.png");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  // Model a mobile keyboard shrinking only the visual viewport, as on iOS.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 460 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(async () => (await page.locator(".terminal-workspace").boundingBox())?.height)
    .toBe(460);
  const keys = await page.getByRole("group", { name: "终端快捷键" }).boundingBox();
  assert(keys && keys.y + keys.height <= 460, "shortcut keys stay above the virtual keyboard");
  await expect.poll(() => terminalSizes.at(-1)!.rows).toBeLessThan(10);
  await shot("terminal-mobile-keyboard.png");
  await page.evaluate(() => {
    Reflect.deleteProperty(window.visualViewport!, "height");
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  // Denied clipboard access offers an explicit paste field instead of a dead action.
  await page.evaluate(() => {
    navigator.clipboard.readText = () => Promise.reject(new Error("denied"));
  });
  await page.getByRole("button", { name: "粘贴", exact: true }).click();
  await page.getByLabel("粘贴文本", { exact: true }).fill("echo 手机输入");
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 460 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(async () => (await page.locator(".terminal-workspace").boundingBox())?.height)
    .toBe(460);
  const pasteButton = await page
    .getByRole("button", { name: "粘贴到终端", exact: true })
    .boundingBox();
  assert(
    pasteButton && pasteButton.y + pasteButton.height <= 460,
    "manual paste stays above the keyboard",
  );
  await page.getByRole("button", { name: "粘贴到终端", exact: true }).click();
  await expect.poll(() => terminalInputs.at(-1)).toBe("\x1b[200~echo 手机输入\x1b[201~");
  await page.evaluate(() => {
    Reflect.deleteProperty(window.visualViewport!, "height");
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await page.getByRole("button", { name: "退出专注模式", exact: true }).click();
  assert.equal(await page.evaluate(() => document.body.style.overflow), "");
  await page.setViewportSize({ width: 1440, height: 900 });
  await firstTerminalSocket.close({ code: 1000 });
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await page.getByText("已连接", { exact: true }).waitFor();
  assert.equal(socketCount, 3, "explicit reconnect creates one replacement socket");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot("terminal-desktop.png");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("terminal-desktop-dark.png");
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("button", { name: "关闭会话 1", exact: true }).click();
  // Coarse-pointer emulation checks the real touch path, not just a narrow desktop viewport.
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    await mobileContext.addCookies([{ name: "blink-dev", value: session, url: origin }]);
    const mobile = await mobileContext.newPage();
    const touchInputs: string[] = [];
    let touchCloses = 0;
    await mobile.routeWebSocket("**/ws/terminal", (socket) => {
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "auth") {
          socket.send(JSON.stringify({ type: "ready" }));
          socket.send(Buffer.from("\x1b[32mblink@tokyo\x1b[0m:~$ "));
        }
        if (message.type === "input") touchInputs.push(message.data);
      });
      socket.onClose(() => {
        touchCloses++;
      });
    });
    await mobile.goto(`${origin}/servers/${servers[0]}?tab=terminal`);
    await mobile.getByRole("button", { name: "连接终端", exact: true }).tap();
    await mobile.getByText("已连接", { exact: true }).waitFor();
    await expect(mobile.getByRole("textbox", { name: "终端输入" })).not.toBeFocused();
    await mobile.locator(".terminal-canvas").tap({ position: { x: 100, y: 20 } });
    await expect(mobile.locator(".terminal-workspace")).toHaveClass(/terminal-expanded/);
    await mobile.getByRole("button", { name: "Ctrl C", exact: true }).tap();
    await expect.poll(() => touchInputs.at(-1)).toBe("\x03");
    await mobile.getByRole("button", { name: "Tab", exact: true }).tap();
    await expect.poll(() => touchInputs.at(-1)).toBe("\t");
    await expect(mobile.getByRole("textbox", { name: "终端输入" })).toBeFocused();
    await mobile.keyboard.insertText("中文🙂");
    await expect.poll(() => touchInputs.at(-1)).toBe("中文🙂");
    await mobile.screenshot({
      path: resolve(dir, "terminal-mobile-touch.png"),
      animations: "disabled",
    });
    await mobile.getByRole("button", { name: "关闭会话 1", exact: true }).tap();
    await expect.poll(() => touchCloses).toBe(1);
    await mobile.getByRole("button", { name: "退出专注模式", exact: true }).tap();
    assert.equal(await mobile.evaluate(() => document.querySelectorAll("[inert]").length), 0);
  } finally {
    await mobileContext.close();
  }
  // If the login itself expires during verification, go to login, not an OTP retry loop.
  await sql`UPDATE sessions SET elevated_until=now()-interval '1 minute' WHERE token_hash=${hash(session)}`;
  await page.getByRole("button", { name: "连接终端", exact: true }).click();
  await page.getByRole("heading", { name: "验证身份以继续" }).waitFor();
  await sql`UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=${hash(session)}`;
  await page.getByRole("dialog").getByLabel("动态验证码", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "验证并继续", exact: true }).click();
  await page.waitForURL("**/login");
  await page.getByRole("heading", { name: "登录控制台" }).waitFor();
  await shot("login-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("login-mobile.png");
  await sql`UPDATE sessions SET expires_at=now()+interval '1 hour',elevated_until=now()+interval '10 minutes' WHERE token_hash=${hash(session)}`;
  // Import a real scanned shape through the UI, then select it in an encrypted subscription.
  await context.addCookies([{ name: "blink-dev", value: session, url: origin }]);
  await sql`UPDATE servers SET info=info || '{"proxy":true}'::jsonb,last_seen=now() WHERE id=${servers[0]}`;
  const uiImport = randomUUID();
  const uiEntranceSecret = "existing-anytls-password:@#";
  const uiImportSummary = {
    engine: "sing-box",
    unit: "existing-anytls.service",
    active: true,
    managed: false,
    paths: ["/etc/sing-box/config.json"],
    warnings: [],
    inbounds: [{ protocol: "anytls", port: 10443, reality: false }],
  };
  const uiImportConfig = {
    effective: {
      inbounds: [
        {
          type: "anytls",
          tag: "Existing AnyTLS",
          listen: "::",
          listen_port: 10443,
          tls: { enabled: true },
          users: [{ name: "mobile", password: uiEntranceSecret }],
        },
      ],
    },
  };
  await sql`INSERT INTO proxy_imports(id,server_id,source_key,summary,encrypted_snapshot) VALUES(${uiImport},${servers[0]},'existing-anytls.service',${sql.json(uiImportSummary)},${encrypt(JSON.stringify(uiImportConfig))})`;
  assert.equal(
    (
      await call(`proxy/imports/${uiImport}/entrances`, "GET", undefined, {
        session: memberSession,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `proxy/imports/${uiImport}/entrances`,
        "POST",
        { candidateKey: "0:0", name: "no access", domain: "existing.example.com" },
        { session: memberSession },
      )
    ).status,
    403,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/proxies?server=${servers[0]}`);
  await page.getByRole("button", { name: "添加为入口", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("已有入口服务 / 用户", { exact: true })).toHaveValue("0:0");
  await dialog.getByLabel("入口名称", { exact: true }).fill("扫描导入 AnyTLS");
  await dialog
    .getByLabel("TLS / REALITY 域名（SNI）", { exact: true })
    .fill("existing.example.com");
  await shot("import-entrance-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("import-entrance-mobile.png");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await dialog.getByRole("button", { name: "确认添加入口", exact: true }).click();
  await page.getByRole("heading", { name: "已添加的已有服务入口", exact: true }).waitFor();
  await page.getByText("扫描导入 AnyTLS", { exact: true }).waitFor();
  await shot("imported-entrances-mobile.png");
  const [uiEntrance] =
    await sql`SELECT * FROM proxy_external_entrances WHERE import_id=${uiImport}`;
  assert.equal(uiEntrance.spec.domain, "existing.example.com");
  assert.equal(uiEntrance.spec.port, 10443);
  assert(!uiEntrance.encrypted_credentials.includes(uiEntranceSecret));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "更新入口引用", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("入口名称", { exact: true })).toHaveValue("扫描导入 AnyTLS");
  await expect(dialog.getByLabel("TLS / REALITY 域名（SNI）", { exact: true })).toHaveValue(
    "existing.example.com",
  );
  await dialog.getByLabel("入口名称", { exact: true }).fill("已有 AnyTLS 手机入口");
  await dialog.getByRole("button", { name: "更新入口引用", exact: true }).click();
  await page.getByText("已有 AnyTLS 手机入口", { exact: true }).waitFor();
  await shot("imported-entrances-desktop.png");
  await page.goto(`${origin}/subscriptions`);
  await page.getByRole("button", { name: "创建订阅", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("订阅名称", { exact: true }).fill("已有入口订阅");
  await dialog.getByRole("checkbox", { name: /已有 AnyTLS 手机入口/ }).check();
  await dialog
    .getByLabel("已有 AnyTLS 手机入口 的客户端显示名称", { exact: true })
    .fill("已有入口别名");
  await dialog.getByRole("button", { name: "生成随机密码" }).click();
  const uiImportedPassword = await dialog.getByLabel("加密密码", { exact: true }).inputValue();
  await dialog.getByRole("button", { name: "创建订阅", exact: true }).click();
  await page.getByRole("heading", { name: "订阅链接", exact: true }).waitFor();
  const [uiImportedSub] = await sql`SELECT id FROM proxy_subscriptions WHERE name='已有入口订阅'`;
  const importedAccess = await ok(`${base}/${uiImportedSub.id}/link`, "POST", {});
  const importedUri = new URL(
    await decryptSubscription(await fetch(importedAccess.url), uiImportedPassword),
  );
  assert.equal(decodeURIComponent(importedUri.username), uiEntranceSecret);
  assert.equal(importedUri.searchParams.get("sni"), "existing.example.com");
  assert.equal(importedUri.port, "10443");
  assert.equal(decodeURIComponent(importedUri.hash.slice(1)), "已有入口别名");
  await page.goto(`${origin}/proxies?server=${servers[0]}`);
  await page.getByRole("button", { name: "移除入口引用", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "已添加的已有服务入口", exact: true }),
  ).toHaveCount(0);
  assert.equal((await fetch(importedAccess.url)).status, 503);
  const removedImportedNode = (await ok(base)).subscriptions.find(
    (item: { id: string }) => item.id === uiImportedSub.id,
  ).nodes[0];
  assert.equal(removedImportedNode.instanceId, null);
  assert.equal(removedImportedNode.displayName, "已有入口别名");
  await ok(`${base}/${uiImportedSub.id}`, "DELETE");
  assert.deepEqual(errors, [], "browser must not report uncaught application errors");

  // Dynamic export must reflect updates and deletion without regenerating the URL.
  await sql`UPDATE proxy_hosts SET addresses=ARRAY['1.1.1.1'] WHERE server_id=${servers[0]}`;
  assert(
    (await decryptSubscription(await fetch(rotated.url), defaultPassword)).includes("@1.1.1.1:443"),
  );
  await sql`UPDATE proxy_hosts SET desired_version=2 WHERE server_id=${servers[0]}`;
  assert.equal(
    (await decryptSubscription(await fetch(rotated.url), defaultPassword)).split("\n").length,
    1,
  );
  await sql`UPDATE proxy_hosts SET applied_version=2 WHERE server_id=${servers[0]}`;
  await sql`UPDATE servers SET revoked=true WHERE id=${servers[1]}`;
  assert.equal(
    (await decryptSubscription(await fetch(rotated.url), defaultPassword)).split("\n").length,
    1,
  );
  await sql`UPDATE servers SET revoked=false WHERE id=${servers[1]}`;
  await sql`UPDATE proxy_instances SET encrypted_credentials=${encrypt("{}")} WHERE id=${anytls}`;
  assert(
    (await ok(base)).nodes.find((n: { instanceId: string }) => n.instanceId === anytls).reason,
  );
  await sql`UPDATE proxy_instances SET encrypted_credentials=${encrypt(JSON.stringify({ password: specialPassword }))} WHERE id=${anytls}`;
  await ok(`${base}/${created.id}`, "PATCH", {
    nodeDisplayNames: { [reality]: "已删除入口的自定义名" },
  });
  await sql`DELETE FROM proxy_instances WHERE id=${reality}`;
  const deletedNode = (await ok(base)).subscriptions.find(
    (s: { id: string }) => s.id === created.id,
  ).nodes[1];
  assert.equal(deletedNode.instanceId, null);
  assert.equal(deletedNode.reason, "入口已删除");
  assert.equal(deletedNode.displayName, "已删除入口的自定义名");
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
  for (const secret of [
    encryptionPassword,
    nextPassword,
    uiPassword,
    uiNextPassword,
    migratedPassword,
    defaultPassword,
  ])
    assert(!audits.includes(secret));
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
