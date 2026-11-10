import { isIP } from "node:net";
import { z } from "zod";
import { isPublicAddress } from "./network";
import type { ProxySpec } from "./proxy-model";

const displayName = z
  .string()
  .trim()
  .max(100)
  .transform((value) => value || null)
  .nullable();

export const subscriptionInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    displayName: displayName.optional(),
    nodeDisplayNames: z
      .record(z.uuid(), displayName)
      .refine((value) => Object.keys(value).length <= 1000, "最多设置 1000 个节点名称")
      .optional(),
    enabled: z.boolean().default(true),
    // Required on creation; omitted on update preserves the current password.
    encryptionPassword: z
      .string()
      .min(16, "加密密码至少需要 16 个字符，建议使用随机生成")
      .max(128, "加密密码不能超过 128 个字符")
      .refine((value) => value.trim().length > 0, "加密密码不能全为空白"),
    nodeIds: z
      .array(z.uuid())
      .min(1)
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length, "节点不能重复"),
  })
  .strict();
export const subscriptionUpdate = subscriptionInput
  .partial()
  .extend({ enabled: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, "需要更新内容");

export function subscriptionAddress(addresses: string[]) {
  const valid = addresses.filter(isPublicAddress);
  return valid.find((ip) => isIP(ip) === 4) ?? valid[0] ?? null;
}

export type SubscriptionInstance = {
  id: string;
  name: string;
  server_name: string;
  kind: string;
  spec: ProxySpec;
  state: string;
  revoked: boolean;
  addresses: string[];
  desired_version: number | null;
  applied_version: number | null;
};

export function subscriptionReason(node: SubscriptionInstance) {
  if (node.kind !== "reality" && node.kind !== "anytls") return "仅支持 REALITY / AnyTLS 入口";
  if (node.revoked) return "服务器已吊销";
  if (!node.spec.enabled || node.state === "disabled") return "入口已停用";
  if (node.state === "deleting") return "入口正在删除";
  if (node.state !== "active") return node.state === "failed" ? "入口部署失败" : "入口正在部署";
  if (node.desired_version !== node.applied_version) return "节点配置尚未应用";
  if (!subscriptionAddress(node.addresses)) return "缺少公网 IP";
  if (
    !node.spec.domain ||
    !Number.isInteger(node.spec.port) ||
    node.spec.port < 1 ||
    node.spec.port > 65535
  )
    return "入口连接配置不完整";
  return null;
}

const realityCredentials = z.object({
  uuid: z.uuid(),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  shortId: z.string().regex(/^(?:[0-9a-fA-F]{2}){1,8}$/),
});
const anytlsCredentials = z.object({ password: z.string().min(1).max(4096) });

// Serialize only client fields: never include the REALITY private key or server routing rules.
export function subscriptionUri(
  node: SubscriptionInstance,
  credentials: unknown,
  displayName?: string | null,
) {
  if (subscriptionReason(node)) return null;
  const address = subscriptionAddress(node.addresses)!;
  const endpoint = `${isIP(address) === 6 ? `[${address}]` : address}:${node.spec.port}`;
  const label = encodeURIComponent(displayName || `${node.server_name} · ${node.name}`);
  if (node.kind === "reality") {
    const parsed = realityCredentials.safeParse(credentials);
    if (!parsed.success) return null;
    const { uuid, publicKey, shortId } = parsed.data;
    const query = new URLSearchParams({
      encryption: "none",
      security: "reality",
      type: "tcp",
      flow: "xtls-rprx-vision",
      sni: node.spec.domain,
      fp: "chrome",
      pbk: publicKey,
      sid: shortId,
    });
    return `vless://${uuid}@${endpoint}?${query}#${label}`;
  }
  const parsed = anytlsCredentials.safeParse(credentials);
  if (!parsed.success) return null;
  const query = new URLSearchParams({ sni: node.spec.domain, insecure: "0" });
  return `anytls://${encodeURIComponent(parsed.data.password)}@${endpoint}/?${query}#${label}`;
}
