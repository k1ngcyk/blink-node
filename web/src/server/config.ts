import { readFileSync } from "node:fs";

export function secret(name: string): string {
  const path = process.env[`${name}_FILE`];
  return path ? readFileSync(path, "utf8").trim() : (process.env[name] ?? "");
}
export function config() {
  const publicUrl = new URL(process.env.PUBLIC_URL ?? "http://localhost:3000");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname);
  if (
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash
  )
    throw new Error("PUBLIC_URL must be an origin");
  if (
    publicUrl.protocol !== "https:" &&
    !(local && process.env.ALLOW_INSECURE_LOCALHOST === "true")
  )
    throw new Error("HTTPS is required (localhost development must explicitly opt in)");
  const encryptionKey = secret("ENCRYPTION_KEY");
  if (!/^[a-f0-9]{64}$/i.test(encryptionKey))
    throw new Error("ENCRYPTION_KEY must be 32 random bytes encoded as hex");
  return {
    origin: publicUrl.origin,
    secure: publicUrl.protocol === "https:",
    encryptionKey,
    cookie: publicUrl.protocol === "https:" ? "__Host-blink" : "blink-dev",
    trustedProxy: process.env.TRUST_PROXY === "true",
    gatewayPort: Number(process.env.GATEWAY_PORT ?? 3001),
    gatewayHost: process.env.GATEWAY_HOST ?? "127.0.0.1",
    sessionSeconds: 8 * 3600,
  };
}
