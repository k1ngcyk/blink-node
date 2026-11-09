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
import { importedExitCandidates } from "./proxy-imports";

type DB = typeof sql | TransactionSql;
type User = Awaited<ReturnType<typeof owner>>;
type Instance = {
  id: string;
  server_id: string;
  spec: ProxySpec;
  encrypted_credentials: string;
  state: string;
};
type ExternalExit = {
  id: string;
  server_id: string;
  import_id: string;
  candidate_key: string;
  name: string;
  port: number;
  method: string;
  udp: boolean;
  encrypted_credentials: string;
  fingerprint: string;
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
  const external = await tx<
    ExternalExit[]
  >`SELECT e.* FROM proxy_external_exits e JOIN servers s ON s.id=e.server_id WHERE NOT s.revoked`;
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
      const imported = external.find((exit) => exit.id === id);
      if (imported) {
        const address = hosts.find((h) => h.server_id === imported.server_id)?.addresses[0];
        if (imported.state !== "active" || !address || imported.server_id === serverId)
          throw new HttpError(409, "已有服务出口不可用，请检查节点地址并刷新扫描");
        return {
          id,
          address,
          port: imported.port,
          udp: imported.udp,
          ...JSON.parse(decrypt(imported.encrypted_credentials)),
        };
      }
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
  operation: "scan" | "apply" | "firewall",
  dependencies: string[] = [],
  retainExisting = false,
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
  if (operation === "firewall") {
    const exits = await tx<
      ExternalExit[]
    >`SELECT * FROM proxy_external_exits WHERE server_id=${serverId}`;
    const instances = await tx<
      Instance[]
    >`SELECT * FROM proxy_instances WHERE state<>'deleting' AND spec->>'enabled'='true'`;
    const hosts = await tx`SELECT server_id,addresses FROM proxy_hosts`;
    const [host] =
      await tx`UPDATE proxy_hosts SET firewall_desired_version=firewall_desired_version+1 WHERE server_id=${serverId} RETURNING firewall_desired_version,firewall`;
    version = host.firewall_desired_version;
    value = {
      firewall: host.firewall,
      retainExisting,
      exits: exits.map((exit) => ({
        id: exit.id,
        port: exit.port,
        udp: exit.udp,
        sources: [
          ...new Set(
            instances
              .filter((i) => referencedExits(i.spec).includes(exit.id))
              .flatMap((i) => hosts.find((h) => h.server_id === i.server_id)?.addresses ?? []),
          ),
        ],
      })),
    };
    if (Buffer.byteLength(JSON.stringify(value)) > 210000)
      throw new HttpError(400, "出口防火墙规则超过大小上限");
  }
  const [job] =
    await tx`INSERT INTO proxy_jobs(server_id,user_id,operation,desired_version,encrypted_payload,depends_on) VALUES(${serverId},${userId},${operation},${version},${encrypt(JSON.stringify(value))},${dependencies}) RETURNING id`;
  return job.id as string;
}

async function withExternalFirewall(
  tx: TransactionSql,
  serverIds: string[],
  userId: string,
  apply: (dependencies: string[]) => Promise<string[]>,
) {
  const servers = [...new Set(serverIds)];
  if (servers.length) await idle(tx, servers);
  for (const server of servers) {
    await available(tx, server);
    const [host] = await tx`SELECT observed FROM proxy_hosts WHERE server_id=${server}`;
    if (!host?.observed.externalFirewall)
      throw new HttpError(409, "已有出口节点需要更新 Agent 和部署器，以支持 UFW 自动同步");
  }
  // Open new source addresses first, then remove obsolete ones only after all
  // entrance deployments succeed. Failed deployments retain the working ACL.
  const dependencies: string[] = [];
  for (const server of servers)
    dependencies.push(await enqueue(tx, server, userId, "firewall", [], true));
  const jobs = await apply(dependencies);
  const cleanups: string[] = [];
  for (const server of servers)
    cleanups.push(await enqueue(tx, server, userId, "firewall", [...dependencies, ...jobs]));
  return jobs.length ? jobs : cleanups;
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
  if (path[1] === "exits" && path.length === 2 && method === "GET") {
    const managed =
      await sql`SELECT p.id,p.server_id,p.name,p.state,s.name AS server_name,p.spec->>'port' AS port,h.addresses FROM proxy_instances p JOIN servers s ON s.id=p.server_id LEFT JOIN proxy_hosts h ON h.server_id=s.id WHERE p.kind='shadowsocks2022' AND p.spec->>'enabled'='true' AND p.state<>'deleting' AND NOT s.revoked ORDER BY p.created_at`;
    const imported =
      await sql`SELECT e.id,e.server_id,e.name,e.state,e.port,e.method,s.name AS server_name,h.addresses FROM proxy_external_exits e JOIN servers s ON s.id=e.server_id LEFT JOIN proxy_hosts h ON h.server_id=s.id WHERE NOT s.revoked ORDER BY e.created_at`;
    return json([
      ...managed.map((item) => ({
        ...item,
        port: Number(item.port),
        source: "managed",
        method: "2022-blake3-aes-256-gcm",
        state: item.addresses?.length ? item.state : "missing_address",
      })),
      ...imported.map((item) => ({
        ...item,
        source: "imported",
        state: item.addresses?.length ? item.state : "missing_address",
      })),
    ]);
  }
  if (path[1] === "exits" && path[2] && method === "DELETE") {
    const id = uuid.parse(path[2]);
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(741829005)`;
      const all = await tx<Instance[]>`SELECT * FROM proxy_instances`;
      if (all.some((item) => referencedExits(item.spec).includes(id)))
        throw new HttpError(409, "出口正在被链路引用，请先调整入口规则");
      const removed = await tx`DELETE FROM proxy_external_exits WHERE id=${id} RETURNING server_id`;
      if (removed.length)
        await withExternalFirewall(tx, [removed[0].server_id], user.id, async () => []);
    });
    await audit(user.id, "proxy.exit.removed", id);
    return json({ ok: true });
  }
  if (path[1] === "hosts" && path[2]) {
    const id = uuid.parse(path[2]);
    if (method === "GET") {
      const [host] =
        await sql`SELECT server_id,addresses,firewall,desired_version,applied_version,firewall_desired_version,firewall_applied_version,scanned_at,observed FROM proxy_hosts WHERE server_id=${id}`;
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
        const external = await tx<ExternalExit[]>`SELECT * FROM proxy_external_exits`;
        const own = [
          ...instances.filter((i) => i.server_id === id).map((i) => i.id),
          ...external.filter((i) => i.server_id === id).map((i) => i.id),
        ];
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
        const relatedExitIds = instances
          .filter((i) => [id, ...affected].includes(i.server_id))
          .flatMap((i) => referencedExits(i.spec));
        const firewallServers = external
          .filter((e) => e.server_id === id || relatedExitIds.includes(e.id))
          .map((e) => e.server_id);
        await withExternalFirewall(tx, firewallServers, user.id, async (firewallDependencies) => {
          const downstreamDependencies: string[] = [...firewallDependencies];
          const jobs: string[] = [];
          let exitServers: string[] = [];
          if (local.length) {
            const dependencies: string[] = [...firewallDependencies];
            exitServers = [
              ...new Set(
                instances.filter((i) => localExitIds.includes(i.id)).map((i) => i.server_id),
              ),
            ].filter((v) => v !== id);
            for (const server of exitServers) {
              await available(tx, server);
              const job = await enqueue(tx, server, user.id, "apply", firewallDependencies);
              dependencies.push(job);
              jobs.push(job);
            }
            const job = await enqueue(tx, id, user.id, "apply", dependencies);
            downstreamDependencies.push(job);
            jobs.push(job);
          }
          for (const server of affected.filter((v) => !exitServers.includes(v))) {
            await available(tx, server);
            jobs.push(await enqueue(tx, server, user.id, "apply", downstreamDependencies));
          }
          return jobs;
        });
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
        const external = await tx<ExternalExit[]>`SELECT * FROM proxy_external_exits`;
        const firewallServers = external
          .filter((e) => e.server_id === id || exitIds.includes(e.id))
          .map((e) => e.server_id);
        if (exitServers.length) await idle(tx, exitServers);
        const [job] = await withExternalFirewall(
          tx,
          firewallServers,
          user.id,
          async (firewallDependencies) => {
            const dependencies = [...firewallDependencies];
            for (const server of exitServers) {
              await available(tx, server);
              dependencies.push(await enqueue(tx, server, user.id, "apply", firewallDependencies));
            }
            const [host] = await tx`SELECT addresses FROM proxy_hosts WHERE server_id=${id}`;
            for (const i of instances.filter((i) => i.server_id === id && i.state !== "deleting"))
              if (i.spec.domain && i.spec.manageDns)
                await ensureDns(id, i.spec.domain, host.addresses);
            return instances.some((i) => i.server_id === id) || !firewallServers.length
              ? [await enqueue(tx, id, user.id, "apply", dependencies)]
              : [];
          },
        );
        return job;
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
      const external = await tx<
        ExternalExit[]
      >`SELECT e.* FROM proxy_external_exits e JOIN servers s ON s.id=e.server_id WHERE NOT s.revoked`;
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
      const requiredExits = new Set(input?.enabled ? referencedExits(input) : []);
      const exits = exitIds.flatMap((exitId) => {
        const imported = external.find((item) => item.id === exitId);
        if (imported) {
          if (
            requiredExits.has(exitId) &&
            (imported.state !== "active" || imported.server_id === serverId)
          )
            throw new HttpError(409, "请选择其他服务器上可用的已有服务出口");
          return [];
        }
        const exit = all.find(
          (i) =>
            i.id === exitId &&
            i.spec.kind === "shadowsocks2022" &&
            i.spec.enabled &&
            i.state !== "deleting",
        );
        if ((!exit || exit.server_id === serverId) && requiredExits.has(exitId))
          throw new HttpError(409, "请选择其他服务器上已部署成功的 SS2022 出口");
        return exit && exit.server_id !== serverId ? [exit] : [];
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
      const firewallServers = external
        .filter((e) => exitIds.includes(e.id))
        .map((e) => e.server_id);
      await withExternalFirewall(tx, firewallServers, user.id, async (firewallDependencies) => {
        const dependencies = [...firewallDependencies];
        for (const exitServer of affectedExits)
          dependencies.push(await enqueue(tx, exitServer, user.id, "apply", firewallDependencies));
        return [await enqueue(tx, serverId, user.id, "apply", dependencies)];
      });
    });
    await audit(user.id, method === "DELETE" ? "proxy.deleted" : "proxy.configured", id);
    return json({ id }, 202);
  }
  if (path[1] === "imports" && path[2] && path[3] === "exits") {
    const importId = uuid.parse(path[2]);
    if (method === "GET") {
      const [item] = await sql`SELECT * FROM proxy_imports WHERE id=${importId}`;
      if (!item) throw new HttpError(404, "导入记录不存在");
      const existing =
        await sql`SELECT id,candidate_key,name,state FROM proxy_external_exits WHERE import_id=${importId}`;
      return json(
        importedExitCandidates(
          item.summary.engine,
          JSON.parse(decrypt(item.encrypted_snapshot)),
        ).map((candidate) => ({
          key: candidate.key,
          label: candidate.label,
          port: candidate.port,
          method: candidate.method,
          udp: candidate.udp,
          reason: item.summary.managed
            ? "面板管理的服务已直接提供出口选项"
            : !item.summary.active
              ? "服务未运行，请启动后刷新节点扫描"
              : candidate.reason,
          existing: existing.find((exit) => exit.candidate_key === candidate.key) ?? null,
        })),
      );
    }
    if (method === "POST") {
      const input = await body(
        request,
        z.object({
          candidateKey: z.string().regex(/^\d+:(?:-1|\d+)$/),
          name: z.string().trim().min(1).max(100),
        }),
      );
      const id = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(741829005)`;
        const [item] = await tx`SELECT * FROM proxy_imports WHERE id=${importId}`;
        if (!item) throw new HttpError(404, "导入记录不存在");
        await available(tx, item.server_id);
        await idle(tx, [item.server_id]);
        if (item.summary.managed || !item.summary.active)
          throw new HttpError(409, "请选择扫描到的运行中外部服务");
        const [host] =
          await tx`SELECT addresses FROM proxy_hosts WHERE server_id=${item.server_id}`;
        if (!host?.addresses.length) throw new HttpError(400, "先保存出口节点的公网 IP");
        const candidate = importedExitCandidates(
          item.summary.engine,
          JSON.parse(decrypt(item.encrypted_snapshot)),
        ).find((c) => c.key === input.candidateKey);
        if (!candidate || candidate.reason)
          throw new HttpError(400, candidate?.reason || "扫描配置中没有此出口");
        const [old] = await tx<
          ExternalExit[]
        >`SELECT * FROM proxy_external_exits WHERE import_id=${importId} AND candidate_key=${candidate.key}`;
        if (old && old.fingerprint !== candidate.fingerprint) {
          const instances = await tx<Instance[]>`SELECT * FROM proxy_instances`;
          if (instances.some((i) => referencedExits(i.spec).includes(old.id)))
            throw new HttpError(409, "出口配置已变化，请先移除入口引用再重新添加");
        }
        const secret = encrypt(
          JSON.stringify({ method: candidate.method, password: candidate.password }),
        );
        const [exit] =
          await tx`INSERT INTO proxy_external_exits(server_id,import_id,candidate_key,name,port,method,udp,encrypted_credentials,fingerprint) VALUES(${item.server_id},${importId},${candidate.key},${input.name},${candidate.port},${candidate.method},${candidate.udp},${secret},${candidate.fingerprint}) ON CONFLICT(import_id,candidate_key) DO UPDATE SET name=excluded.name,port=excluded.port,method=excluded.method,udp=excluded.udp,encrypted_credentials=excluded.encrypted_credentials,fingerprint=excluded.fingerprint,state='active' RETURNING id`;
        return exit.id;
      });
      await audit(user.id, "proxy.exit.imported", id);
      return json({ id });
    }
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
          message:
            job.operation === "scan"
              ? "扫描完成"
              : job.operation === "firewall"
                ? "出口防火墙同步完成"
                : "部署完成",
          warnings: z
            .array(z.string().max(500))
            .max(100)
            .parse(message.result.warnings ?? []),
        }
      : { error };
    await tx`UPDATE proxy_jobs SET state=${message.ok ? "done" : "failed"},result=${tx.json(summary)} WHERE id=${job.id}`;
    if (job.operation === "firewall" && message.ok) {
      await saveProxyStatus(tx, serverId, message.result.status ?? {});
      await tx`UPDATE proxy_hosts SET firewall_applied_version=${message.desiredVersion} WHERE server_id=${serverId}`;
    }
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
      await tx`UPDATE proxy_imports SET summary=jsonb_set(summary,'{active}','false'::jsonb) WHERE server_id=${serverId}`;
      for (const item of discoveries)
        await tx`INSERT INTO proxy_imports(server_id,source_key,summary,encrypted_snapshot) VALUES(${serverId},${item.key},${tx.json(item.summary as never)},${encrypt(JSON.stringify(item.configuration))}) ON CONFLICT(server_id,source_key) DO UPDATE SET summary=excluded.summary,encrypted_snapshot=excluded.encrypted_snapshot,updated_at=now()`;
      const exits = await tx<
        ExternalExit[]
      >`SELECT * FROM proxy_external_exits WHERE server_id=${serverId}`;
      const imports = await tx`SELECT * FROM proxy_imports WHERE server_id=${serverId}`;
      for (const exit of exits) {
        const item = imports.find((item) => item.id === exit.import_id);
        const candidate =
          item?.summary.active && !item.summary.managed
            ? importedExitCandidates(
                item.summary.engine,
                JSON.parse(decrypt(item.encrypted_snapshot)),
              ).find((c) => c.key === exit.candidate_key)
            : undefined;
        const state =
          candidate && !candidate.reason && candidate.fingerprint === exit.fingerprint
            ? "active"
            : "stale";
        await tx`UPDATE proxy_external_exits SET state=${state} WHERE id=${exit.id}`;
      }
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
    await sql`SELECT * FROM proxy_jobs j WHERE j.state IN ('queued','running') AND (j.sent_at IS NULL OR j.sent_at<now()-interval '45 seconds') AND NOT EXISTS(SELECT 1 FROM proxy_jobs d WHERE d.id=ANY(j.depends_on) AND d.state<>'done') AND NOT EXISTS(SELECT 1 FROM proxy_jobs earlier WHERE earlier.server_id=j.server_id AND earlier.queue_seq<j.queue_seq AND earlier.state IN ('queued','running')) ORDER BY j.queue_seq LIMIT 20`;
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
