import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createHmac,
} from "node:crypto";
import { config } from "./config";
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
export const token = () => randomBytes(32).toString("base64url");
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt);
  return `scrypt-v1$${salt}$${key.toString("hex")}`;
}
export async function passwordVerify(password: string, encoded: string) {
  const [version, salt, digest] = encoded.split("$");
  if (
    version !== "scrypt-v1" ||
    !/^[a-f0-9]{32}$/.test(salt ?? "") ||
    !/^[a-f0-9]{128}$/.test(digest ?? "")
  )
    return false;
  const key = await derive(password, salt);
  return timingSafeEqual(key, Buffer.from(digest, "hex"));
}
export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(config().encryptionKey, "hex"), iv);
  cipher.setAAD(Buffer.from("blink-v1"));
  return [
    "v1",
    iv.toString("base64url"),
    Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}
export function decrypt(value: string) {
  const [version, iv, data, tag] = value.split(".");
  if (version !== "v1") throw new Error("Invalid encrypted value");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(config().encryptionKey, "hex"),
    Buffer.from(iv, "base64url"),
  );
  cipher.setAAD(Buffer.from("blink-v1"));
  cipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([cipher.update(Buffer.from(data, "base64url")), cipher.final()]).toString(
    "utf8",
  );
}
export function base32Decode(input: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0,
    value = 0;
  const out: number[] = [];
  for (const c of input.toUpperCase().replace(/=+$/, "")) {
    const n = alphabet.indexOf(c);
    if (n < 0) throw new Error("Invalid TOTP secret");
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 255);
    }
  }
  return Buffer.from(out);
}
export function totp(secret: string, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = hmac[19] & 15;
  return ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, "0");
}
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30000);
  for (const n of [step, step - 1, step + 1])
    if (n >= 0 && timingSafeEqual(Buffer.from(totp(secret, n)), Buffer.from(code))) return n;
  return null;
}
