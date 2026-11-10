import { z } from "zod";
import { sql } from "@/db";
import { db } from "@/db";
import { servers as serversTable } from "@/db/schema";
import { owner, login, rateLimit, audit, sessionCookie, elevated } from "@/server/auth";
import { body, clientIp, failure, HttpError, json, sameOrigin } from "@/server/http";
import { token, hash, encrypt, decrypt, verifyTotp } from "@/server/crypto";
import { config } from "@/server/config";
import { checkInput, ruleInput, serverUpdate } from "@/server/protocol";
import { traffic } from "@/server/metrics";
import { validateTarget } from "@/server/network";
import { proxyApi } from "@/server/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const idSchema = z.uuid();
const loginSchema = z.object({
  username: z.string().min(1).max(32),
  password: z.string().min(1).max(256),
  code: z.string().regex(/^\d{6}$/),
});

async function handle(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    const method = request.method,
      route = path.join("/");
    const mutating = method !== "GET";
    if (mutating) sameOrigin(request.headers);
    if (route === "auth/login" && method === "POST") {
      const input = await body(request, loginSchema);
      const raw = await login(
        input.username,
        input.password,
        input.code,
        clientIp(request.headers),
      );
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(raw) });
    }
    const user = await owner(request.headers);
    await rateLimit(`api:${user.id}`, 1200, 60);
    if (path[0] === "proxy") return await proxyApi(request, path, user);
    if (route === "session" && method === "GET")
      return json({
        username: user.username,
        role: user.role,
        elevatedUntil: user.elevated_until,
        origin: config().origin,
      });
    if (route === "auth/logout" && method === "POST") {
      await sql`DELETE FROM sessions WHERE token_hash=${user.token_hash}`;
      await audit(user.id, "logout", null);
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
    }
    if (route === "auth/elevate" && method === "POST") {
      await rateLimit(`elevate:${user.id}`, 6, 300);
      const input = await body(request, z.object({ code: z.string().regex(/^\d{6}$/) }));
      const [u] = await sql`SELECT totp_secret FROM users WHERE id=${user.id}`;
      const step = verifyTotp(decrypt(u.totp_secret), input.code);
      if (step === null) throw new HttpError(401, "动态验证码不正确");
      await sql.begin(async (tx) => {
        if (
          !(
            await tx`UPDATE users SET last_totp_step=${step} WHERE id=${user.id} AND last_totp_step<${step} RETURNING id`
          ).length
        )
          throw new HttpError(401, "验证码已使用，请等待身份验证器显示下一组验证码");
        await tx`UPDATE sessions SET elevated_until=now()+interval '10 minutes' WHERE token_hash=${user.token_hash}`;
      });
      await audit(user.id, "session.elevated", null);
      return json({ ok: true });
    }
    if (route === "auth/revoke-sessions" && method === "POST") {
      elevated(user);
      await sql`DELETE FROM sessions WHERE user_id=${user.id} AND token_hash<>${user.token_hash}`;
      await audit(user.id, "sessions.revoked", null);
      return json({ ok: true });
    }
    if (route === "servers" && method === "GET") {
      const rows =
        await sql`SELECT s.id,s.name,s.group_name,s.tags,s.notes,s.revoked,s.info,s.last_seen,s.latest_at,s.latest-'cores'-'temperatures'-'disks'-'networks' AS latest,s.quota_bytes,s.billing_day,s.billing_interfaces,s.created_at,host(s.connection_ip) AS connection_ip,coalesce(h.addresses,'{}'::text[]) AS addresses FROM servers s LEFT JOIN proxy_hosts h ON h.server_id=s.id ORDER BY s.group_name,s.name`;
      return json(rows);
    }
    if (route === "servers" && method === "POST") {
      elevated(user);
      const input = await body(request, serverUpdate);
      const count = await sql`SELECT count(*)::int AS n FROM servers`;
      if (count[0].n >= 1000) throw new HttpError(409, "已达到 1000 台服务器上限");
      const [row] = await db.insert(serversTable).values(input).returning({ id: serversTable.id });
      const raw = token();
      await sql`INSERT INTO enrollments(token_hash,server_id,expires_at) VALUES(${hash(raw)},${row.id},now()+interval '15 minutes')`;
      await audit(user.id, "server.created", row.id);
      return json(
        { id: row.id, enrollmentToken: raw, expiresIn: 900, serverUrl: config().origin },
        201,
      );
    }
    if (path[0] === "servers" && path[1]) {
      const id = idSchema.parse(path[1]);
      const [server] =
        await sql`SELECT s.id,s.name,s.group_name,s.tags,s.notes,s.revoked,s.info,s.last_seen,s.latest_at,s.latest,s.quota_bytes,s.billing_day,s.billing_interfaces,s.created_at,host(s.connection_ip) AS connection_ip,coalesce(h.addresses,'{}'::text[]) AS addresses FROM servers s LEFT JOIN proxy_hosts h ON h.server_id=s.id WHERE s.id=${id}`;
      if (!server) throw new HttpError(404, "服务器不存在");
      if (path.length === 2 && method === "GET")
        return json({
          ...server,
          traffic: await traffic(id, server.billing_day, server.billing_interfaces),
        });
      if (path.length === 2 && method === "PATCH") {
        const x = await body(request, serverUpdate);
        await sql`UPDATE servers SET name=${x.name},group_name=${x.groupName},tags=${x.tags},notes=${x.notes},quota_bytes=${x.quotaBytes},billing_day=${x.billingDay},billing_interfaces=${x.billingInterfaces} WHERE id=${id}`;
        await audit(user.id, "server.updated", id);
        return json({ ok: true });
      }
      if (path[2] === "enrollment" && method === "POST") {
        elevated(user);
        const raw = token();
        await sql.begin(async (tx) => {
          await tx`DELETE FROM enrollments WHERE server_id=${id}`;
          await tx`UPDATE servers SET token_hash=NULL,revoked=false WHERE id=${id}`;
          await tx`INSERT INTO enrollments(token_hash,server_id,expires_at) VALUES(${hash(raw)},${id},now()+interval '15 minutes')`;
        });
        await audit(user.id, "server.credential.rotated", id);
        return json({ id, enrollmentToken: raw, expiresIn: 900, serverUrl: config().origin });
      }
      if (path[2] === "revoke" && method === "POST") {
        elevated(user);
        await sql.begin(async (tx) => {
          await tx`UPDATE servers SET revoked=true,token_hash=NULL WHERE id=${id}`;
          await tx`DELETE FROM enrollments WHERE server_id=${id}`;
          await tx`DELETE FROM terminal_tickets WHERE server_id=${id}`;
        });
        await audit(user.id, "server.revoked", id);
        return json({ ok: true });
      }
      if (path[2] === "history" && method === "GET") {
        const range = new URL(request.url).searchParams.get("range") ?? "1h";
        const ranges: Record<string, number> = {
          "1h": 3600,
          "24h": 86400,
          "7d": 604800,
          "30d": 2592000,
          "1y": 31536000,
        };
        const seconds = ranges[range];
        if (!seconds) throw new HttpError(400, "时间范围不正确");
        if (range === "1h")
          return json(
            await sql`SELECT collected_at AS at,data FROM metric_samples WHERE server_id=${id} AND collected_at>now()-${seconds}*interval '1 second' ORDER BY collected_at LIMIT 1200`,
          );
        const resolution = range === "24h" ? 60 : 3600;
        return json(
          await sql`SELECT bucket AS at,data,count FROM metric_rollups WHERE server_id=${id} AND resolution=${resolution} AND bucket>now()-${seconds}*interval '1 second' ORDER BY bucket LIMIT 9000`,
        );
      }
      if (path[2] === "terminal-ticket" && method === "POST") {
        elevated(user);
        await rateLimit(`terminal:${user.id}`, 15, 60);
        if (
          server.revoked ||
          !server.info.terminal ||
          !server.last_seen ||
          Date.now() - new Date(server.last_seen).getTime() > 45000
        )
          throw new HttpError(409, "服务器离线或未启用终端");
        const raw = token();
        await sql`INSERT INTO terminal_tickets(token_hash,user_id,session_hash,server_id,expires_at) VALUES(${hash(raw)},${user.id},${user.token_hash},${id},now()+interval '30 seconds')`;
        await audit(user.id, "terminal.authorized", id);
        return json({ ticket: raw });
      }
      if (path[2] === "diagnostics" && method === "POST") {
        await rateLimit(`diagnostics:${user.id}`, 30, 60);
        if (server.revoked || !server.info.diagnostics)
          throw new HttpError(409, "此服务器未启用诊断");
        const x = await body(
          request,
          z.object({
            kind: z.enum(["processes", "services", "logs"]),
            unit: z
              .string()
              .regex(/^[a-zA-Z0-9_.@:-]{1,128}\.service$/)
              .optional(),
          }),
        );
        const [job] =
          await sql`INSERT INTO diagnostic_jobs(server_id,user_id,kind,unit) VALUES(${id},${user.id},${x.kind},${x.unit ?? null}) RETURNING id`;
        await audit(user.id, "diagnostic.requested", id, { kind: x.kind, unit: x.unit });
        return json(job, 202);
      }
    }
    if (path[0] === "jobs" && path[1] && method === "GET") {
      const [job] =
        await sql`SELECT id,state,result,expires_at FROM diagnostic_jobs WHERE id=${idSchema.parse(path[1])} AND user_id=${user.id}`;
      if (!job) throw new HttpError(404, "任务不存在");
      return json(job);
    }
    if (route === "checks" && method === "GET")
      return json(
        await sql`SELECT c.*,s.name AS server_name FROM checks c LEFT JOIN servers s ON s.id=c.server_id ORDER BY c.name`,
      );
    if (route === "checks" && method === "POST") {
      const x = await body(request, checkInput);
      try {
        await validateTarget(x.kind, x.target);
      } catch {
        throw new HttpError(400, "目标格式错误或属于私有/特殊地址，默认仅允许公网目标");
      }
      if ((await sql`SELECT count(*)::int AS n FROM checks`)[0].n >= 3000)
        throw new HttpError(409, "已达到检查数量上限");
      if (
        x.serverId &&
        !(await sql`SELECT id FROM servers WHERE id=${x.serverId} AND revoked=false`).length
      )
        throw new HttpError(404, "服务器不存在");
      const [check] =
        await sql`INSERT INTO checks(name,server_id,kind,target,interval_seconds,enabled) VALUES(${x.name},${x.serverId},${x.kind},${x.target},${x.intervalSeconds},${x.enabled}) RETURNING id`;
      await audit(user.id, "check.created", check.id);
      return json(check, 201);
    }
    if (path[0] === "checks" && path[1]) {
      const id = idSchema.parse(path[1]);
      if (path[2] === "history" && method === "GET")
        return json(
          await sql`SELECT checked_at,data FROM check_results WHERE check_id=${id} ORDER BY checked_at DESC LIMIT 200`,
        );
      if (method === "DELETE") {
        await sql`DELETE FROM checks WHERE id=${id}`;
        await audit(user.id, "check.deleted", id);
        return json({ ok: true });
      }
      if (method === "PATCH") {
        const x = await body(request, z.object({ enabled: z.boolean() }));
        await sql`UPDATE checks SET enabled=${x.enabled} WHERE id=${id}`;
        await audit(user.id, "check.updated", id);
        return json({ ok: true });
      }
    }
    if (route === "alerts" && method === "GET")
      return json(
        await sql`SELECT a.*,CASE WHEN c.id IS NULL THEN r.name ELSE r.name||' · '||c.name END AS name,r.metric,r.muted_until,coalesce(s.name,'Master 控制端') AS server_name FROM alerts a JOIN alert_rules r ON r.id=a.rule_id LEFT JOIN servers s ON s.id=a.server_id LEFT JOIN checks c ON c.id=a.check_id ORDER BY a.updated_at DESC LIMIT 200`,
      );
    if (route === "rules" && method === "GET")
      return json(await sql`SELECT * FROM alert_rules ORDER BY name`);
    if (route === "rules" && method === "POST") {
      const x = await body(request, ruleInput);
      const [r] =
        await sql`INSERT INTO alert_rules(name,server_id,metric,threshold,recovery,duration_seconds,enabled) VALUES(${x.name},${x.serverId},${x.metric},${x.threshold},${x.recovery},${x.durationSeconds},${x.enabled}) RETURNING id`;
      await audit(user.id, "rule.created", r.id);
      return json(r, 201);
    }
    if (path[0] === "rules" && path[1]) {
      const id = idSchema.parse(path[1]);
      if (method === "DELETE") {
        await sql`DELETE FROM alert_rules WHERE id=${id}`;
        await audit(user.id, "rule.deleted", id);
        return json({ ok: true });
      }
      if (method === "PATCH") {
        const x = await body(
          request,
          z.object({
            enabled: z.boolean().optional(),
            muteMinutes: z.number().int().min(0).max(10080).optional(),
          }),
        );
        if (x.enabled !== undefined)
          await sql`UPDATE alert_rules SET enabled=${x.enabled} WHERE id=${id}`;
        if (x.muteMinutes !== undefined)
          await sql`UPDATE alert_rules SET muted_until=now()+${x.muteMinutes}*interval '1 minute' WHERE id=${id}`;
        await audit(user.id, "rule.updated", id, x);
        return json({ ok: true });
      }
    }
    if (route === "channels" && method === "GET")
      return json(await sql`SELECT id,name,kind,enabled FROM channels ORDER BY name`);
    if (route === "channels" && method === "POST") {
      elevated(user);
      const x = await body(
        request,
        z.discriminatedUnion("kind", [
          z.object({
            name: z.string().min(1).max(100),
            kind: z.literal("webhook"),
            url: z.url().max(2048),
            secret: z.string().min(32).max(256),
          }),
          z.object({
            name: z.string().min(1).max(100),
            kind: z.literal("telegram"),
            botToken: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,200}$/),
            chatId: z.string().regex(/^-?\d{1,20}$/),
          }),
        ]),
      );
      if (x.kind === "webhook") {
        if (new URL(x.url).protocol !== "https:")
          throw new HttpError(400, "Webhook 必须使用 HTTPS");
        try {
          await validateTarget("http", x.url);
        } catch {
          throw new HttpError(400, "Webhook 目标不受允许");
        }
      }
      const [c] =
        await sql`INSERT INTO channels(name,kind,encrypted_config) VALUES(${x.name},${x.kind},${encrypt(JSON.stringify(x))}) RETURNING id`;
      await audit(user.id, "channel.created", c.id);
      return json(c, 201);
    }
    if (path[0] === "channels" && path[1]) {
      const id = idSchema.parse(path[1]);
      elevated(user);
      if (method === "DELETE") {
        await sql`DELETE FROM channels WHERE id=${id}`;
        await audit(user.id, "channel.deleted", id);
        return json({ ok: true });
      }
      if (path[2] === "test" && method === "POST") {
        await sql`INSERT INTO notification_outbox(channel_id,payload) VALUES(${id},${sql.json({ title: "Blink Node 测试通知", message: "通知渠道连接测试", at: new Date().toISOString() })})`;
        await audit(user.id, "channel.test", id);
        return json({ ok: true }, 202);
      }
    }
    if (route === "notifications" && method === "GET")
      return json(
        await sql`SELECT o.id,c.name AS channel_name,o.attempts,o.delivered_at,o.last_error,o.created_at FROM notification_outbox o JOIN channels c ON c.id=o.channel_id ORDER BY o.created_at DESC LIMIT 100`,
      );
    if (route === "audit" && method === "GET")
      return json(
        await sql`SELECT a.*,u.username FROM audit_events a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200`,
      );
    if (route === "terminal-sessions" && method === "GET")
      return json(
        await sql`SELECT t.*,s.name AS server_name FROM terminal_sessions t JOIN servers s ON s.id=t.server_id ORDER BY started_at DESC LIMIT 100`,
      );
    throw new HttpError(404, "接口不存在");
  } catch (error) {
    return failure(error);
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
