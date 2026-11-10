import { createCipheriv, createHash, randomBytes } from "node:crypto";

// Shadowrocket 2.2.93 (3488) Subscribe / Password wire format, verified on-device.
// This legacy KDF is required for interoperability; storage uses AES-256-GCM separately.
export function encryptSubscription(uris: string, password: string) {
  const key = createHash("md5").update(password, "utf8").digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  // Node's default PKCS padding matches PKCS#7; encrypt raw URIs, not their Base64 form.
  return Buffer.concat([iv, cipher.update(uris, "utf8"), cipher.final()]).toString("base64");
}
