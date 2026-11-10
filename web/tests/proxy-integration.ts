import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

const exec = promisify(execFile);
const name = `blink-proxy-db-${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
let created = false;
let close: (() => Promise<void>) | undefined;
try {
  await exec("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_DB=blink",
    "-p",
    "127.0.0.1::5432",
    "postgres:17-alpine",
  ]);
  created = true;
  const binding = (await exec("docker", ["port", name, "5432/tcp"])).stdout.trim();
  Object.assign(process.env, {
    DATABASE_URL: `postgres://postgres:${password}@${binding}/blink`,
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    PUBLIC_URL: "https://blink.example.com",
  });
  const { sql } = await import("../src/db");
  close = () => sql.end();
  for (let i = 0; ; i++) {
    try {
      await sql`SELECT 1`;
      break;
    } catch (error) {
      if (i > 30) throw error;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const { migrateDatabase } = await import("../src/db/migrate");
  await migrateDatabase();
  const { proxyApi, initialProxyScan, dispatchProxy, receiveProxyResult, receiveProxyStatus } =
    await import("../src/server/proxy");
  const { decrypt } = await import("../src/server/crypto");
  const user = {
    id: randomUUID(),
    username: "owner",
    role: "owner",
    token_hash: "test",
    elevated_until: new Date(Date.now() + 600000),
  };
  await sql`INSERT INTO users(id,username,role,password_hash,totp_secret) VALUES(${user.id},'owner','owner','test','test')`;
  const entry = randomUUID(),
    exit = randomUUID(),
    stranger = randomUUID();
  for (const id of [entry, exit, stranger])
    await sql`INSERT INTO servers(id,name,info,last_seen) VALUES(${id},${id},'{"proxy":true}'::jsonb,now())`;
  async function api(path: string, method = "GET", value?: unknown) {
    const response = await proxyApi(
      new Request(`https://blink.example.com/api/proxy/${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: value === undefined ? undefined : JSON.stringify(value),
      }),
      ["proxy", ...path.split("/")],
      user,
      async () => {},
    );
    return response.json();
  }
  const sent: Record<string, unknown>[] = [];
  async function dispatch() {
    sent.length = 0;
    await dispatchProxy((serverId, message) => {
      sent.push({ serverId, ...(message as object) });
      return true;
    });
    return [...sent];
  }
  async function complete(
    message: Record<string, unknown>,
    result: Record<string, unknown> = { status: { instances: [] } },
  ) {
    await receiveProxyResult(String(message.serverId), {
      type: "proxy.result",
      v: 1,
      taskId: String(message.taskId),
      desiredVersion: Number(message.desiredVersion),
      ok: true,
      result: {
        ...result,
        status: { externalFirewall: true, ...((result.status as object) ?? {}) },
      },
    });
  }
  async function drain() {
    const tasks: Record<string, unknown>[] = [];
    for (let round = 0; round < 12; round++) {
      const ready = await dispatch();
      if (!ready.length) return tasks;
      for (const task of ready) {
        tasks.push(task);
        await complete(task);
      }
    }
    throw new Error("proxy queue did not drain");
  }
  await initialProxyScan(entry);
  await initialProxyScan(entry);
  assert.equal((await sql`SELECT * FROM proxy_jobs`).length, 1, "auto-scan is coalesced");
  const [scan] = await dispatch();
  const rawSecret = randomBytes(32).toString("hex");
  const imported = {
    discoveries: [
      {
        key: "xray.service",
        summary: { engine: "xray", paths: ["/etc/xray/config.json"] },
        configuration: { password: rawSecret, port: 443 },
      },
    ],
    status: {
      network: {
        checkedAt: new Date().toISOString(),
        addresses: [
          { address: "8.8.4.4", source: "interface", interface: "eth0" },
          { address: "2606:4700::1111", source: "ip.sb" },
        ],
      },
      ufwState: "active",
      ufw: "Status: active\n443/tcp ALLOW Anywhere",
    },
  };
  await receiveProxyResult(stranger, {
    type: "proxy.result",
    v: 1,
    taskId: String(scan.taskId),
    desiredVersion: 0,
    ok: true,
    result: imported,
  });
  assert.equal(
    (await sql`SELECT * FROM proxy_imports`).length,
    0,
    "another agent cannot complete scan",
  );
  await complete(scan, imported);
  const detectedHost = await api(`hosts/${entry}`);
  assert.deepEqual(
    detectedHost.addresses,
    ["8.8.4.4", "2606:4700::1111"],
    "initial scan fills public addresses",
  );
  assert.equal(detectedHost.observed.ufwState, "active");
  await sql`INSERT INTO proxy_hosts(server_id) VALUES(${stranger})`;
  await receiveProxyStatus(stranger, imported.status);
  assert.deepEqual(
    (await api(`hosts/${stranger}`)).addresses,
    detectedHost.addresses,
    "periodic status fills existing empty hosts",
  );
  const [record] = await sql`SELECT * FROM proxy_imports`;
  assert(!record.encrypted_snapshot.includes(rawSecret));
  assert(JSON.stringify(await api(`imports/${record.id}`)).includes("••••••••"));
  assert(!JSON.stringify(await api(`imports/${record.id}`)).includes(rawSecret));
  await api(`hosts/${entry}`, "PATCH", { addresses: ["8.8.8.8"], firewall: "existing" });
  await receiveProxyStatus(entry, {
    ...imported.status,
    ufwState: "inactive",
    ufw: "Status: inactive",
  });
  const manualHost = await api(`hosts/${entry}`);
  assert.deepEqual(
    manualHost.addresses,
    ["8.8.8.8"],
    "observations never overwrite saved addresses",
  );
  assert.equal(manualHost.observed.ufwState, "inactive");
  await api(`hosts/${exit}`, "PATCH", { addresses: ["1.1.1.1"], firewall: "existing" });
  await sql`UPDATE proxy_settings SET acme_email='test@example.com' WHERE id=1`;
  const ss = await api("instances", "POST", {
    name: "exit",
    serverId: exit,
    kind: "shadowsocks2022",
    port: 8388,
  });
  const [ssTask] = await dispatch();
  await complete(ssTask);
  const input = {
    name: "entrance",
    serverId: entry,
    kind: "reality",
    domain: "entry.example.com",
    upstream: "https://example.com",
    port: 443,
    manageDns: false,
    defaultOutbound: ss.id,
    rules: [{ match: "domain", values: ["direct.example.com"], outbound: "direct" }],
  };
  const entrance = await api("instances", "POST", input);
  const [exitTask] = await dispatch();
  assert.equal(exitTask.serverId, exit, "exit ACL updated before entrance");
  const taskPayload = exitTask.payload as { instances: { sources: string[] }[] };
  assert.deepEqual(taskPayload.instances[0].sources, ["8.8.8.8"]);
  await assert.rejects(api(`instances/${entrance.id}`, "PATCH", input), /任务正在执行/);
  await complete(exitTask);
  const [entryTask] = await dispatch();
  assert.equal(entryTask.serverId, entry);
  await complete(entryTask);
  await api(`hosts/${entry}`, "PATCH", { addresses: ["9.9.9.9"], firewall: "existing" });
  const [ipAcl] = await dispatch();
  assert.equal(ipAcl.serverId, exit);
  assert.deepEqual((ipAcl.payload as { instances: { sources: string[] }[] }).instances[0].sources, [
    "9.9.9.9",
  ]);
  await complete(ipAcl);
  for (const task of await dispatch()) await complete(task);
  await api(`hosts/${entry}/scan`, "POST", {});
  const [statusScan] = await dispatch();
  await complete(statusScan, {
    status: {
      instances: [
        {
          id: entrance.id,
          kind: "reality",
          port: 443,
          state: "active",
          privateKey: "must-not-persist",
        },
      ],
    },
  });
  const scannedHost = await api(`hosts/${entry}`);
  assert.equal(scannedHost.observed.instances[0].id, entrance.id);
  assert(!JSON.stringify(scannedHost.observed).includes("must-not-persist"));
  await assert.rejects(api(`instances/${ss.id}`, "DELETE"), /链路引用/);
  const [stored] =
    await sql`SELECT encrypted_payload FROM proxy_jobs WHERE id=${entryTask.taskId as string}`;
  assert.equal(JSON.parse(decrypt(stored.encrypted_payload)).instances[0].exits[0].id, ss.id);
  const list = await api("instances");
  assert(!JSON.stringify(list).includes("privateKey"));
  const client = await api(`instances/${entrance.id}/credentials`, "POST", {});
  assert(client.publicKey && client.uuid && !client.privateKey);
  await api(`hosts/${entry}/apply`, "POST", {});
  const [failedExit] = await dispatch();
  await receiveProxyResult(exit, {
    type: "proxy.result",
    v: 1,
    taskId: String(failedExit.taskId),
    desiredVersion: Number(failedExit.desiredVersion),
    ok: false,
    result: { error: "injected deployment failure" },
  });
  assert.equal((await dispatch()).length, 0, "failed dependency blocks entrance");
  await api(`hosts/${entry}/apply`, "POST", {});
  const [retryExit] = await dispatch();
  assert.equal(retryExit.serverId, exit, "retry reconciles failed exit first");
  await complete(retryExit);
  for (const task of await dispatch()) await complete(task);
  const disabled = { ...input, enabled: false };
  await api(`instances/${entrance.id}`, "PATCH", disabled);
  const [removeAcl] = await dispatch();
  await complete(removeAcl);
  const [disable] = await dispatch();
  assert.equal((disable.payload as { instances: unknown[] }).instances.length, 0);
  await complete(disable);
  await api(`instances/${entrance.id}`, "DELETE");
  for (let i = 0; i < 2; i++) for (const task of await dispatch()) await complete(task);
  assert.equal((await sql`SELECT * FROM proxy_instances WHERE id=${entrance.id}`).length, 0);
  const importedPassword = randomBytes(32).toString("base64");
  const externalSnapshot = {
    discoveries: [
      {
        key: "existing-ss.service",
        summary: { engine: "xray", active: true, managed: false },
        configuration: {
          effective: {
            inbounds: [
              {
                protocol: "shadowsocks",
                port: 17501,
                settings: {
                  method: "2022-blake3-aes-256-gcm",
                  password: importedPassword,
                  network: "tcp,udp",
                },
              },
            ],
          },
        },
      },
    ],
  };
  await initialProxyScan(stranger);
  const [externalScan] = await dispatch();
  await complete(externalScan, externalSnapshot);
  const [externalImport] = await sql`SELECT id FROM proxy_imports WHERE server_id=${stranger}`;
  const candidates = await api(`imports/${externalImport.id}/exits`);
  assert.equal(candidates[0].reason, "");
  assert(!JSON.stringify(candidates).includes(importedPassword));
  const importedExit = await api(`imports/${externalImport.id}/exits`, "POST", {
    candidateKey: candidates[0].key,
    name: "Existing SS2022",
  });
  assert.equal(
    (
      await api(`imports/${externalImport.id}/exits`, "POST", {
        candidateKey: candidates[0].key,
        name: "Existing SS2022",
      })
    ).id,
    importedExit.id,
    "import registration is idempotent",
  );
  assert.equal(
    (await dispatch()).length,
    0,
    "registering an existing service never schedules an apply",
  );
  const [externalStored] =
    await sql`SELECT encrypted_credentials FROM proxy_external_exits WHERE id=${importedExit.id}`;
  assert(!externalStored.encrypted_credentials.includes(importedPassword));
  assert.equal(
    JSON.parse(decrypt(externalStored.encrypted_credentials)).password,
    importedPassword,
  );
  assert(!JSON.stringify(await api("exits")).includes(importedPassword));
  const externalInput = {
    ...input,
    defaultOutbound: importedExit.id,
    rules: [{ match: "domain", values: ["chain.example.com"], outbound: importedExit.id }],
  };
  await assert.rejects(
    api("instances", "POST", { ...externalInput, serverId: stranger }),
    /其他服务器/,
  );
  await receiveProxyStatus(stranger, { externalFirewall: false });
  await assert.rejects(api("instances", "POST", externalInput), /更新 Agent 和部署器/);
  await receiveProxyStatus(stranger, { externalFirewall: true });
  const viaExternal = await api("instances", "POST", externalInput);
  type FirewallPayload = {
    retainExisting: boolean;
    firewall: string;
    exits: { id: string; port: number; udp: boolean; sources: string[] }[];
  };
  const [prepareFirewall] = await dispatch();
  assert.equal(prepareFirewall.serverId, stranger);
  assert.equal(prepareFirewall.operation, "firewall");
  assert.deepEqual((prepareFirewall.payload as FirewallPayload).exits, [
    { id: importedExit.id, port: 17501, udp: true, sources: ["9.9.9.9"] },
  ]);
  assert.equal((prepareFirewall.payload as FirewallPayload).retainExisting, true);
  assert(
    !JSON.stringify(prepareFirewall.payload).includes(importedPassword),
    "firewall payload contains no source service credentials",
  );
  await complete(prepareFirewall);
  const externalTasks = await dispatch();
  assert.equal(externalTasks.length, 1);
  assert.equal(externalTasks[0].serverId, entry, "existing exit service is never redeployed");
  const externalPayload = externalTasks[0].payload as {
    instances: { exits: { id: string; password: string; port: number }[] }[];
  };
  assert.equal(externalPayload.instances[0].exits[0].password, importedPassword);
  assert.equal(externalPayload.instances[0].exits[0].port, 17501);
  await complete(externalTasks[0]);
  const [cleanupFirewall] = await dispatch();
  assert.equal(cleanupFirewall.operation, "firewall");
  assert.equal((cleanupFirewall.payload as FirewallPayload).retainExisting, false);
  assert(Number(cleanupFirewall.desiredVersion) > Number(prepareFirewall.desiredVersion));
  await complete(cleanupFirewall);
  await api(`hosts/${stranger}/apply`, "POST", {});
  const sourceReapply = await drain();
  assert.deepEqual(
    sourceReapply.map((task) => task.operation),
    ["firewall", "firewall"],
    "reapplying an imported-only source never deploys services",
  );
  await api(`hosts/${entry}/apply`, "POST", {});
  const [deniedFirewall] = await dispatch();
  await receiveProxyResult(stranger, {
    type: "proxy.result",
    v: 1,
    taskId: String(deniedFirewall.taskId),
    desiredVersion: Number(deniedFirewall.desiredVersion),
    ok: false,
    result: { error: "injected UFW error" },
  });
  assert.equal(
    (await dispatch()).length,
    0,
    "UFW failure prevents entrance deployment and cleanup",
  );
  await api(`hosts/${entry}/apply`, "POST", {});
  await drain();
  await assert.rejects(api(`exits/${importedExit.id}`, "DELETE"), /链路引用/);
  const secondInput = {
    ...externalInput,
    serverId: exit,
    kind: "anytls",
    port: 8443,
    domain: "any.example.com",
    upstream: "",
    defaultOutbound: "direct",
  };
  const second = await api("instances", "POST", secondInput);
  const sharedTasks = await drain();
  assert.deepEqual(
    new Set((sharedTasks[0].payload as FirewallPayload).exits[0].sources),
    new Set(["9.9.9.9", "1.1.1.1"]),
    "default and rule references share the source ACL",
  );
  assert.deepEqual(
    sharedTasks.map((task) => task.operation),
    ["firewall", "apply", "firewall"],
  );
  await api(`hosts/${entry}`, "PATCH", {
    addresses: ["8.8.8.8", "2606:4700::1111"],
    firewall: "existing",
  });
  const [newSources] = await dispatch();
  assert.equal((newSources.payload as FirewallPayload).retainExisting, true);
  assert.deepEqual(
    new Set((newSources.payload as FirewallPayload).exits[0].sources),
    new Set(["8.8.8.8", "2606:4700::1111", "1.1.1.1"]),
  );
  await complete(newSources);
  const [failedEntrance] = await dispatch();
  await receiveProxyResult(entry, {
    type: "proxy.result",
    v: 1,
    taskId: String(failedEntrance.taskId),
    desiredVersion: Number(failedEntrance.desiredVersion),
    ok: false,
    result: { error: "injected entrance failure" },
  });
  assert.equal(
    (await dispatch()).length,
    0,
    "failed entrance never removes previously working source rules",
  );
  await api(`hosts/${entry}/apply`, "POST", {});
  const repaired = await drain();
  assert.deepEqual(
    repaired.map((task) => task.operation),
    ["firewall", "apply", "firewall"],
  );
  await api(`instances/${second.id}`, "PATCH", { ...secondInput, enabled: false });
  const disabledTasks = await drain();
  assert.deepEqual(
    (disabledTasks.at(-1)!.payload as FirewallPayload).exits[0].sources,
    ["8.8.8.8", "2606:4700::1111"],
    "disabling one entrance retains the remaining entrance sources",
  );
  await api(`instances/${second.id}`, "DELETE");
  await drain();
  const alternative = structuredClone(
    externalSnapshot.discoveries[0].configuration.effective.inbounds[0],
  );
  alternative.port = 17502;
  externalSnapshot.discoveries[0].configuration.effective.inbounds.push(alternative);
  await api(`hosts/${stranger}/scan`, "POST", {});
  await complete((await dispatch())[0], externalSnapshot);
  const alternativeExit = await api(`imports/${externalImport.id}/exits`, "POST", {
    candidateKey: "1:-1",
    name: "Alternative existing exit",
  });
  const switchedInput = { ...externalInput, defaultOutbound: alternativeExit.id, rules: [] };
  await api(`instances/${viaExternal.id}`, "PATCH", switchedInput);
  const switched = await drain();
  const finalExits = (switched.at(-1)!.payload as FirewallPayload).exits;
  assert.deepEqual(
    finalExits.find((item) => item.id === importedExit.id)!.sources,
    [],
    "switching exits releases the old listener ACL",
  );
  assert.deepEqual(finalExits.find((item) => item.id === alternativeExit.id)!.sources, [
    "8.8.8.8",
    "2606:4700::1111",
  ]);
  await api(`instances/${viaExternal.id}`, "PATCH", externalInput);
  await drain();
  await api(`exits/${alternativeExit.id}`, "DELETE");
  await drain();
  await api(`hosts/${stranger}`, "PATCH", { addresses: ["1.0.0.1"], firewall: "external" });
  const [externalMode] = await dispatch();
  assert.equal((externalMode.payload as FirewallPayload).firewall, "external");
  await complete(externalMode);
  const [externalAddressChange] = await dispatch();
  assert.equal(
    externalAddressChange.serverId,
    entry,
    "existing exit IP changes reapply its entrances only",
  );
  assert.equal(
    (externalAddressChange.payload as { instances: { exits: { address: string }[] }[] })
      .instances[0].exits[0].address,
    "1.0.0.1",
  );
  await complete(externalAddressChange);
  await drain();
  externalSnapshot.discoveries[0].configuration.effective.inbounds[0].settings.password =
    randomBytes(32).toString("base64");
  await api(`hosts/${stranger}/scan`, "POST", {});
  const [changedScan] = await dispatch();
  await complete(changedScan, externalSnapshot);
  assert.equal(
    (await api("exits")).find((exit: { id: string }) => exit.id === importedExit.id).state,
    "stale",
  );
  await assert.rejects(api(`hosts/${entry}/apply`, "POST", {}), /已有服务出口不可用/);
  await assert.rejects(
    api(`imports/${externalImport.id}/exits`, "POST", {
      candidateKey: candidates[0].key,
      name: "Changed",
    }),
    /先移除入口引用/,
  );
  await api(`instances/${viaExternal.id}`, "DELETE");
  const removedTasks = await drain();
  assert.equal((removedTasks.at(-1)!.payload as FirewallPayload).retainExisting, false);
  assert.deepEqual(
    (removedTasks.at(-1)!.payload as FirewallPayload).exits[0].sources,
    [],
    "last reference removal clears the imported ACL",
  );
  await api(`imports/${externalImport.id}/exits`, "POST", {
    candidateKey: candidates[0].key,
    name: "Changed",
  });
  await api(`hosts/${stranger}/scan`, "POST", {});
  const [missingScan] = await dispatch();
  await complete(missingScan, { discoveries: [] });
  assert.equal(
    (await api("exits")).find((exit: { id: string }) => exit.id === importedExit.id).state,
    "stale",
    "disappeared services become unavailable",
  );
  await api(`exits/${importedExit.id}`, "DELETE");
  await drain();
  assert.equal(
    (await sql`SELECT * FROM proxy_instances WHERE server_id=${stranger}`).length,
    0,
    "existing source remains an unmanaged service",
  );
  const mihomoPassword = randomBytes(32).toString("base64");
  const mihomoSnapshot = {
    discoveries: [
      {
        key: "mihomo:/etc/mihomo/config.yaml",
        summary: { engine: "mihomo", active: true, managed: false, proxyCount: 1 },
        configuration: {
          effective: {
            authentication: ["user:mihomo-login-secret"],
            listeners: [
              {
                name: "Mihomo SS",
                type: "shadowsocks",
                listen: "0.0.0.0",
                port: 17503,
                cipher: "2022-blake3-aes-256-gcm",
                password: mihomoPassword,
                udp: true,
              },
            ],
            proxies: [
              {
                name: "remote",
                type: "ss",
                server: "remote.example",
                port: 443,
                password: "mihomo-remote-secret",
              },
            ],
          },
        },
      },
    ],
  };
  await api(`hosts/${stranger}/scan`, "POST", {});
  await complete((await dispatch())[0], mihomoSnapshot);
  const [mihomoImport] =
    await sql`SELECT * FROM proxy_imports WHERE server_id=${stranger} AND source_key=${mihomoSnapshot.discoveries[0].key}`;
  const mihomoView = JSON.stringify(await api(`imports/${mihomoImport.id}`));
  for (const secret of [mihomoPassword, "mihomo-login-secret", "mihomo-remote-secret"]) {
    assert(!mihomoView.includes(secret));
    assert(!mihomoImport.encrypted_snapshot.includes(secret));
  }
  const mihomoCandidates = await api(`imports/${mihomoImport.id}/exits`);
  assert.equal(mihomoCandidates.length, 1, "remote Mihomo proxies are not local exits");
  const mihomoExit = await api(`imports/${mihomoImport.id}/exits`, "POST", {
    candidateKey: mihomoCandidates[0].key,
    name: "Mihomo existing exit",
  });
  assert.equal((await dispatch()).length, 0);
  const mihomoEntrance = await api("instances", "POST", {
    ...externalInput,
    defaultOutbound: mihomoExit.id,
    rules: [],
  });
  const mihomoTasks = await drain();
  assert.deepEqual(
    mihomoTasks.map((task) => task.operation),
    ["firewall", "apply", "firewall"],
  );
  assert.equal(mihomoTasks[1].serverId, entry);
  assert.equal(
    (mihomoTasks[1].payload as { instances: { exits: { password: string }[] }[] }).instances[0]
      .exits[0].password,
    mihomoPassword,
  );
  mihomoSnapshot.discoveries[0].configuration.effective.listeners[0].password =
    randomBytes(32).toString("base64");
  await api(`hosts/${stranger}/scan`, "POST", {});
  await complete((await dispatch())[0], mihomoSnapshot);
  assert.equal(
    (await api("exits")).find((item: { id: string }) => item.id === mihomoExit.id).state,
    "stale",
  );
  await assert.rejects(api(`hosts/${entry}/apply`, "POST", {}), /已有服务出口不可用/);
  await api(`instances/${mihomoEntrance.id}`, "DELETE");
  await drain();
  await api(`exits/${mihomoExit.id}`, "DELETE");
  await drain();
  const { credentials } = await import("../src/server/proxy-model");
  const { subscriptionResponse } = await import("../src/server/subscriptions");
  const importedReality = credentials("reality");
  const entranceUsers = [
    { name: "first", password: "external-anytls-password" },
    { name: "second", password: "other-anytls-password" },
  ];
  const entranceSnapshot = {
    discoveries: [
      {
        key: "existing-xray",
        summary: { engine: "xray", active: true, managed: false },
        configuration: {
          effective: {
            inbounds: [
              {
                protocol: "vless",
                port: 9443,
                settings: { clients: [{ id: importedReality.uuid, flow: "xtls-rprx-vision" }] },
                streamSettings: {
                  network: "tcp",
                  security: "reality",
                  realitySettings: {
                    privateKey: importedReality.privateKey,
                    shortIds: [""],
                    serverNames: ["existing.example.com", "other.example.com"],
                  },
                },
              },
              {
                protocol: "vless",
                port: 8443,
                settings: { clients: [{ id: randomUUID(), flow: "xtls-rprx-vision" }] },
                streamSettings: { network: "raw", security: "tls", tlsSettings: {} },
              },
            ],
          },
        },
      },
      {
        key: "existing-sing-box",
        summary: { engine: "sing-box", active: true, managed: false },
        configuration: {
          effective: {
            inbounds: [
              {
                type: "anytls",
                listen_port: 10443,
                tls: { enabled: true, server_name: "any.example.com" },
                users: entranceUsers,
              },
            ],
          },
        },
      },
    ],
  };
  async function scanEntrances(value: unknown = entranceSnapshot) {
    await sql`UPDATE servers SET last_seen=now() WHERE id=${stranger}`;
    await api(`hosts/${stranger}/scan`, "POST", {});
    await complete((await dispatch())[0], value as Record<string, unknown>);
  }
  await scanEntrances();
  const entranceImports =
    await sql`SELECT id,source_key FROM proxy_imports WHERE server_id=${stranger}`;
  const xrayImport = entranceImports.find((item) => item.source_key === "existing-xray")!.id;
  const singImport = entranceImports.find((item) => item.source_key === "existing-sing-box")!.id;
  const entranceCandidates = await api(`imports/${xrayImport}/entrances`);
  assert.equal(entranceCandidates.length, 2);
  assert(!JSON.stringify(entranceCandidates).includes(importedReality.privateKey!));
  assert(!JSON.stringify(entranceCandidates).includes(importedReality.uuid!));
  assert(
    !JSON.stringify(await api(`imports/${singImport}/entrances`)).includes(
      "external-anytls-password",
    ),
  );
  await assert.rejects(
    api(`imports/${xrayImport}/entrances`, "POST", {
      candidateKey: "0:0",
      name: "bad sni",
      domain: "wrong.example.com",
    }),
    /允许的域名/,
  );
  await assert.rejects(
    api(`imports/${xrayImport}/entrances`, "POST", {
      candidateKey: "9:0",
      name: "missing",
      domain: "existing.example.com",
    }),
    /没有此入口/,
  );
  const externalReality = await api(`imports/${xrayImport}/entrances`, "POST", {
    candidateKey: "0:0",
    name: "已有 REALITY",
    domain: "other.example.com",
  });
  const externalVision = await api(`imports/${xrayImport}/entrances`, "POST", {
    candidateKey: "1:0",
    name: "已有 XTLS",
    domain: "tls.example.com",
  });
  const externalAny = await api(`imports/${singImport}/entrances`, "POST", {
    candidateKey: "0:1",
    name: "已有 AnyTLS",
    domain: "any.example.com",
  });
  assert.equal(
    (await dispatch()).length,
    0,
    "importing entrances never queues deployment or firewall changes",
  );
  const [storedEntrance] =
    await sql`SELECT * FROM proxy_external_entrances WHERE id=${externalReality.id}`;
  const clientSecret = JSON.parse(decrypt(storedEntrance.encrypted_credentials));
  assert.equal(clientSecret.publicKey, importedReality.publicKey);
  assert(!("privateKey" in clientSecret));
  assert(!storedEntrance.encrypted_credentials.includes(importedReality.uuid!));
  assert.equal((await sql`SELECT * FROM proxy_instances WHERE server_id=${stranger}`).length, 0);
  assert.equal((await api("entrances")).length, 3);
  const entranceSubscriptionPassword = "imported-subscription-password";
  const importedSub = await api("subscriptions", "POST", {
    name: "已有入口订阅",
    encryptionPassword: entranceSubscriptionPassword,
    nodeIds: [externalAny.id, externalReality.id, externalVision.id],
    nodeDisplayNames: { [externalReality.id]: "REALITY 别名" },
  });
  const rawImportedToken = new URL(importedSub.url).pathname.split("/").at(-1)!;
  async function exportedEntrances() {
    const response = await subscriptionResponse(new Request(importedSub.url), rawImportedToken);
    assert.equal(response.status, 200);
    const data = Buffer.from(await response.text(), "base64");
    const decipher = createDecipheriv(
      "aes-128-cbc",
      createHash("md5").update(entranceSubscriptionPassword).digest(),
      data.subarray(0, 16),
    );
    return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()])
      .toString()
      .split("\n")
      .map((uri) => new URL(uri));
  }
  let exported = await exportedEntrances();
  assert.equal(decodeURIComponent(exported[0].username), "other-anytls-password");
  assert.equal(exported[1].searchParams.get("sni"), "other.example.com");
  assert.equal(exported[1].searchParams.get("sid"), "");
  assert.equal(exported[1].port, "9443");
  assert.equal(decodeURIComponent(exported[1].hash.slice(1)), "REALITY 别名");
  assert.equal(exported[2].searchParams.get("security"), "tls");
  assert.equal(exported[2].searchParams.get("flow"), "xtls-rprx-vision");
  await api(`subscriptions/${importedSub.id}`, "PATCH", {
    nodeIds: [externalVision.id, externalReality.id, externalAny.id],
  });
  assert.equal(decodeURIComponent((await exportedEntrances())[1].hash.slice(1)), "REALITY 别名");
  await api(`subscriptions/${importedSub.id}`, "PATCH", {
    nodeDisplayNames: { [externalAny.id]: "AnyTLS 别名" },
  });
  await scanEntrances();
  assert((await api("entrances")).every((item: { state: string }) => item.state === "active"));
  await sql`UPDATE proxy_hosts SET desired_version=99 WHERE server_id=${stranger}`;
  assert.equal(
    (await exportedEntrances()).length,
    3,
    "unrelated managed versions don't hide existing entrances",
  );
  entranceUsers[1].password = "rotated-anytls-password";
  await scanEntrances();
  assert.equal(
    (await api("entrances")).find((item: { id: string }) => item.id === externalAny.id).state,
    "stale",
  );
  assert.equal(
    (await exportedEntrances()).length,
    2,
    "changed credentials are not published until reimported",
  );
  const updatedEntrance = await api(`imports/${singImport}/entrances`, "POST", {
    candidateKey: "0:1",
    name: "已有 AnyTLS",
    domain: "any.example.com",
  });
  assert.equal(updatedEntrance.id, externalAny.id, "reimport preserves subscription membership");
  exported = await exportedEntrances();
  assert.equal(decodeURIComponent(exported[2].username), "rotated-anytls-password");
  assert.equal(decodeURIComponent(exported[2].hash.slice(1)), "AnyTLS 别名");
  entranceSnapshot.discoveries[0].summary.active = false;
  await scanEntrances();
  assert.equal((await exportedEntrances()).length, 1);
  await assert.rejects(
    api(`imports/${xrayImport}/entrances`, "POST", {
      candidateKey: "0:0",
      name: "inactive",
      domain: "existing.example.com",
    }),
    /运行中外部服务/,
  );
  entranceSnapshot.discoveries[0].summary.active = true;
  entranceSnapshot.discoveries[0].summary.managed = true;
  await scanEntrances();
  assert((await api(`imports/${xrayImport}/entrances`))[0].reason);
  await assert.rejects(
    api(`imports/${xrayImport}/entrances`, "POST", {
      candidateKey: "0:0",
      name: "managed",
      domain: "existing.example.com",
    }),
    /运行中外部服务/,
  );
  entranceSnapshot.discoveries[0].summary.managed = false;
  await scanEntrances({ discoveries: [] });
  assert.equal(
    (await subscriptionResponse(new Request(importedSub.url), rawImportedToken)).status,
    503,
  );
  await api(`entrances/${externalReality.id}`, "DELETE");
  const importedMembers = (await api("subscriptions")).subscriptions.find(
    (item: { id: string }) => item.id === importedSub.id,
  ).nodes;
  assert.equal(importedMembers[1].instanceId, null);
  assert.equal(importedMembers[1].displayName, "REALITY 别名");
  assert.equal(importedMembers[1].reason, "入口已删除");
  await api(`entrances/${externalVision.id}`, "DELETE");
  await api(`entrances/${externalAny.id}`, "DELETE");
  assert.equal((await dispatch()).length, 0, "removing a reference doesn't stop external services");
  const entranceAudit = JSON.stringify(
    await sql`SELECT * FROM audit_events WHERE action LIKE 'proxy.entrance.%'`,
  );
  for (const value of [
    importedReality.privateKey!,
    importedReality.uuid!,
    "rotated-anytls-password",
  ])
    assert(!entranceAudit.includes(value));
  const { ensureDns } = await import("../src/server/cloudflare");
  const nativeFetch = globalThis.fetch;
  const zoneId = "a".repeat(32),
    cfToken = randomBytes(24).toString("hex");
  type RecordValue = { id: string; type: string; name: string; content: string; proxied?: boolean };
  let records: RecordValue[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.cloudflare.com");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${cfToken}`);
    let result: unknown = { id: zoneId, name: "example.com", status: "active" };
    if (url.pathname.includes("/dns_records")) {
      const id = url.pathname.split("/dns_records/")[1];
      const method = init?.method ?? "GET";
      if (method === "GET")
        result = records.filter(
          (r) => !url.searchParams.get("name") || r.name === url.searchParams.get("name"),
        );
      else if (method === "DELETE") {
        records = records.filter((r) => r.id !== id);
        result = { id };
      } else {
        const data = JSON.parse(String(init?.body));
        assert.equal(data.proxied, false);
        const record = { ...data, id: id ?? randomUUID() };
        records = [...records.filter((r) => r.id !== record.id), record];
        result = record;
      }
    }
    return Response.json({ success: true, result });
  };
  try {
    await api("settings", "POST", {
      token: cfToken,
      zoneId,
      zoneName: "example.com",
      acmeEmail: "test@example.com",
    });
    const [settings] = await sql`SELECT encrypted_token FROM proxy_settings`;
    assert(!settings.encrypted_token.includes(cfToken));
    await ensureDns(entry, "entry.example.com", ["9.9.9.9", "2606:4700::1111"]);
    assert.equal(records.length, 2);
    await ensureDns(entry, "entry.example.com", ["8.8.8.8"]);
    assert.equal(records.length, 1);
    assert.equal(records[0].content, "8.8.8.8");
    records.push({
      id: "external",
      type: "A",
      name: "existing.example.com",
      content: "8.8.8.8",
      proxied: false,
    });
    await ensureDns(entry, "existing.example.com", ["8.8.8.8"]);
    assert.equal(
      (await sql`SELECT * FROM proxy_dns_records WHERE hostname='existing.example.com'`).length,
      0,
    );
    await assert.rejects(ensureDns(entry, "existing.example.com", ["9.9.9.9"]), /其他 DNS 记录/);
  } finally {
    globalThis.fetch = nativeFetch;
  }
  console.log(
    "PASS proxy database/API: migration, auto-scan, encrypted import, cross-agent rejection, dependency ordering, ACL sources, imported AnyTLS/XTLS/REALITY entrances, subscriptions, drift and delete",
  );
} finally {
  await close?.();
  if (created) await exec("docker", ["rm", "-f", name]);
}
