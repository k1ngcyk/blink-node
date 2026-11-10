import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import { sql } from "../db";
import type { SubscriptionNode } from "../lib/subscriptions";
import { audit, elevated, rateLimit, type owner } from "./auth";
import { config } from "./config";
import { decrypt, encrypt, hash, token } from "./crypto";
import { body, clientIp, failure, HttpError, json } from "./http";
import { encryptSubscription } from "./subscription-encryption";
import {
  subscriptionAddress,
  subscriptionInput,
  subscriptionUpdate,
  subscriptionReason,
  subscriptionUri,
  type SubscriptionInstance,
} from "./subscription-model";

type User = Awaited<ReturnType<typeof owner>>;
type DB = typeof sql | TransactionSql;
type StoredNode = SubscriptionInstance & { encrypted_credentials: string };

async function loadNodes(db: DB, ids?: string[], displayNames?: Map<string, string | null>) {
  const rows = await db<StoredNode[]>`
    SELECT p.id,p.name,p.kind,p.spec,p.state,p.encrypted_credentials,s.name AS server_name,
      s.revoked,coalesce(h.addresses,'{}'::text[]) AS addresses,h.desired_version,h.applied_version
    FROM proxy_instances p JOIN servers s ON s.id=p.server_id
    LEFT JOIN proxy_hosts h ON h.server_id=s.id
    WHERE p.kind IN ('reality','anytls') ${ids ? db`AND p.id IN ${db(ids)}` : db``}
    ORDER BY s.group_name,s.name,p.created_at,p.id`;
  return rows.map((row) => {
    let reason = subscriptionReason(row);
    const uri = reason
      ? null
      : subscriptionUri(
          row,
          JSON.parse(decrypt(row.encrypted_credentials)),
          displayNames?.get(row.id),
        );
    if (!reason && !uri) reason = "入口认证配置不完整";
    const node: SubscriptionNode & { instanceId: string } = {
      instanceId: row.id,
      name: row.name,
      displayName: displayNames?.get(row.id) ?? null,
      serverName: row.server_name,
      kind: row.kind as "reality" | "anytls",
      address: subscriptionAddress(row.addresses),
      port: row.spec.port,
      reason,
    };
    return { node, uri };
  });
}

async function replaceNodes(tx: TransactionSql, id: string, ids: string[]) {
  const nodes = await tx<{ id: string; name: string }[]>`
    SELECT id,name FROM proxy_instances WHERE id IN ${tx(ids)} AND kind IN ('reality','anytls')
    FOR KEY SHARE`;
  if (nodes.length !== ids.length) throw new HttpError(400, "请选择仍存在的 REALITY / AnyTLS 入口");
  const previous = await tx<{ instance_id: string | null; display_name: string | null }[]>`
    SELECT instance_id,display_name FROM proxy_subscription_nodes WHERE subscription_id=${id}`;
  const displayNames = new Map(previous.map((node) => [node.instance_id, node.display_name]));
  await tx`DELETE FROM proxy_subscription_nodes WHERE subscription_id=${id}`;
  const names = new Map(nodes.map((node) => [node.id, node.name]));
  await tx`INSERT INTO proxy_subscription_nodes ${tx(
    ids.map((instanceId, position) => ({
      subscription_id: id,
      instance_id: instanceId,
      name: names.get(instanceId)!,
      display_name: displayNames.get(instanceId) ?? null,
      position,
    })),
  )}`;
}

async function updateNodeDisplayNames(
  tx: TransactionSql,
  id: string,
  names: Record<string, string | null>,
) {
  const entries = Object.entries(names).map(([instanceId, displayName]) => ({
    instance_id: instanceId,
    display_name: displayName,
  }));
  if (!entries.length) return;
  const updated = await tx`
    UPDATE proxy_subscription_nodes AS member SET display_name=names.display_name
    FROM jsonb_to_recordset(${tx.json(entries)}) AS names(instance_id uuid,display_name text)
    WHERE member.subscription_id=${id} AND member.instance_id=names.instance_id
    RETURNING member.instance_id`;
  if (updated.length !== entries.length)
    throw new HttpError(400, "只能为当前订阅中已选择的节点设置名称");
}

const link = (raw: string) => `${config().origin}/sub/${raw}`;

export async function subscriptionsApi(request: Request, path: string[], user: User) {
  const method = request.method;
  if (method !== "GET") elevated(user);
  if (!path.length && method === "GET") {
    // One database snapshot keeps memberships and candidate state consistent during deletion.
    const result = await sql.begin("isolation level repeatable read read only", async (tx) => {
      const subscriptions =
        await tx`SELECT id,name,display_name,enabled,encrypted_password IS NOT NULL AS encrypted,created_at,updated_at FROM proxy_subscriptions ORDER BY created_at DESC,id`;
      const members =
        await tx`SELECT subscription_id,instance_id,name,display_name FROM proxy_subscription_nodes ORDER BY subscription_id,position`;
      const nodes = (await loadNodes(tx)).map((item) => item.node);
      const byId = new Map(nodes.map((node) => [node.instanceId, node]));
      return {
        nodes,
        subscriptions: subscriptions.map((item) => ({
          id: item.id,
          name: item.name,
          displayName: item.display_name,
          enabled: item.enabled,
          encrypted: item.encrypted,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
          nodes: members
            .filter((m) => m.subscription_id === item.id)
            .map((member) => ({
              ...(byId.get(member.instance_id) ?? {
                instanceId: null,
                name: member.name,
                serverName: "",
                kind: null,
                address: null,
                port: null,
                reason: "入口已删除",
              }),
              displayName: member.display_name,
            })),
        })),
      };
    });
    return json(result);
  }
  if (!path.length && method === "POST") {
    const input = await body(request, subscriptionInput, 524288);
    const id = randomUUID(),
      raw = token();
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(741829006)`;
      const [count] = await tx`SELECT count(*)::int AS n FROM proxy_subscriptions`;
      if (count.n >= 200) throw new HttpError(409, "已达到 200 个订阅上限");
      await tx`INSERT INTO proxy_subscriptions(id,name,display_name,enabled,token_hash,encrypted_token,encrypted_password)
        VALUES(${id},${input.name},${input.displayName ?? null},${input.enabled},${hash(raw)},${encrypt(raw)},${encrypt(input.encryptionPassword)})`;
      await replaceNodes(tx, id, input.nodeIds);
      if (input.nodeDisplayNames) await updateNodeDisplayNames(tx, id, input.nodeDisplayNames);
    });
    await audit(user.id, "proxy.subscription.created", id);
    return json(
      {
        id,
        url: link(raw),
        encryptionPassword: input.encryptionPassword,
        displayName: input.displayName || input.name,
      },
      201,
    );
  }
  if (path.length === 1 && method === "PATCH") {
    const id = z.uuid().parse(path[0]);
    const input = await body(request, subscriptionUpdate, 524288);
    await sql.begin(async (tx) => {
      const [old] =
        await tx`SELECT name,display_name,enabled,encrypted_password FROM proxy_subscriptions WHERE id=${id} FOR UPDATE`;
      if (!old) throw new HttpError(404, "订阅不存在");
      const password =
        input.encryptionPassword === undefined
          ? old.encrypted_password
          : encrypt(input.encryptionPassword);
      const displayName = input.displayName === undefined ? old.display_name : input.displayName;
      await tx`UPDATE proxy_subscriptions SET name=${input.name ?? old.name},display_name=${displayName},enabled=${input.enabled ?? old.enabled},encrypted_password=${password},updated_at=now() WHERE id=${id}`;
      if (input.nodeIds) await replaceNodes(tx, id, input.nodeIds);
      if (input.nodeDisplayNames) await updateNodeDisplayNames(tx, id, input.nodeDisplayNames);
    });
    await audit(user.id, "proxy.subscription.updated", id);
    return json({ ok: true });
  }
  if (path.length === 1 && method === "DELETE") {
    const id = z.uuid().parse(path[0]);
    const rows = await sql`DELETE FROM proxy_subscriptions WHERE id=${id} RETURNING id`;
    if (!rows.length) throw new HttpError(404, "订阅不存在");
    await audit(user.id, "proxy.subscription.deleted", id);
    return json({ ok: true });
  }
  if (path.length === 2 && method === "POST" && ["link", "rotate"].includes(path[1])) {
    const id = z.uuid().parse(path[0]);
    if (path[1] === "rotate") {
      const raw = token();
      const rows =
        await sql`UPDATE proxy_subscriptions SET token_hash=${hash(raw)},encrypted_token=${encrypt(raw)},updated_at=now() WHERE id=${id} RETURNING encrypted_password,name,display_name`;
      if (!rows.length) throw new HttpError(404, "订阅不存在");
      await audit(user.id, "proxy.subscription.rotated", id);
      return json({
        url: link(raw),
        encryptionPassword: decrypt(rows[0].encrypted_password),
        displayName: rows[0].display_name || rows[0].name,
      });
    }
    const [row] =
      await sql`SELECT encrypted_token,encrypted_password,name,display_name FROM proxy_subscriptions WHERE id=${id}`;
    if (!row) throw new HttpError(404, "订阅不存在");
    await audit(user.id, "proxy.subscription.link.viewed", id);
    return json({
      url: link(decrypt(row.encrypted_token)),
      encryptionPassword: decrypt(row.encrypted_password),
      displayName: row.display_name || row.name,
    });
  }
  throw new HttpError(404, "订阅接口不存在");
}

export async function subscriptionResponse(request: Request, raw: string) {
  try {
    await rateLimit(`subscription:ip:${clientIp(request.headers)}`, 120, 60);
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new HttpError(404, "订阅不存在或已停用");
    const [subscription] =
      await sql`SELECT id,name,display_name,encrypted_password FROM proxy_subscriptions WHERE token_hash=${hash(raw)} AND enabled`;
    if (!subscription) throw new HttpError(404, "订阅不存在或已停用");
    const members = await sql<{ instance_id: string; display_name: string | null }[]>`
      SELECT instance_id,display_name FROM proxy_subscription_nodes WHERE subscription_id=${subscription.id}
      AND instance_id IS NOT NULL ORDER BY position`;
    const ids = members.map((m) => m.instance_id);
    const displayNames = new Map(members.map((m) => [m.instance_id, m.display_name]));
    const nodes = ids.length ? await loadNodes(sql, ids, displayNames) : [];
    const byId = new Map(nodes.map((item) => [item.node.instanceId, item.uri]));
    const uris = ids.map((id) => byId.get(id)).filter((uri): uri is string => !!uri);
    // Avoid replacing a client's usable list with an empty list during a deployment.
    if (!uris.length)
      return new Response("暂无可用订阅节点，请稍后更新", {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": "300",
          "X-Content-Type-Options": "nosniff",
        },
      });
    const plaintext = uris.join("\n");
    const payload = encryptSubscription(plaintext, decrypt(subscription.encrypted_password));
    return new Response(payload, {
      headers: {
        "subscription-encryption": "true",
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "profile-title": `base64:${Buffer.from(subscription.display_name || subscription.name, "utf8").toString("base64")}`,
        "profile-update-interval": "12",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
