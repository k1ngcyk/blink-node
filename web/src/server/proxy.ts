import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import { sql } from "../db";
import { audit, elevated, type owner } from "./auth";
import { body, HttpError, json } from "./http";
import { encrypt, decrypt } from "./crypto";
import { cloudflare, ensureDns } from "./cloudflare";
import {
  credentials,
  hostInput,
  hostname,
  instanceInput,
  redact,
  referencedExits,
  type ProxySpec,
} from "./proxy-model";
import { validateTarget } from "./network";
import { proxyResult, proxyStatus } from "./proxy-model";

type DB = typeof sql | TransactionSql;
type User = Awaited<ReturnType<typeof owner>>;
type Instance = {
  id: string;
  server_id: string;
  spec: ProxySpec;
  encrypted_credentials: string;
  state: string;
};
const uuid = z.uuid();
const settingsInput = z.object({
  token: z.string().trim().min(20).max(256).optional(),
  zoneId: z.string().regex(/^[a-f0-9]{32}$/),
  zoneName: hostname,
  acmeEmail: z.email().max(254),
});
async function available(tx: DB, id: string) {
  const [s] = await tx`SELECT * FROM servers WHERE id=${id} AND revoked=false`;
  if (!s) throw new HttpError(404, "服务器不存在");
  if (!s.info.proxy)
    throw new HttpError(409, "节点需要安装新版 Agent 和代理部署器（enable-proxy.sh）");
  if (!s.last_seen || Date.now() - new Date(s.last_seen).getTime() > 45000)
    throw new HttpError(409, "节点离线");
}
async function idle(tx: DB, ids: string[]) {
  if (
    (
      await tx`SELECT id FROM proxy_jobs WHERE server_id IN ${tx(ids)} AND state IN ('queued','running')`
    ).length
  )
    throw new HttpError(409, "相关节点有任务正在执行，请完成后重试");
}
async function payload(tx: DB, serverId: string) {
  const all = await tx<Instance[]>`SELECT * FROM proxy_instances WHERE state<>'deleting'`;
  const hosts = await tx`SELECT * FROM proxy_hosts`;
  const [settings] = await tx`SELECT acme_email FROM proxy_settings WHERE id=1`;
  const host = hosts.find((h) => h.server_id === serverId);
  const local = all.filter((i) => i.server_id === serverId && i.spec.enabled);
  if (!host || (local.length && !host.addresses.length))
    throw new HttpError(400, "先保存节点公网 IP 与防火墙设置");
  const instances = local.map((i) => ({
    ...i.spec,
    id: i.id,
    credentials: JSON.parse(decrypt(i.encrypted_credentials)),
    sources: [
      ...new Set(
        all
          .filter((other) => other.spec.enabled && referencedExits(other.spec).includes(i.id))
          .flatMap((other) => hosts.find((h) => h.server_id === other.server_id)?.addresses ?? []),
      ),
    ],
    exits: referencedExits(i.spec).map((id) => {
      const exit = all.find(
        (other) => other.id === id && other.spec.kind === "shadowsocks2022" && other.spec.enabled,
      );
      const exitHost = hosts.find((h) => h.server_id === exit?.server_id);
      if (!exit || !exitHost?.addresses.length)
        throw new HttpError(409, "SS2022 出口不存在或未配置公网地址");
      return {
        id,
        address: exitHost.addresses[0],
        port: exit.spec.port,
        udp: exit.spec.udp,
        ...JSON.parse(decrypt(exit.encrypted_credentials)),
      };
    }),
  }));
  return {
    instances,
    addresses: host.addresses,
    firewall: host.firewall,
    email: settings.acme_email,
  };
}
async function enqueue(
  tx: DB,
  serverId: string,
  userId: string | null,
  operation: "scan" | "apply",
  dependencies: string[] = [],
) {
  await tx`INSERT INTO proxy_hosts(server_id) VALUES(${serverId}) ON CONFLICT DO NOTHING`;
  let version = 0,
    value: unknown = {};
  if (operation === "apply") {
    value = await payload(tx, serverId);
    const [h] =
      await tx`UPDATE proxy_hosts SET desired_version=desired_version+1 WHERE server_id=${serverId} RETURNING desired_version`;
    version = h.desired_version;
    if (Buffer.byteLength(JSON.stringify(value)) > 210000)
      throw new HttpError(400, "节点配置超过大小上限，请减少实例或分流规则");
    await tx`UPDATE proxy_instances SET state='pending',error=NULL WHERE server_id=${serverId} AND state<>'deleting'`;
  }
  const [job] =
    await tx`INSERT INTO proxy_jobs(server_id,user_id,operation,desired_version,encrypted_payload,depends_on) VALUES(${serverId},${userId},${operation},${version},${encrypt(JSON.stringify(value))},${dependencies}) RETURNING id`;
  return job.id as string;
}
export async function initialProxyScan(serverId: string) {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(741829005)`;
    await tx`INSERT INTO proxy_hosts(server_id) VALUES(${serverId}) ON CONFLICT DO NOTHING`;
    const [host] = await tx`SELECT scanned_at FROM proxy_hosts WHERE server_id=${serverId}`;
    if (
      !host.scanned_at &&
      !(
        await tx`SELECT id FROM proxy_jobs WHERE server_id=${serverId} AND state IN ('queued','running')`
      ).length
    )
      await enqueue(tx, serverId, null, "scan");
  });
}
export async function proxyApi(
  request: Request,
  path: string[],
  user: User,
  validateUpstream = validateTarget,
) {
  const method = request.method;
  if (method !== "GET") elevated(user);
  if (path[1] === "settings") {
    if (method === "GET") {
      const [s] =
        await sql`SELECT zone_id,zone_name,acme_email,encrypted_token IS NOT NULL AS configured FROM proxy_settings WHERE id=1`;
      return json(s);
    }
    if (method === "POST") {
      const input = await body(request, settingsInput);
      const [old] = await sql`SELECT encrypted_token FROM proxy_settings WHERE id=1`;
      const token = input.token ?? (old.encrypted_token ? decrypt(old.encrypted_token) : "");
      if (!token) throw new HttpError(400, "需要 Cloudflare API Token");
      const zone = await cloudflare<{ id: string; name: string; status: string }>(
        token,
        `/zones/${input.zoneId}`,
      );
      if (zone.name !== input.zoneName || zone.status !== "active")
        throw new HttpError(400, "Zone 域名不匹配或尚未激活");
      await cloudflare(token, `/zones/${zone.id}/dns_records?per_page=1`);
      await sql`UPDATE proxy_settings SET encrypted_token=${encrypt(token)},zone_id=${zone.id},zone_name=${zone.name},acme_email=${input.acmeEmail},updated_at=now() WHERE id=1`;
      await audit(user.id, "proxy.dns.settings", null);
      return json({ ok: true });
    }
  }
  if (path[1] === "zones" && method === "POST") {
    const input = await body(request, z.object({ token: z.string().min(20).max(256).optional() }));
    const [s] = await sql`SELECT encrypted_token FROM proxy_settings WHERE id=1`;
    const token = input.token ?? (s.encrypted_token ? decrypt(s.encrypted_token) : "");
    if (!token) throw new HttpError(400, "需要 Cloudflare API Token");
    return json(await cloudflare(token, "/zones?status=active&per_page=50"));
  }
  if (path[1] === "instances" && path.length === 2 && method === "GET")
    return json(
      await sql`SELECT p.id,p.server_id,p.name,p.kind,p.spec,p.state,p.error,p.updated_at,s.name AS server_name FROM proxy_instances p JOIN servers s ON s.id=p.server_id ORDER BY p.created_at`,
    );
  if (path[1] === "hosts" && path[2]) {
    const id = uuid.parse(path[2]);
    if (method === "GET") {
      const [host] =
        await sql`SELECT server_id,addresses,firewall,desired_version,applied_version,scanned_at,observed FROM proxy_hosts WHERE server_id=${id}`;
      const imports =
        await sql`SELECT id,source_key,summary,updated_at FROM proxy_imports WHERE server_id=${id} ORDER BY updated_at DESC`;
      const jobs =
        await sql`SELECT id,operation,desired_version,state,result,created_at FROM proxy_jobs WHERE server_id=${id} ORDER BY created_at DESC LIMIT 20`;
      return json({
        ...(host ?? { server_id: id, addresses: [], firewall: "existing" }),
        imports,
        jobs,
      });
    }
    if (method === "POST" && path[3] === "scan") {
      await available(sql, id);
      const job = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(741829005)`;
        await idle(tx, [id]);
        return enqueue(tx, id, user.id, "scan");
      });
      await audit(user.id, "proxy.scan", id);
      return json({ id: job }, 202);
    }
    if (method === "PATCH") {
      const input = await body(request, hostInput);
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(741829005)`;
        await available(tx, id);
        await idle(tx, [id]);
        const instances = await tx<
          Instance[]
        >`SELECT * FROM proxy_instances WHERE state<>'deleting'`;
        // Endpoint changes require reapplying all linked entrances; this operation
        // queues them with dependencies instead of leaving stale outbound addresses.
        const own = instances.filter((i) => i.server_id === id).map((i) => i.id);
        const localExitIds = instances
          .filter((i) => i.server_id === id)
          .flatMap((i) => referencedExits(i.spec));
        const affected = [
          ...new Set(
            instances
              .filter(
                (i) =>
                  localExitIds.includes(i.id) ||
                  referencedExits(i.spec).some((e) => own.includes(e)),
              )
              .map((i) => i.server_id),
          ),
        ].filter((v) => v !== id);
        if (affected.length) await idle(tx, affected);
        await tx`INSERT INTO proxy_hosts(server_id,addresses,firewall) VALUES(${id},${input.addresses},${input.firewall}) ON CONFLICT(server_id) DO UPDATE SET addresses=excluded.addresses,firewall=excluded.firewall`;
        const local = instances.filter((i) => i.server_id === id);
        for (const i of local)
          if (i.spec.domain && i.spec.manageDns)
            await ensureDns(id, i.spec.domain, input.addresses);
        if (local.length) {
          const dependencies: string[] = [];
          const exitServers = [
            ...new Set(
              instances.filter((i) => localExitIds.includes(i.id)).map((i) => i.server_id),
            ),
          ].filter((v) => v !== id);
          for (const server of exitServers) {
            await available(tx, server);
            dependencies.push(await enqueue(tx, server, user.id, "apply"));
          }
          const job = await enqueue(tx, id, user.id, "apply", dependencies);
          for (const server of affected.filter((v) => !exitServers.includes(v))) {
            await available(tx, server);
            await enqueue(tx, server, user.id, "apply", [job]);
          }
        }
      });
      await audit(user.id, "proxy.host.updated", id);
      return json({ ok: true });
    }
    if (method === "POST" && path[3] === "apply") {
      const job = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(741829005)`;
        await available(tx, id);
        await idle(tx, [id]);
        const instances = await tx<Instance[]>`SELECT * FROM proxy_instances`;
        const exitIds = instances
          .filter((i) => i.server_id === id)
          .flatMap((i) => referencedExits(i.spec));
        const exitServers = [
          ...new Set(instances.filter((i) => exitIds.includes(i.id)).map((i) => i.server_id)),
        ].filter((v) => v !== id);
        const dependencies: string[] = [];
        if (exitServers.length) await idle(tx, exitServers);
        for (const server of exitServers) {
          await available(tx, server);
          dependencies.push(await enqueue(tx, server, user.id, "apply"));
        }
        const [host] = await tx`SELECT addresses FROM proxy_hosts WHERE server_id=${id}`;
        for (const i of instances.filter((i) => i.server_id === id && i.state !== "deleting"))
          if (i.spec.domain && i.spec.manageDns) await ensureDns(id, i.spec.domain, host.addresses);
        return enqueue(tx, id, user.id, "apply", dependencies);
      });
      await audit(user.id, "proxy.reapply", id);
      return json({ id: job }, 202);
    }
  }
  if (path[1] === "instances" && (method === "POST" || method === "PATCH" || method === "DELETE")) {
    if (path[3] === "credentials" && method === "POST") {
      const id = uuid.parse(path[2]);
      const [instance] =
        await sql`SELECT encrypted_credentials FROM proxy_instances WHERE id=${id}`;
      if (!instance) throw new HttpError(404, "实例不存在");
      const value = JSON.parse(decrypt(instance.encrypted_credentials));
      delete value.privateKey;
      await audit(user.id, "proxy.credentials.viewed", id);
      return json(value);
    }
    const id = path[2] ? uuid.parse(path[2]) : randomUUID();
    const input = method === "DELETE" ? null : await body(request, instanceInput);
    if (input?.kind === "reality") {
      try {
        await validateUpstream("http", input.upstream);
      } catch {
        throw new HttpError(400, "伪装上游必须解析到有效公网地址");
      }
    }
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(741829005)`;
      const all = await tx<Instance[]>`SELECT * FROM proxy_instances`;
      const old = all.find((i) => i.id === id);
      if (path[2] && !old) throw new HttpError(404, "实例不存在");
      if (old && input && (input.serverId !== old.server_id || input.kind !== old.spec.kind))
        throw new HttpError(400, "实例所属服务器和协议不能更改");
      const serverId = input?.serverId ?? old!.server_id;
      await available(tx, serverId);
      await idle(tx, [serverId]);
      const references = all.filter(
        (i) => i.id !== id && i.spec.enabled && referencedExits(i.spec).includes(id),
      );
      if (references.length && (!input || !input.enabled || input.port !== old!.spec.port))
        throw new HttpError(409, "出口正在被链路引用，请先调整入口规则");
      const exitIds = [
        ...new Set([
          ...(old ? referencedExits(old.spec) : []),
          ...(input ? referencedExits(input) : []),
        ]),
      ];
      const exits = exitIds.map((exitId) => {
        const exit = all.find(
          (i) =>
            i.id === exitId &&
            i.spec.kind === "shadowsocks2022" &&
            i.spec.enabled &&
            i.state !== "deleting",
        );
        if (!exit || exit.server_id === serverId)
          throw new HttpError(409, "请选择其他服务器上已部署成功的 SS2022 出口");
        return exit;
      });
      const affectedExits = [...new Set(exits.map((e) => e.server_id))];
      await idle(tx, [serverId, ...affectedExits]);
      for (const exitServer of affectedExits) await available(tx, exitServer);
      if (input) {
        const [host] = await tx`SELECT * FROM proxy_hosts WHERE server_id=${serverId}`;
        if (!host?.addresses.length) throw new HttpError(400, "先配置节点公网 IP");
        const collisions = all.filter(
          (i) =>
            i.server_id === serverId && i.id !== id && i.spec.enabled && i.state !== "deleting",
        );
        if (
          input.enabled &&
          collisions.some(
            (i) =>
              i.spec.port === input.port ||
              (i.spec.kind === "reality" && i.spec.fallbackPort === input.port) ||
              (input.kind === "reality" &&
                (input.fallbackPort === i.spec.port ||
                  (i.spec.kind === "reality" && input.fallbackPort === i.spec.fallbackPort))),
          )
        )
          throw new HttpError(409, "代理监听端口冲突");
        if (
          input.domain &&
          all.some((i) => i.server_id !== serverId && i.spec.domain === input.domain)
        )
          throw new HttpError(409, "该域名已分配给其他节点");
        const [settings] = await tx`SELECT acme_email FROM proxy_settings WHERE id=1`;
        if (input.kind !== "shadowsocks2022" && !settings.acme_email)
          throw new HttpError(400, "先在 DNS 设置中配置 ACME 邮箱");
        if (input.domain && input.manageDns)
          await ensureDns(serverId, input.domain, host.addresses);
        if (old)
          await tx`UPDATE proxy_instances SET name=${input.name},spec=${tx.json(input)},updated_at=now() WHERE id=${id}`;
        else
          await tx`INSERT INTO proxy_instances(id,server_id,name,kind,spec,encrypted_credentials) VALUES(${id},${serverId},${input.name},${input.kind},${tx.json(input)},${encrypt(JSON.stringify(credentials(input.kind)))})`;
      } else await tx`UPDATE proxy_instances SET state='deleting',updated_at=now() WHERE id=${id}`;
      const dependencies: string[] = [];
      for (const exitServer of affectedExits)
        dependencies.push(await enqueue(tx, exitServer, user.id, "apply"));
      await enqueue(tx, serverId, user.id, "apply", dependencies);
    });
    await audit(user.id, method === "DELETE" ? "proxy.deleted" : "proxy.configured", id);
    return json({ id }, 202);
  }
  if (path[1] === "imports" && path[2] && method === "GET") {
    const [item] =
      await sql`SELECT summary,encrypted_snapshot FROM proxy_imports WHERE id=${uuid.parse(path[2])}`;
    if (!item) throw new HttpError(404, "导入记录不存在");
    return json({
      summary: item.summary,
      configuration: redact(JSON.parse(decrypt(item.encrypted_snapshot))),
    });
  }
  throw new HttpError(404, "代理接口不存在");
}

async function saveProxyStatus(tx: DB, serverId: string, value: unknown) {
  const status = proxyStatus.parse(value);
  const addresses = status.network?.addresses.map((item) => item.address) ?? [];
  // Seed only an empty host. Later observations never change saved DNS/ACL inputs.
  await tx`UPDATE proxy_hosts SET observed=${tx.json(status)},addresses=CASE WHEN cardinality(addresses)=0 THEN ${addresses}::text[] ELSE addresses END WHERE server_id=${serverId}`;
}
export async function receiveProxyStatus(serverId: string, value: unknown) {
  await saveProxyStatus(sql, serverId, value);
}
export async function receiveProxyResult(serverId: string, message: z.infer<typeof proxyResult>) {
  const serialized = JSON.stringify(message.result);
  if (serialized.length > 220000) throw new Error("Proxy result too large");
  await sql.begin(async (tx) => {
    const [job] =
      await tx`SELECT * FROM proxy_jobs WHERE id=${message.taskId} AND server_id=${serverId} AND desired_version=${message.desiredVersion} AND state='running' FOR UPDATE`;
    if (!job) return;
    const error =
      typeof message.result.error === "string"
        ? message.result.error.slice(0, 500)
        : "节点任务失败";
    const summary = message.ok
      ? {
          message: job.operation === "scan" ? "扫描完成" : "部署完成",
          warnings: z
            .array(z.string().max(500))
            .max(100)
            .parse(message.result.warnings ?? []),
        }
      : { error };
    await tx`UPDATE proxy_jobs SET state=${message.ok ? "done" : "failed"},result=${tx.json(summary)} WHERE id=${job.id}`;
    if (job.operation === "scan" && message.ok) {
      const discoveries = z
        .array(
          z.object({
            key: z.string().max(300),
            summary: z.record(z.string(), z.unknown()),
            configuration: z.unknown(),
          }),
        )
        .max(100)
        .parse(message.result.discoveries ?? []);
      await saveProxyStatus(tx, serverId, message.result.status ?? {});
      await tx`UPDATE proxy_hosts SET scanned_at=now(),encrypted_scan=${encrypt(serialized)} WHERE server_id=${serverId}`;
      for (const item of discoveries)
        await tx`INSERT INTO proxy_imports(server_id,source_key,summary,encrypted_snapshot) VALUES(${serverId},${item.key},${tx.json(item.summary as never)},${encrypt(JSON.stringify(item.configuration))}) ON CONFLICT(server_id,source_key) DO UPDATE SET summary=excluded.summary,encrypted_snapshot=excluded.encrypted_snapshot,updated_at=now()`;
    }
    if (job.operation === "apply") {
      if (message.ok) {
        await saveProxyStatus(tx, serverId, message.result.status ?? {});
        await tx`UPDATE proxy_hosts SET applied_version=${message.desiredVersion} WHERE server_id=${serverId}`;
        await tx`DELETE FROM proxy_instances WHERE server_id=${serverId} AND state='deleting'`;
      }
      await tx`UPDATE proxy_instances SET state=CASE WHEN ${message.ok} THEN CASE WHEN spec->>'enabled'='false' THEN 'disabled' ELSE 'active' END ELSE 'failed' END,error=${message.ok ? null : error} WHERE server_id=${serverId} AND state<>'deleting'`;
    }
  });
}
export async function dispatchProxy(send: (id: string, message: unknown) => boolean) {
  await sql`UPDATE proxy_jobs SET state='failed',result='{"error":"任务已过期，请重新扫描或应用配置"}'::jsonb WHERE state IN ('queued','running') AND expires_at<now()`;
  await sql`UPDATE proxy_jobs j SET state='failed',result='{"error":"关联出口部署失败，请重新应用配置"}'::jsonb WHERE j.state='queued' AND EXISTS(SELECT 1 FROM proxy_jobs d WHERE d.id=ANY(j.depends_on) AND d.state='failed')`;
  const jobs =
    await sql`SELECT * FROM proxy_jobs j WHERE j.state IN ('queued','running') AND (j.sent_at IS NULL OR j.sent_at<now()-interval '45 seconds') AND NOT EXISTS(SELECT 1 FROM proxy_jobs d WHERE d.id=ANY(j.depends_on) AND d.state<>'done') ORDER BY created_at LIMIT 20`;
  for (const job of jobs) {
    const message = {
      v: 1,
      type: "proxy.run",
      taskId: job.id,
      resourceId: job.server_id,
      desiredVersion: job.desired_version,
      deadline: job.expires_at.toISOString(),
      operation: job.operation,
      payload: JSON.parse(decrypt(job.encrypted_payload)),
    };
    // Set running before dispatch so a fast loopback agent cannot race the update.
    await sql`UPDATE proxy_jobs SET state='running',sent_at=now(),attempts=attempts+1 WHERE id=${job.id}`;
    if (!send(job.server_id, message))
      await sql`UPDATE proxy_jobs SET sent_at=NULL,state='queued' WHERE id=${job.id}`;
  }
  await sql`UPDATE proxy_instances p SET state='failed',error='部署任务失败，请检查节点任务记录' WHERE p.state='pending' AND EXISTS(SELECT 1 FROM proxy_jobs j JOIN proxy_hosts h ON h.server_id=j.server_id AND h.desired_version=j.desired_version WHERE j.server_id=p.server_id AND j.operation='apply' AND j.state='failed')`;
}
