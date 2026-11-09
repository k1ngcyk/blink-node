import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { importedExitCandidates } from "../src/server/proxy-imports";

const key = (size = 32) => randomBytes(size).toString("base64");
const snapshot = (inbound: unknown) => ({ effective: { inbounds: [inbound] } });

test("Mihomo imports server listeners with cipher and UDP settings, never remote proxies", () => {
  const listener = {
    name: "SS ingress",
    type: "shadowsocks",
    port: 17501,
    listen: "*",
    cipher: "2022-blake3-aes-256-gcm",
    password: key(),
    udp: true,
  };
  const data = {
    effective: {
      listeners: [listener],
      proxies: [{ type: "ss", server: "remote.example", port: 443, password: "outbound-secret" }],
    },
  };
  const [candidate] = importedExitCandidates("mihomo", data);
  assert.equal(candidate.key, "0:-1");
  assert.equal(candidate.label, "SS ingress");
  assert.equal(candidate.reason, "");
  assert.equal(candidate.password, listener.password);
  assert.equal(candidate.udp, true);
  assert.equal(
    importedExitCandidates("mihomo", { effective: { proxies: data.effective.proxies } }).length,
    0,
  );
  for (const change of [
    { "shadow-tls": { enable: true } },
    { "simple-obfs": { enable: true } },
    { proxy: "upstream" },
    { rule: "subrule" },
    { port: "8000-9000" },
    { listen: "127.0.0.1" },
  ]) {
    assert(
      importedExitCandidates("mihomo", {
        effective: { listeners: [{ ...listener, ...change }] },
      })[0].reason,
    );
  }
  const [tcp] = importedExitCandidates("mihomo", {
    effective: { listeners: [{ ...listener, udp: false, "shadow-tls": { enable: false } }] },
  });
  assert.equal(tcp.udp, false);
  assert.equal(tcp.reason, "");
});

test("existing Xray SS2022 single-user config becomes a connection candidate", () => {
  const password = key();
  const [candidate] = importedExitCandidates(
    "xray",
    snapshot({
      protocol: "shadowsocks",
      port: 17501,
      settings: { method: "2022-blake3-aes-256-gcm", password, network: "tcp,udp" },
    }),
  );
  assert.equal(candidate.key, "0:-1");
  assert.equal(candidate.reason, "");
  assert.equal(candidate.password, password);
  assert.equal(candidate.udp, true);
  assert.equal(candidate.port, 17501);
});

test("Xray and sing-box multi-user SS2022 retain server and user keys", () => {
  const serverKey = key(16),
    userKey = key(16);
  const settings = {
    method: "2022-blake3-aes-128-gcm",
    password: serverKey,
    users: [{ name: "user", password: userKey }],
  };
  for (const [engine, inbound] of [
    ["xray", { protocol: "shadowsocks", port: 8388, settings }],
    ["sing-box", { type: "shadowsocks", listen: "::", listen_port: 8388, ...settings }],
  ] as const) {
    const [candidate] = importedExitCandidates(engine, snapshot(inbound));
    assert.equal(candidate.reason, "");
    assert.equal(candidate.key, "0:0");
    assert.equal(candidate.password, `${serverKey}:${userKey}`);
  }
});

test("legacy Shadowsocks users override the shared password and method", () => {
  const [candidate] = importedExitCandidates(
    "xray",
    snapshot({
      protocol: "shadowsocks",
      port: "8388",
      settings: {
        method: "aes-256-gcm",
        password: "shared",
        clients: [{ method: "aes-128-gcm", password: "user-specific" }],
        network: "tcp",
      },
    }),
  );
  assert.equal(candidate.method, "aes-128-gcm");
  assert.equal(candidate.password, "user-specific");
  assert.equal(candidate.udp, false);
  assert.equal(candidate.reason, "");
});

test("unusable imported listeners expose a reason instead of a broken exit", () => {
  const base = {
    type: "shadowsocks",
    listen_port: 8388,
    method: "2022-blake3-aes-256-gcm",
    password: key(),
  };
  for (const change of [
    { listen: "127.0.0.1" },
    { network: "udp" },
    { password: "invalid" },
    { listen_port: "8000-9000" },
    { method: "unknown" },
    { plugin: "obfs-local" },
  ])
    assert(importedExitCandidates("sing-box", snapshot({ ...base, ...change }))[0].reason);
  const [transport] = importedExitCandidates(
    "xray",
    snapshot({
      protocol: "shadowsocks",
      port: 8388,
      settings: base,
      streamSettings: { network: "ws" },
    }),
  );
  assert(transport.reason);
  assert.deepEqual(importedExitCandidates("nginx", snapshot(base)), []);
});
