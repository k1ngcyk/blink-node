import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import http from "node:http";
import { spawn } from "node:child_process";
import ipaddr from "ipaddr.js";

export function isPublicAddress(address: string) {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress())
      ip = (ip as ipaddr.IPv6).toIPv4Address();
    if (ip.kind() === "ipv6") {
      const v = ip as ipaddr.IPv6;
      if ((v.toByteArray()[0] & 0xe0) !== 0x20) return false;
      for (const cidr of ["2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"])
        if (v.match(ipaddr.IPv6.parseCIDR(cidr))) return false;
    }
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
export function targetUrl(kind: string, target: string) {
  const u = new URL(kind === "http" ? target : `${kind === "tls" ? "https" : "http"}://${target}`);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.hash ||
    (kind !== "http" && (u.pathname !== "/" || u.search))
  )
    throw new Error("Invalid target");
  if (u.hostname.endsWith(".") || u.hostname.includes("%")) throw new Error("Invalid target host");
  if (kind === "tls" && u.protocol !== "https:") throw new Error("TLS required");
  return u;
}
export async function resolvePublic(host: string) {
  const clean = host.replace(/^\[|\]$/g, "");
  const results = isIP(clean)
    ? [{ address: clean, family: isIP(clean) }]
    : await lookup(clean, { all: true });
  if (!results.length || results.some((r) => !isPublicAddress(r.address)))
    throw new Error("Private or special-use destination is not allowed");
  return results[0];
}
export async function validateTarget(kind: string, target: string) {
  if (kind === "icmp") {
    if (!/^[a-zA-Z0-9.:[\]-]+$/.test(target) || target.startsWith("-"))
      throw new Error("Invalid host");
    await resolvePublic(target);
  } else await resolvePublic(targetUrl(kind, target).hostname);
}
export async function safeRequest(
  url: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {},
) {
  const u = targetUrl("http", url),
    resolved = await resolvePublic(u.hostname);
  return new Promise<{ status: number; certificateDays: number | null }>((resolve, reject) => {
    const req = (u.protocol === "https:" ? https : http).request(
      u,
      {
        method: options.method ?? "GET",
        headers: { "User-Agent": "BlinkNode/0.1", ...options.headers },
        lookup: (_hostname, _opts, cb) => cb(null, resolved.address, resolved.family),
        timeout: 8000,
        maxHeaderSize: 16384,
        family: resolved.family,
      },
      (res) => {
        const cert = res.socket instanceof tls.TLSSocket ? res.socket.getPeerCertificate() : null;
        const certificateDays = cert?.valid_to
          ? (Date.parse(cert.valid_to) - Date.now()) / 86400000
          : null;
        resolve({ status: res.statusCode ?? 0, certificateDays });
        res.destroy();
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("Request timeout")), 10000);
    req.on("close", () => clearTimeout(timer));
    req.on("timeout", () => req.destroy(new Error("Request timeout")));
    req.on("error", reject);
    req.end(options.body);
  });
}
export async function runCheck(check: { id: string; kind: string; target: string }) {
  const start = performance.now();
  const result = {
    id: check.id,
    at: new Date().toISOString(),
    ok: false,
    latencyMs: null as number | null,
    loss: null as number | null,
    status: null as number | null,
    certificateDays: null as number | null,
    error: null as string | null,
  };
  try {
    if (check.kind === "http") {
      const r = await safeRequest(check.target);
      result.status = r.status;
      result.certificateDays = r.certificateDays;
      result.ok = r.status >= 200 && r.status < 400;
    } else if (check.kind === "icmp") {
      const address = await resolvePublic(check.target);
      const text = await new Promise<string>((resolve, reject) => {
        const args =
          process.platform === "darwin"
            ? ["-n", "-c", "3", "-W", "2000", address.address]
            : ["-n", "-c", "3", "-W", "2", address.address];
        const p = spawn("ping", args, {
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", NODE_ENV: process.env.NODE_ENV },
          stdio: ["ignore", "pipe", "ignore"],
        });
        let output = "";
        p.stdout.on("data", (d) => {
          if (output.length < 8000) output += d.toString();
        });
        const timer = setTimeout(() => p.kill("SIGKILL"), 9000);
        p.on("error", reject);
        p.on("close", () => {
          clearTimeout(timer);
          resolve(output);
        });
      });
      const loss = /(\d+(?:\.\d+)?)% packet loss/.exec(text);
      result.loss = loss ? Number(loss[1]) : 100;
      const rtt = /= [\d.]+\/([\d.]+)\//.exec(text);
      result.latencyMs = rtt ? Number(rtt[1]) : null;
      result.ok = result.loss < 100;
    } else {
      const u = targetUrl(check.kind, check.target),
        r = await resolvePublic(u.hostname),
        port = Number(u.port || (check.kind === "tls" ? 443 : 80));
      await new Promise<void>((resolve, reject) => {
        const socket =
          check.kind === "tls"
            ? tls.connect({
                host: r.address,
                port,
                servername: isIP(u.hostname) ? undefined : u.hostname,
                rejectUnauthorized: true,
              })
            : net.connect({ host: r.address, port });
        const timer = setTimeout(() => socket.destroy(new Error("Connection timeout")), 8000);
        socket.on("error", reject);
        socket.on("close", () => clearTimeout(timer));
        socket.once(check.kind === "tls" ? "secureConnect" : "connect", () => {
          if (socket instanceof tls.TLSSocket)
            result.certificateDays =
              (Date.parse(socket.getPeerCertificate().valid_to) - Date.now()) / 86400000;
          socket.destroy();
          resolve();
        });
      });
      result.ok = true;
    }
    if (check.kind !== "icmp")
      result.latencyMs = Math.round((performance.now() - start) * 100) / 100;
    if (!result.ok) result.error = "检查未通过";
  } catch {
    result.error = "连接失败、超时或目标地址不受允许";
  }
  return result;
}
