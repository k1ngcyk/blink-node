import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  importedEntranceCandidates,
  type ImportedEntranceCandidate,
} from "../src/server/proxy-entrances";
import { credentials } from "../src/server/proxy-model";
import {
  subscriptionUri,
  subscriptionReason,
  type SubscriptionInstance,
} from "../src/server/subscription-model";

const snapshot = (...inbounds: unknown[]) => ({ effective: { inbounds } });
const reality = credentials("reality");
const xray = {
  protocol: "vless",
  tag: "existing",
  port: 8443,
  settings: {
    decryption: "none",
    clients: [
      { id: randomUUID(), flow: "xtls-rprx-vision", email: "first" },
      { id: randomUUID(), flow: "", email: "second" },
    ],
  },
  streamSettings: {
    network: "raw",
    security: "reality",
    realitySettings: {
      privateKey: reality.privateKey,
      serverNames: ["one.example.com", "two.example.com"],
      shortIds: [""],
    },
  },
};
function node(candidate: ImportedEntranceCandidate): SubscriptionInstance {
  return {
    id: randomUUID(),
    name: "已有入口",
    server_name: "服务器",
    kind: candidate.kind,
    spec: {
      enabled: true,
      domain: candidate.domain || "manual.example.com",
      port: candidate.port,
      client: candidate.client,
    },
    state: "active",
    source: "imported",
    revoked: false,
    addresses: ["2606:4700::1111"],
    desired_version: 8,
    applied_version: 2,
  };
}

test("Xray REALITY derives public keys, preserves per-user flow and accepts empty short IDs", () => {
  const candidates = importedEntranceCandidates("xray", snapshot(xray));
  assert.equal(candidates.length, 2);
  for (const [index, candidate] of candidates.entries()) {
    assert.equal(candidate.reason, "");
    assert.equal(candidate.key, `0:${index}`);
    assert.equal(candidate.port, 8443);
    assert.equal(candidate.credentials.publicKey, reality.publicKey);
    assert.equal(candidate.credentials.shortId, "");
    assert(!JSON.stringify(candidate).includes(reality.privateKey!));
    const uri = new URL(subscriptionUri(node(candidate), candidate.credentials)!);
    assert.equal(uri.hostname, "[2606:4700::1111]");
    assert.equal(uri.searchParams.get("flow"), index ? null : "xtls-rprx-vision");
    assert.equal(uri.searchParams.get("sid"), "");
    assert.equal(uri.searchParams.get("pbk"), reality.publicKey);
    assert.equal(uri.searchParams.get("sni"), "one.example.com");
  }
});

test("sing-box AnyTLS preserves multiple passwords, ALPN and supports manually supplied certificate SNI", () => {
  const users = [
    { name: "one", password: "a+b/c==:@#?% 密码" },
    { name: "two", password: "second" },
  ];
  const candidates = importedEntranceCandidates(
    "sing-box",
    snapshot({
      type: "anytls",
      listen: "::",
      listen_port: 443,
      tls: { enabled: true, alpn: ["h2", "http/1.1"] },
      users,
    }),
  );
  assert.equal(candidates.length, 2);
  for (const [index, candidate] of candidates.entries()) {
    assert.equal(candidate.reason, "");
    assert.equal(candidate.domain, "");
    const uri = new URL(subscriptionUri(node(candidate), candidate.credentials)!);
    assert.equal(uri.protocol, "anytls:");
    assert.equal(decodeURIComponent(uri.username), users[index].password);
    assert.equal(uri.searchParams.get("insecure"), "0");
    assert.equal(uri.searchParams.get("alpn"), "h2,http/1.1");
    assert.equal(uri.searchParams.get("sni"), "manual.example.com");
  }
});

test("sing-box REALITY supports scalar short ID and handshake SNI", () => {
  const [candidate] = importedEntranceCandidates(
    "sing-box",
    snapshot({
      type: "vless",
      listen_port: 443,
      users: [{ uuid: randomUUID(), flow: "xtls-rprx-vision" }],
      tls: {
        enabled: true,
        reality: {
          enabled: true,
          private_key: reality.privateKey,
          short_id: "abcd",
          handshake: { server: "target.example.com", server_port: 443 },
        },
      },
    }),
  );
  assert.equal(candidate.reason, "");
  assert.equal(candidate.domain, "target.example.com");
  assert.equal(candidate.credentials.publicKey, reality.publicKey);
  assert.equal(candidate.credentials.shortId, "abcd");
});

test("TLS Vision and legacy XTLS serialize their original security and flow", () => {
  for (const [security, flow] of [
    ["tls", "xtls-rprx-vision"],
    ["xtls", "xtls-rprx-direct"],
    ["tls", ""],
  ]) {
    const [candidate] = importedEntranceCandidates(
      "xray",
      snapshot({
        ...xray,
        settings: { clients: [{ id: randomUUID(), flow }] },
        streamSettings: {
          method: "raw",
          security,
          tlsSettings: { serverName: "tls.example.com" },
          xtlsSettings: { serverName: "xtls.example.com" },
        },
      }),
    );
    assert.equal(candidate.kind, "vless");
    assert.equal(candidate.reason, "");
    const uri = new URL(subscriptionUri(node(candidate), candidate.credentials)!);
    assert.equal(uri.searchParams.get("security"), security);
    assert.equal(uri.searchParams.get("flow"), flow || null);
    assert.equal(uri.searchParams.get("pbk"), null);
  }
});

test("unsupported or incomplete listeners explain why; remote proxies never become entrances", () => {
  for (const change of [
    { port: "8000-9000" },
    { listen: "127.0.0.1" },
    { settings: { clients: [{ id: "invalid" }] } },
    { settings: { clients: [{ id: randomUUID(), flow: "unknown" }] } },
    { streamSettings: { ...xray.streamSettings, network: "ws" } },
    { streamSettings: { ...xray.streamSettings, network: "grpc" } },
    { streamSettings: { ...xray.streamSettings, security: "none" } },
    {
      streamSettings: {
        ...xray.streamSettings,
        realitySettings: { ...xray.streamSettings.realitySettings, privateKey: "invalid" },
      },
    },
    { streamSettings: { ...xray.streamSettings, rawSettings: { acceptProxyProtocol: true } } },
  ])
    assert(importedEntranceCandidates("xray", snapshot({ ...xray, ...change }))[0].reason);
  const plainAny = { type: "anytls", listen_port: 443, users: [{ password: "secret" }] };
  assert(importedEntranceCandidates("sing-box", snapshot(plainAny))[0].reason);
  assert(
    importedEntranceCandidates(
      "sing-box",
      snapshot({ ...plainAny, tls: { enabled: true, client_authentication: "require-any" } }),
    )[0].reason,
  );
  assert.deepEqual(importedEntranceCandidates("xray", { effective: { outbounds: [xray] } }), []);
  assert.deepEqual(importedEntranceCandidates("mihomo", snapshot(xray)), []);
});

test("fingerprints track only this user's connection and stale imported entrances are excluded", () => {
  const [first] = importedEntranceCandidates("xray", snapshot(xray));
  const changed = structuredClone(xray);
  changed.settings.clients[1].id = randomUUID();
  assert.equal(
    importedEntranceCandidates("xray", snapshot(changed))[0].fingerprint,
    first.fingerprint,
  );
  changed.settings.clients[0].id = randomUUID();
  assert.notEqual(
    importedEntranceCandidates("xray", snapshot(changed))[0].fingerprint,
    first.fingerprint,
  );
  const imported = node(first);
  assert.equal(
    subscriptionReason(imported),
    null,
    "managed deployment versions don't gate external services",
  );
  for (const change of [{ state: "stale" }, { revoked: true }, { addresses: [] }]) {
    assert(subscriptionReason({ ...imported, ...change }));
    assert.equal(subscriptionUri({ ...imported, ...change }, first.credentials), null);
  }
});
