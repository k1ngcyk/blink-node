import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  instanceInput,
  hostInput,
  credentials,
  redact,
  referencedExits,
} from "../src/server/proxy-model";

const serverId = "7f305991-cab7-4ada-a4b3-6f8d5626c7ef";
const base = {
  serverId,
  name: "test",
  kind: "reality",
  port: 443,
  domain: "node.example.com",
  upstream: "https://www.example.com",
};
test("REALITY requires owned domain, port 443 and an HTTPS upstream origin", () => {
  assert.equal(instanceInput.parse(base).fallbackPort, 8003);
  for (const invalid of [
    { port: 8443 },
    { domain: "" },
    { upstream: "https://user:secret@example.com" },
    { upstream: "https://example.com/path" },
    { upstream: "file:///etc/passwd" },
    { fallbackPort: 443 },
  ])
    assert.equal(instanceInput.safeParse({ ...base, ...invalid }).success, false);
});
test("SS2022 exits terminate chains rather than introduce recursion", () => {
  const ss = { ...base, kind: "shadowsocks2022", port: 8388 };
  assert(instanceInput.safeParse(ss).success);
  assert(!instanceInput.safeParse({ ...ss, defaultOutbound: serverId }).success);
});
test("rules validate CIDR/domain syntax and retain priority", () => {
  const rules = [
    { match: "domain", values: ["first.example.com"], outbound: serverId },
    { match: "ip_cidr", values: ["1.1.1.0/24", "2606:4700::/32"], outbound: "direct" },
  ];
  const parsed = instanceInput.parse({ ...base, rules });
  assert.deepEqual(parsed.rules, rules);
  assert.deepEqual(referencedExits(parsed), [serverId]);
  for (const value of ["1.1.1.1/33", "::/129", "1.1.1.1/-1", "example.com/24"])
    assert(
      !instanceInput.safeParse({ ...base, rules: [{ ...rules[1], values: [value] }] }).success,
    );
});
test("host addresses reject private IPs and duplicate address families", () => {
  assert(hostInput.safeParse({ addresses: ["8.8.8.8", "2606:4700::1111"] }).success);
  for (const addresses of [["127.0.0.1"], ["169.254.169.254"], ["8.8.8.8", "1.1.1.1"]])
    assert(!hostInput.safeParse({ addresses }).success);
});
test("generated REALITY keypair and SS2022 key lengths are interoperable", () => {
  const secret = credentials("reality");
  assert("privateKey" in secret && secret.privateKey);
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b656e04220420", "hex"),
      Buffer.from(secret.privateKey, "base64url"),
    ]),
    format: "der",
    type: "pkcs8",
  });
  assert.equal(
    createPublicKey(key)
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64url"),
    secret.publicKey,
  );
  const ss = credentials("shadowsocks2022");
  assert("password" in ss && ss.password);
  assert.equal(Buffer.from(ss.password, "base64").length, 32);
});
test("import views redact nested authentication fields", () => {
  const result = JSON.stringify(
    redact({
      inbounds: [
        {
          users: [{ uuid: "uuid-secret", password: "password-secret", id: "id-secret" }],
          tls: { key: "pem-secret", reality: { private_key: "key-secret" } },
        },
      ],
      port: 443,
    }),
  );
  for (const secret of ["uuid-secret", "password-secret", "id-secret", "pem-secret", "key-secret"])
    assert(!result.includes(secret));
  assert(result.includes("443"));
});
