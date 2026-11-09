import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  passwordHash,
  passwordVerify,
  encrypt,
  decrypt,
  totp,
  verifyTotp,
  hash,
  token,
} from "../src/server/crypto";
import { isPublicAddress, targetUrl, validateTarget } from "../src/server/network";
import { config } from "../src/server/config";
import { sameOrigin, body, HttpError } from "../src/server/http";
import { transition } from "../src/server/alerts";
import { billingStart, summary } from "../src/server/metrics";
import { metricSchema } from "../src/server/protocol";
import { z } from "zod";
process.env.PUBLIC_URL = "https://blink.example.com";
process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");

test("password derivation uses independent salts and constant-time digest verification", async () => {
  const p = "long unique passphrase for test only";
  const a = await passwordHash(p),
    b = await passwordHash(p);
  assert.notEqual(a, b);
  assert(await passwordVerify(p, a));
  assert.equal(await passwordVerify(p + "x", a), false);
  assert.equal(await passwordVerify(p, "malformed"), false);
});
test("TOTP RFC 6238 SHA1 vector, clock window and invalid format", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totp(secret, 1), "287082");
  assert.equal(verifyTotp(secret, "287082", 59000), 1);
  assert.equal(verifyTotp(secret, "287082", 120000), null);
  assert.equal(verifyTotp(secret, "28708x", 59000), null);
});
test("encrypted notification credentials are authenticated and randomized", () => {
  const a = encrypt("secret data"),
    b = encrypt("secret data");
  assert.notEqual(a, b);
  assert.equal(decrypt(a), "secret data");
  const parts = a.split(".");
  parts[2] = Buffer.from("tamper").toString("base64url");
  assert.throws(() => decrypt(parts.join(".")));
  assert.throws(() => decrypt("v0.abc.def.ghi"));
});
test("public address policy denies metadata, mapped IPv4, multicast and special ranges", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.1.1",
    "100.100.100.200",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "0.0.0.0",
    "224.0.0.1",
    "198.18.0.1",
    "203.0.113.1",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "fc00::1",
    "2001:db8::1",
    "not-an-ip",
  ])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
    assert.equal(isPublicAddress(ip), true, ip);
});
test("SSRF target validation rejects alternate URL schemes and encoded loopback", async () => {
  assert.throws(() => targetUrl("http", "file:///etc/passwd"));
  assert.throws(() => targetUrl("http", "https://user:pass@example.com"));
  await assert.rejects(validateTarget("http", "http://2130706433/"));
  await assert.rejects(validateTarget("tcp", "[::ffff:127.0.0.1]:22"));
  await assert.rejects(validateTarget("icmp", "-c10"));
});
test("mutating browser requests require the exact configured origin", () => {
  sameOrigin(new Headers({ origin: "https://blink.example.com", "sec-fetch-site": "same-origin" }));
  for (const origin of [
    "https://evil.example.com",
    "https://blink.example.com.evil.test",
    "null",
    "",
  ])
    assert.throws(() => sameOrigin(new Headers({ origin })), HttpError);
});
test("bounded JSON body works even when Content-Length is absent", async () => {
  const request = new Request("https://blink.example.com", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ a: "x".repeat(200) }),
  });
  await assert.rejects(
    body(request, z.object({ a: z.string() }), 64),
    (e) => e instanceof HttpError && e.status === 413,
  );
});
test("secure cookie and TLS policy fail closed", () => {
  assert.equal(config().cookie, "__Host-blink");
  process.env.PUBLIC_URL = "http://public.example.com";
  assert.throws(config);
  process.env.PUBLIC_URL = "https://blink.example.com";
  assert.equal(token().length, 43);
  assert.equal(hash(token()).length, 64);
});
test("alerts require sustained breach, use hysteresis and recover independently", () => {
  assert.equal(transition(undefined, 95, 90, 80, 60, 0, 0), "pending");
  assert.equal(transition("pending", 95, 90, 80, 60, 0, 59000), "pending");
  assert.equal(transition("pending", 95, 90, 80, 60, 0, 60000), "firing");
  assert.equal(transition("firing", 85, 90, 80, 60, 0, 70000), "firing");
  assert.equal(transition("firing", 80, 90, 80, 60, 0, 80000), "resolved");
  assert.equal(transition(undefined, 10, 14, 21, 0, 0, 0, true), "firing");
  assert.equal(transition("firing", 21, 14, 21, 0, 0, 0, true), "resolved");
});
test("billing windows handle year boundaries in UTC", () => {
  assert.equal(
    billingStart(10, new Date("2026-01-05T12:00:00Z")).toISOString(),
    "2025-12-10T00:00:00.000Z",
  );
  assert.equal(
    billingStart(1, new Date("2026-01-05T12:00:00Z")).toISOString(),
    "2026-01-01T00:00:00.000Z",
  );
});
test("wire schema rejects impossible CPU or unsafe sequences", () => {
  assert.equal(
    metricSchema.safeParse({ cpu: 101, seq: Number.MAX_SAFE_INTEGER + 1 }).success,
    false,
  );
  const m = metricSchema.parse({
    bootId: "3d018f3d-6404-4316-a6dc-f94517b0003a",
    seq: 1,
    at: new Date().toISOString(),
    uptime: 1,
    cpu: 10,
    cores: [10],
    load: [0, 0, 0],
    memoryTotal: 100,
    memoryUsed: 50,
    swapTotal: 0,
    swapUsed: 0,
    disks: [],
    networks: [],
    diskReadRate: 0,
    diskWriteRate: 0,
    temperatures: [],
  });
  assert.equal(summary(m).memory, 50);
  assert.equal(summary(m).disk, 0);
});
