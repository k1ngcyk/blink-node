import { createHmac } from "node:crypto";
import { sql } from "../db";
import { decrypt } from "./crypto";
import { safeRequest } from "./network";
import { traffic } from "./metrics";

export function transition(
  state: string | undefined,
  value: number,
  threshold: number,
  recovery: number,
  durationSeconds: number,
  since: number,
  now: number,
  inverted = false,
) {
  const triggered = inverted ? value <= threshold : value >= threshold;
  const recovered = inverted ? value >= recovery : value <= recovery;
  if (state === "firing") return recovered ? "resolved" : "firing";
  if (!triggered) return "resolved";
  return durationSeconds === 0 || (state === "pending" && now - since >= durationSeconds * 1000)
    ? "firing"
    : "pending";
}
export async function evaluateAlerts() {
  const [rules, servers, checks, existing] = await Promise.all([
    sql`SELECT * FROM alert_rules WHERE enabled=true`,
    sql`SELECT id,name,last_seen,latest,latest_at,quota_bytes,billing_day,billing_interfaces FROM servers WHERE revoked=false AND token_hash IS NOT NULL`,
    sql`SELECT id,name,server_id,kind,latest,last_run,interval_seconds FROM checks WHERE enabled=true`,
    sql`SELECT * FROM alerts`,
  ]);
  const previous = new Map(existing.map((a) => [`${a.rule_id}:${a.server_id}`, a]));
  const now = Date.now();
  for (const server of servers) {
    for (const rule of rules) {
      if (rule.server_id && rule.server_id !== server.id) continue;
      const key = `${rule.id}:${server.id}`,
        prev = previous.get(key);
      let value: number | null = null;
      if (rule.metric === "offline")
        value = server.last_seen ? (now - new Date(server.last_seen).getTime()) / 1000 : 3600;
      else if (rule.metric === "check" || rule.metric === "certificate") {
        const related = checks.filter((c) => c.server_id === server.id);
        if (rule.metric === "check")
          value = related.some(
            (c) =>
              c.latest &&
              (!c.latest.ok || now - new Date(c.latest.at).getTime() > c.interval_seconds * 3000),
          )
            ? 1
            : 0;
        else {
          const days = related
            .filter((c) => c.latest?.certificateDays != null)
            .map((c) => c.latest.certificateDays as number);
          if (days.length) value = Math.min(...days);
        }
      } else if (rule.metric === "traffic") {
        if (server.quota_bytes) {
          const t = await traffic(server.id, server.billing_day, server.billing_interfaces);
          value = ((t.rx + t.tx) / Number(server.quota_bytes)) * 100;
        }
      } else if (server.latest && now - new Date(server.latest_at).getTime() < 45000)
        value = Number(server.latest[rule.metric]);
      if (value === null || !Number.isFinite(value)) continue;
      const state = transition(
        prev?.state,
        value,
        rule.threshold,
        rule.recovery,
        rule.duration_seconds,
        prev ? new Date(prev.since).getTime() : now,
        now,
        rule.metric === "certificate",
      );
      if (!prev && state === "resolved") continue;
      const since =
        !prev || (prev.state !== state && state !== "firing") ? new Date(now) : prev.since;
      const muted = rule.muted_until && new Date(rule.muted_until).getTime() > now;
      // A firing event gets at most one notification until recovery, including across restarts.
      const notify =
        !muted &&
        ((state === "firing" && !prev?.notified_at) ||
          (state === "resolved" && prev?.state === "firing" && prev.notified_at));
      await sql.begin(async (tx) => {
        await tx`INSERT INTO alerts(rule_id,server_id,state,since,value,updated_at,notified_at) VALUES(${rule.id},${server.id},${state},${since},${value},now(),${notify && state === "firing" ? new Date(now) : null}) ON CONFLICT(rule_id,server_id) DO UPDATE SET state=EXCLUDED.state,since=EXCLUDED.since,value=EXCLUDED.value,updated_at=now(),notified_at=CASE WHEN EXCLUDED.state='resolved' THEN NULL WHEN ${!!notify} THEN now() ELSE alerts.notified_at END`;
        if (notify) {
          const payload = {
            title: `${state === "firing" ? "告警" : "恢复"} · ${server.name}`,
            message: `${rule.name} · ${value.toFixed(2)}`,
            serverId: server.id,
            ruleId: rule.id,
            state,
            at: new Date(now).toISOString(),
          };
          await tx`INSERT INTO notification_outbox(channel_id,payload) SELECT id,${sql.json(payload)} FROM channels WHERE enabled=true`;
        }
      });
    }
  }
  // Master-origin checks have their own scope; they must also generate notifications.
  const checkPrevious = new Map(
    existing.filter((a) => a.check_id).map((a) => [`${a.rule_id}:${a.check_id}`, a]),
  );
  for (const c of checks.filter((c) => c.server_id === null && c.latest)) {
    for (const rule of rules.filter(
      (r) => r.server_id === null && ["check", "certificate"].includes(r.metric),
    )) {
      const prev = checkPrevious.get(`${rule.id}:${c.id}`);
      const value =
        rule.metric === "check"
          ? !c.latest.ok || now - new Date(c.latest.at).getTime() > c.interval_seconds * 3000
            ? 1
            : 0
          : c.latest.certificateDays;
      if (value === null || !Number.isFinite(value)) continue;
      const state = transition(
        prev?.state,
        value,
        rule.threshold,
        rule.recovery,
        rule.duration_seconds,
        prev ? new Date(prev.since).getTime() : now,
        now,
        rule.metric === "certificate",
      );
      if (!prev && state === "resolved") continue;
      const since =
        !prev || (prev.state !== state && state !== "firing") ? new Date(now) : prev.since;
      const muted = rule.muted_until && new Date(rule.muted_until).getTime() > now;
      const notify =
        !muted &&
        ((state === "firing" && !prev?.notified_at) ||
          (state === "resolved" && prev?.state === "firing" && prev.notified_at));
      await sql.begin(async (tx) => {
        await tx`INSERT INTO alerts(rule_id,check_id,state,since,value,updated_at,notified_at) VALUES(${rule.id},${c.id},${state},${since},${value},now(),${notify && state === "firing" ? new Date(now) : null}) ON CONFLICT(rule_id,check_id) DO UPDATE SET state=EXCLUDED.state,since=EXCLUDED.since,value=EXCLUDED.value,updated_at=now(),notified_at=CASE WHEN EXCLUDED.state='resolved' THEN NULL WHEN ${!!notify} THEN now() ELSE alerts.notified_at END`;
        if (notify) {
          const payload = {
            title: `${state === "firing" ? "告警" : "恢复"} · ${c.name}`,
            message: `Master 探测 · ${rule.name} · ${Number(value).toFixed(2)}`,
            checkId: c.id,
            ruleId: rule.id,
            state,
            at: new Date(now).toISOString(),
          };
          await tx`INSERT INTO notification_outbox(channel_id,payload) SELECT id,${sql.json(payload)} FROM channels WHERE enabled=true`;
        }
      });
    }
  }
}
export async function deliverNotifications(send: typeof safeRequest = safeRequest) {
  const rows =
    await sql`SELECT o.*,c.kind,c.encrypted_config FROM notification_outbox o JOIN channels c ON c.id=o.channel_id WHERE o.delivered_at IS NULL AND o.attempts<8 AND o.next_attempt<=now() AND c.enabled=true ORDER BY o.created_at LIMIT 10`;
  for (const row of rows) {
    try {
      const c = JSON.parse(decrypt(row.encrypted_config));
      let result: { status: number };
      if (row.kind === "telegram")
        result = await send(`https://api.telegram.org/bot${c.botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: c.chatId,
            text: `${row.payload.title}\n${row.payload.message}`,
            disable_web_page_preview: true,
          }),
        });
      else {
        const body = JSON.stringify({ id: row.id, ...row.payload }),
          timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = createHmac("sha256", c.secret)
          .update(`${timestamp}.${body}`)
          .digest("hex");
        result = await send(c.url, {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            "X-Blink-Timestamp": timestamp,
            "X-Blink-Signature": `sha256=${signature}`,
            "X-Blink-Delivery": row.id,
          },
        });
      }
      if (result.status < 200 || result.status >= 300) throw new Error("Non-success status");
      await sql`UPDATE notification_outbox SET delivered_at=now(),attempts=attempts+1,last_error=NULL WHERE id=${row.id}`;
    } catch {
      await sql`UPDATE notification_outbox SET attempts=attempts+1,next_attempt=now()+${Math.min(3600, 30 * 2 ** row.attempts)}*interval '1 second',last_error='投递失败：目标不可达或响应非 2xx' WHERE id=${row.id}`;
    }
  }
}
