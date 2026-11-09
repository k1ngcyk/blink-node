import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { isPublicAddress } from "./network";

export const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const outbound = z.union([z.literal("direct"), z.uuid()]);
export const routeRule = z
  .object({
    match: z.enum(["domain", "domain_suffix", "ip_cidr"]),
    values: z.array(z.string().trim().min(1).max(253)).min(1).max(100),
    outbound,
  })
  .superRefine((r, ctx) => {
    for (const value of r.values) {
      if (r.match === "ip_cidr") {
        const [address, bits, extra] = value.split("/");
        const family = isIP(address);
        if (
          !family ||
          extra ||
          (bits !== undefined && (!/^\d+$/.test(bits) || Number(bits) > (family === 4 ? 32 : 128)))
        )
          ctx.addIssue({ code: "custom", message: "IP/CIDR 格式不正确" });
      } else if (!hostname.safeParse(value).success)
        ctx.addIssue({ code: "custom", message: "域名规则格式不正确" });
    }
  });
export const instanceInput = z
  .object({
    serverId: z.uuid(),
    name: z.string().trim().min(1).max(100),
    kind: z.enum(["reality", "anytls", "shadowsocks2022"]),
    port: z.number().int().min(1).max(65535),
    domain: z.union([hostname, z.literal("")]).default(""),
    fallbackPort: z.number().int().min(1024).max(65535).default(8003),
    upstream: z.string().max(2048).default(""),
    defaultOutbound: outbound.default("direct"),
    rules: z.array(routeRule).max(100).default([]),
    enabled: z.boolean().default(true),
    manageDns: z.boolean().default(true),
    udp: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.kind !== "shadowsocks2022" && !v.domain)
      ctx.addIssue({ code: "custom", message: "TLS / 证书需要域名" });
    if (v.kind === "reality") {
      if (v.port !== 443) ctx.addIssue({ code: "custom", message: "REALITY 入口固定为 443" });
      try {
        const u = new URL(v.upstream);
        if (
          u.protocol !== "https:" ||
          u.username ||
          u.password ||
          u.pathname !== "/" ||
          u.search ||
          u.hash ||
          !hostname.safeParse(u.hostname).success
        )
          throw new Error();
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "伪装上游需要 HTTPS 域名源站地址，例如 https://www.example.com",
        });
      }
    }
    if (v.port === 80 || v.port === v.fallbackPort)
      ctx.addIssue({ code: "custom", message: "端口与 HTTP 验证或本地 TLS 端口冲突" });
    if (v.kind === "shadowsocks2022" && (v.defaultOutbound !== "direct" || v.rules.length))
      ctx.addIssue({ code: "custom", message: "两跳链路的 SS2022 落地必须直接出网" });
  });
export type ProxySpec = z.infer<typeof instanceInput>;
export const proxyStatus = z.object({
  instances: z
    .array(
      z.object({
        id: z.uuid(),
        kind: z.enum(["reality", "anytls", "shadowsocks2022"]),
        port: z.number().int().min(1).max(65535),
        state: z.string().max(40),
        certificate: z
          .object({
            path: z.string().max(4096),
            notAfter: z.string().max(300).optional(),
            issuer: z.string().max(300).optional(),
            subject: z.string().max(300).optional(),
          })
          .optional(),
      }),
    )
    .max(32)
    .default([]),
  ufw: z.string().max(12000).optional(),
  ufwState: z.enum(["active", "inactive", "not_installed", "error"]).optional(),
  checkedAt: z.iso.datetime().optional(),
  network: z
    .object({
      checkedAt: z.iso.datetime(),
      addresses: z
        .array(
          z.object({
            address: z.string().max(45).refine(isPublicAddress, "需要有效的公网 IP"),
            source: z.enum(["interface", "ip.sb"]),
            interface: z.string().max(64).optional(),
          }),
        )
        .max(2)
        .refine(
          (v) => new Set(v.map((a) => isIP(a.address))).size === v.length,
          "每种地址族最多一个地址",
        ),
    })
    .optional(),
  version: z.number().int().nonnegative().optional(),
});
export type ProxyStatus = z.infer<typeof proxyStatus>;
export const proxyResult = z.object({
  type: z.literal("proxy.result"),
  v: z.literal(1),
  taskId: z.uuid(),
  desiredVersion: z.number().int().nonnegative(),
  ok: z.boolean(),
  result: z.record(z.string(), z.unknown()),
});
export const proxyStatusMessage = z.object({
  type: z.literal("proxy.status"),
  v: z.literal(1),
  status: proxyStatus,
});
export const hostInput = z.object({
  addresses: z
    .array(z.string().refine(isPublicAddress, "需要有效的公网 IP"))
    .min(1)
    .max(2)
    .refine((v) => new Set(v.map(isIP)).size === v.length, "每种地址族最多一个地址"),
  firewall: z.enum(["existing", "enable", "external"]).default("existing"),
});
export function referencedExits(spec: ProxySpec) {
  return [
    ...new Set(
      [spec.defaultOutbound, ...spec.rules.map((r) => r.outbound)].filter((v) => v !== "direct"),
    ),
  ];
}
export function credentials(kind: ProxySpec["kind"]) {
  if (kind === "reality") {
    const pair = generateKeyPairSync("x25519");
    return {
      uuid: randomUUID(),
      privateKey: pair.privateKey
        .export({ format: "der", type: "pkcs8" })
        .subarray(-32)
        .toString("base64url"),
      publicKey: pair.publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("base64url"),
      shortId: randomBytes(8).toString("hex"),
    };
  }
  return {
    password: randomBytes(32).toString("base64"),
    ...(kind === "shadowsocks2022" ? { method: "2022-blake3-aes-256-gcm" } : {}),
  };
}
// Applies to imported, unknown fields too. Raw snapshots are only stored encrypted.
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /password|private.?key|secret|token|credential|uuid|short.?ids?|^id$|^key$|^seed$|mldsa65seed/i.test(
          k,
        )
          ? "••••••••"
          : redact(v),
      ]),
    );
  return value;
}
