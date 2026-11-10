import test from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createHash } from "node:crypto";
import { encryptSubscription } from "../src/server/subscription-encryption";
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
import { shadowrocketSubscriptionUri } from "../src/lib/subscriptions";

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

test("per-subscription node aliases replace only URI fragments for both protocols", () => {
  const alias = "香港 / #1 & 😀 ? %";
  for (const [instance, secret] of [
    [node, credentials("reality")],
    [{ ...node, kind: "anytls" }, { password: "node-password" }],
  ] as const) {
    const original = subscriptionUri(instance, secret)!;
    const renamed = subscriptionUri(instance, secret, alias)!;
    assert.equal(decodeURIComponent(new URL(renamed).hash.slice(1)), alias);
    assert.equal(renamed.split("#")[0], original.split("#")[0]);
    assert.equal(subscriptionUri(instance, secret, null), original);
    assert.equal(subscriptionUri(instance, secret, ""), original);
  }
});

test("display name edits preserve omission, trim names and explicitly clear to defaults", () => {
  assert.deepEqual(
    subscriptionUpdate.parse({
      displayName: " 客户端订阅 ",
      nodeDisplayNames: { [id]: " 日本😀 " },
    }),
    { displayName: "客户端订阅", nodeDisplayNames: { [id]: "日本😀" } },
  );
  assert.deepEqual(
    subscriptionUpdate.parse({ displayName: " ", nodeDisplayNames: { [id]: " " } }),
    { displayName: null, nodeDisplayNames: { [id]: null } },
  );
  assert.deepEqual(subscriptionUpdate.parse({ displayName: null }), { displayName: null });
  for (const value of ["a".repeat(101), true, {}]) {
    assert(!subscriptionUpdate.safeParse({ displayName: value }).success);
    assert(!subscriptionUpdate.safeParse({ nodeDisplayNames: { [id]: value } }).success);
  }
  assert(!subscriptionUpdate.safeParse({ nodeDisplayNames: { invalid: "name" } }).success);
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
  const encryptionPassword = "0123456789abcdef";
  assert.deepEqual(subscriptionUpdate.parse({ name: " renamed " }), { name: "renamed" });
  assert(!subscriptionUpdate.safeParse({}).success);
  assert(!subscriptionInput.safeParse({ name: "test", nodeIds: [], encryptionPassword }).success);
  assert(
    !subscriptionInput.safeParse({ name: "test", nodeIds: [id, id], encryptionPassword }).success,
  );
  assert.equal(
    subscriptionInput.parse({ name: "test", nodeIds: [id], encryptionPassword }).enabled,
    true,
  );
});

test("subscription passwords are required on create, preserved on edit and cannot be cleared", () => {
  const password = " 订阅密码🔐-0123456789 ";
  assert(!subscriptionInput.safeParse({ name: "test", nodeIds: [id] }).success);
  assert.deepEqual(subscriptionUpdate.parse({ encryptionPassword: password }), {
    encryptionPassword: password,
  });
  for (const value of [null, "", "probe123", " ".repeat(16), "a".repeat(129), true, {}]) {
    assert(
      !subscriptionInput.safeParse({ name: "test", nodeIds: [id], encryptionPassword: value })
        .success,
    );
    assert(!subscriptionUpdate.safeParse({ encryptionPassword: value }).success);
  }
});

test("Shadowrocket share URI carries URL, password and name without putting the password in HTTP requests", () => {
  const access = {
    url: "https://example.com/sub/测试?a=b+c&x=/=#fragment",
    encryptionPassword: " 密码🔐+/#?&=% 0123456789 ",
    displayName: "手机 · 日本 / #1 & 😀",
  };
  const uri = shadowrocketSubscriptionUri(access);
  const match = /^sub:\/\/([^?]+)\?password=([^#]+)#(.*)$/.exec(uri)!;
  assert(match);
  assert.equal(Buffer.from(match[1], "base64").toString("utf8"), access.url);
  assert.equal(decodeURIComponent(match[2]), access.encryptionPassword);
  assert.equal(decodeURIComponent(match[3]), access.displayName);
  assert(!access.url.includes(access.encryptionPassword));
  assert.equal(
    shadowrocketSubscriptionUri({
      url: "https://example.com",
      encryptionPassword: "0123456789abcdef",
      displayName: "Test",
    }),
    "sub://aHR0cHM6Ly9leGFtcGxlLmNvbQ==?password=0123456789abcdef#Test",
  );
});

test("Shadowrocket payload decrypts to raw UTF-8 URI lines with a fresh prefixed IV", () => {
  const password = " 订阅密码🔐-0123456789 ";
  const uris =
    "trojan://node-before@192.0.2.1:1?sni=example.com#测试\nvless://11111111-1111-4111-8111-111111111111@192.0.2.2:1?encryption=none&type=tcp#TEST";
  const first = Buffer.from(encryptSubscription(uris, password), "base64");
  const second = Buffer.from(encryptSubscription(uris, password), "base64");
  assert.notDeepEqual(first.subarray(0, 16), second.subarray(0, 16));
  assert.equal(first.length % 16, 0);
  const key = createHash("md5").update(password, "utf8").digest();
  for (const plaintext of [uris, "a".repeat(16), "", "中文😀".repeat(100)]) {
    const data = Buffer.from(encryptSubscription(plaintext, password), "base64");
    const decipher = createDecipheriv("aes-128-cbc", key, data.subarray(0, 16));
    assert.equal(
      Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString("utf8"),
      plaintext,
    );
    assert.equal(data.length, 16 + (Math.floor(Buffer.byteLength(plaintext) / 16) + 1) * 16);
  }
  const wrong = createDecipheriv(
    "aes-128-cbc",
    createHash("md5").update("wrong password").digest(),
    first.subarray(0, 16),
  );
  let wrongPlaintext: string | undefined;
  try {
    wrongPlaintext = Buffer.concat([wrong.update(first.subarray(16)), wrong.final()]).toString();
  } catch {
    // CBC has no authentication tag; a wrong key usually fails padding but may yield garbage.
  }
  assert.notEqual(wrongPlaintext, uris);
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
