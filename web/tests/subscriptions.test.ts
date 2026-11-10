import test from "node:test";
import assert from "node:assert/strict";
import { credentials, instanceInput } from "../src/server/proxy-model";
import {
  subscriptionAddress,
  subscriptionInput,
  subscriptionUpdate,
  subscriptionUri,
  subscriptionReason,
  type SubscriptionInstance,
} from "../src/server/subscription-model";
import { connectionIp } from "../src/server/http";
import { serverAddresses, type Server } from "../src/lib/types";

const id = "7f305991-cab7-4ada-a4b3-6f8d5626c7ef";
const node: SubscriptionInstance = {
  id,
  name: "入口 #1 / 日本",
  server_name: "东京 & A",
  kind: "reality",
  state: "active",
  spec: instanceInput.parse({
    serverId: id,
    name: "入口",
    kind: "reality",
    port: 443,
    domain: "node.example.com",
    upstream: "https://example.com",
  }),
  revoked: false,
  addresses: ["2606:4700::1111", "8.8.8.8"],
  desired_version: 2,
  applied_version: 2,
};

test("REALITY URI round-trips Chinese names, Vision and public authentication fields only", () => {
  const secret = credentials("reality");
  assert("privateKey" in secret);
  assert(secret.privateKey);
  const raw = subscriptionUri(node, secret)!;
  const uri = new URL(raw);
  assert.equal(uri.protocol, "vless:");
  assert.equal(uri.hostname, "8.8.8.8");
  assert.equal(uri.username, secret.uuid);
  assert.equal(uri.searchParams.get("security"), "reality");
  assert.equal(uri.searchParams.get("flow"), "xtls-rprx-vision");
  assert.equal(uri.searchParams.get("pbk"), secret.publicKey);
  assert.equal(uri.searchParams.get("sid"), secret.shortId);
  assert.equal(uri.searchParams.get("sni"), "node.example.com");
  assert.equal(uri.searchParams.get("fp"), "chrome");
  assert.equal(decodeURIComponent(uri.hash.slice(1)), "东京 & A · 入口 #1 / 日本");
  assert(!raw.includes(secret.privateKey));
  assert(!raw.includes("defaultOutbound"));
});

test("AnyTLS IPv6 and passwords containing reserved characters round-trip without disabling TLS verification", () => {
  const password = "a+b/c==:@#?% 密码";
  const uri = new URL(
    subscriptionUri({ ...node, kind: "anytls", addresses: ["2606:4700::1111"] }, { password })!,
  );
  assert.equal(uri.protocol, "anytls:");
  assert.equal(uri.hostname, "[2606:4700::1111]");
  assert.equal(decodeURIComponent(uri.username), password);
  assert.equal(uri.password, "");
  assert.equal(uri.searchParams.get("insecure"), "0");
  assert.equal(uri.searchParams.get("sni"), "node.example.com");
});

test("only deployed enabled entrances with applied configuration are exported", () => {
  const secret = credentials("reality");
  for (const patch of [
    { revoked: true },
    { state: "pending" },
    { state: "failed" },
    { state: "disabled" },
    { state: "deleting" },
    { kind: "shadowsocks2022" },
    { addresses: [] },
    { addresses: ["127.0.0.1"] },
    { applied_version: 1 },
    { spec: { ...node.spec, enabled: false } },
    { spec: { ...node.spec, domain: "" } },
  ]) {
    assert(subscriptionReason({ ...node, ...patch }));
    assert.equal(subscriptionUri({ ...node, ...patch }, secret), null);
  }
  assert.equal(subscriptionUri(node, { uuid: id }), null, "missing keys are not serialized");
  assert.equal(subscriptionUri({ ...node, kind: "anytls" }, {}), null);
});

test("subscriptions prefer public IPv4 and fall back to public IPv6", () => {
  assert.equal(subscriptionAddress(node.addresses), "8.8.8.8");
  assert.equal(subscriptionAddress(["127.0.0.1", "2606:4700::1111"]), "2606:4700::1111");
  assert.equal(subscriptionAddress(["10.0.0.1", "::1", "invalid"]), null);
});

test("subscription edits preserve disabled state when only changing the name", () => {
  assert.deepEqual(subscriptionUpdate.parse({ name: " renamed " }), { name: "renamed" });
  assert(!subscriptionUpdate.safeParse({}).success);
  assert(!subscriptionInput.safeParse({ name: "test", nodeIds: [] }).success);
  assert(!subscriptionInput.safeParse({ name: "test", nodeIds: [id, id] }).success);
  assert.equal(subscriptionInput.parse({ name: "test", nodeIds: [id] }).enabled, true);
});

test("connection address accepts one socket IP, normalizes mapped IPv4 and rejects forwarded lists", () => {
  assert.equal(connectionIp("::ffff:8.8.8.8"), "8.8.8.8");
  assert.equal(connectionIp("2606:4700::1111"), "2606:4700::1111");
  for (const value of [undefined, null, "", "8.8.8.8, 1.1.1.1", "[::1]:443", "example.com"])
    assert.equal(connectionIp(value), null);
});

test("server display uses configured addresses before observed connection IP", () => {
  const server = { addresses: node.addresses, connection_ip: "1.1.1.1" } as Server;
  assert.deepEqual(serverAddresses(server), node.addresses);
  assert.deepEqual(serverAddresses({ ...server, addresses: [] }), ["1.1.1.1"]);
  assert.deepEqual(serverAddresses({ ...server, addresses: [], connection_ip: null }), []);
});
