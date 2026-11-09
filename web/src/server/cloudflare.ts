import { isIP } from "node:net";
import { sql } from "../db";
import { decrypt } from "./crypto";
import { HttpError } from "./http";

type CFRecord = { id: string; name: string; type: string; content: string; proxied?: boolean };
export async function cloudflare<T>(
  token: string,
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
    cache: "no-store",
  });
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new HttpError(502, "Cloudflare 响应过大");
  let result: { success: boolean; result: T };
  try {
    result = JSON.parse(text);
  } catch {
    throw new HttpError(502, "Cloudflare 响应无效");
  }
  if (!response.ok || !result.success)
    throw new HttpError(
      502,
      `Cloudflare 请求失败 (${response.status})，请检查 Token 的目标域名权限`,
    );
  return result.result;
}
export async function ensureDns(serverId: string, domain: string, addresses: string[]) {
  const [settings] = await sql`SELECT * FROM proxy_settings WHERE id=1`;
  if (
    !settings?.encrypted_token ||
    !settings.zone_id ||
    !(domain === settings.zone_name || domain.endsWith(`.${settings.zone_name}`))
  )
    throw new HttpError(400, "请先配置 Cloudflare Token，并选择包含该子域名的 Zone");
  const token = decrypt(settings.encrypted_token);
  const records = await cloudflare<CFRecord[]>(
    token,
    `/zones/${settings.zone_id}/dns_records?name=${encodeURIComponent(domain)}&per_page=100`,
  );
  const owned = await sql`SELECT * FROM proxy_dns_records WHERE hostname=${domain}`;
  // Validate the complete record set before making any changes. Unknown records are
  // never overwritten, including AAAA records that could break HTTP-01 validation.
  for (const record of records) {
    const match = owned.find(
      (r) =>
        r.record_id === record.id && r.server_id === serverId && r.zone_id === settings.zone_id,
    );
    const address = addresses.find((a) => (isIP(a) === 4 ? "A" : "AAAA") === record.type);
    if (
      !match &&
      (record.type === "CNAME" ||
        ((record.type === "A" || record.type === "AAAA") &&
          (record.content !== address || record.proxied)))
    )
      throw new HttpError(409, `${domain} 存在其他 DNS 记录，请先处理冲突`);
  }
  if (owned.some((r) => r.server_id !== serverId || r.zone_id !== settings.zone_id))
    throw new HttpError(409, "域名已关联其他服务器或 Zone");
  for (const address of addresses) {
    const type = isIP(address) === 4 ? "A" : "AAAA";
    const existing = records.find((r) => r.type === type);
    const data = { type, name: domain, content: address, ttl: 120, proxied: false };
    if (existing && !owned.some((r) => r.record_id === existing.id)) continue; // matching externally-owned record
    const record = await cloudflare<CFRecord>(
      token,
      `/zones/${settings.zone_id}/dns_records${existing ? `/${existing.id}` : ""}`,
      existing ? "PATCH" : "POST",
      data,
    );
    await sql`INSERT INTO proxy_dns_records(hostname,type,zone_id,record_id,server_id) VALUES(${domain},${type},${settings.zone_id},${record.id},${serverId}) ON CONFLICT(hostname,type) DO UPDATE SET record_id=excluded.record_id`;
  }
  for (const record of owned) {
    if (!addresses.some((a) => (isIP(a) === 4 ? "A" : "AAAA") === record.type)) {
      await cloudflare(token, `/zones/${record.zone_id}/dns_records/${record.record_id}`, "DELETE");
      await sql`DELETE FROM proxy_dns_records WHERE record_id=${record.record_id}`;
    }
  }
}
