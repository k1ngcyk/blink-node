import { sql } from "../db";
import type { Metric } from "./protocol";
export const metricKeys = [
  "cpu",
  "memory",
  "swap",
  "disk",
  "rxRate",
  "txRate",
  "diskReadRate",
  "diskWriteRate",
] as const;
export function summary(m: Metric) {
  return {
    cpu: m.cpu,
    memory: m.memoryTotal ? (m.memoryUsed / m.memoryTotal) * 100 : 0,
    swap: m.swapTotal ? (m.swapUsed / m.swapTotal) * 100 : 0,
    disk: Math.max(0, ...m.disks.map((d) => (d.total ? (d.used / d.total) * 100 : 0))),
    rxRate: m.networks.reduce((n, x) => n + x.rxRate, 0),
    txRate: m.networks.reduce((n, x) => n + x.txRate, 0),
    diskReadRate: m.diskReadRate,
    diskWriteRate: m.diskWriteRate,
  };
}
export async function ensurePartitions(now = new Date()) {
  for (let day = -2; day <= 2; day++) {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day),
    );
    const end = new Date(start.getTime() + 86400000);
    const name = `metric_samples_${start.toISOString().slice(0, 10).replaceAll("-", "")}`;
    // Names and boundaries are exclusively generated from dates, never user input.
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF metric_samples FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')`,
    );
  }
}
export async function ingest(serverId: string, samples: Metric[]) {
  const now = Date.now();
  const valid = samples.filter((m) => {
    const t = Date.parse(m.at);
    return t <= now + 30000 && t >= now - 24 * 3600000;
  });
  if (!valid.length) return;
  const records = valid.map((m) => ({
    server_id: serverId,
    boot_id: m.bootId,
    seq: m.seq,
    collected_at: m.at,
    data: { ...m, ...summary(m) },
  }));
  await sql.begin(async (tx) => {
    const inserted =
      await tx`INSERT INTO metric_samples SELECT * FROM jsonb_to_recordset(${sql.json(records)}) AS x(server_id uuid,boot_id uuid,seq bigint,collected_at timestamptz,data jsonb) ON CONFLICT DO NOTHING RETURNING data`;
    if (!inserted.length) return;
    const byTraffic = new Map<
      string,
      { server_id: string; day: string; interface: string; rx: number; tx: number }
    >();
    const dirty = new Map<string, { server_id: string; bucket: string }>();
    for (const row of inserted) {
      const m = row.data as Metric;
      const bucket = new Date(Math.floor(Date.parse(m.at) / 60000) * 60000).toISOString();
      dirty.set(bucket, { server_id: serverId, bucket });
      for (const n of m.networks) {
        const day = m.at.slice(0, 10),
          key = `${day}:${n.name}`;
        const prev = byTraffic.get(key) ?? {
          server_id: serverId,
          day,
          interface: n.name,
          rx: 0,
          tx: 0,
        };
        prev.rx += n.rxDelta;
        prev.tx += n.txDelta;
        byTraffic.set(key, prev);
      }
    }
    await tx`INSERT INTO dirty_buckets SELECT * FROM jsonb_to_recordset(${sql.json([...dirty.values()])}) AS x(server_id uuid,bucket timestamptz) ON CONFLICT DO NOTHING`;
    if (byTraffic.size)
      await tx`INSERT INTO traffic_daily SELECT * FROM jsonb_to_recordset(${sql.json([...byTraffic.values()])}) AS x(server_id uuid,day date,interface text,rx bigint,tx bigint) ON CONFLICT(server_id,day,interface) DO UPDATE SET rx=traffic_daily.rx+EXCLUDED.rx,tx=traffic_daily.tx+EXCLUDED.tx`;
    const newest = inserted
      .map((x) => x.data as Metric)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    await tx`UPDATE servers SET latest=${sql.json({ ...newest, ...summary(newest) })},latest_at=${newest.at},last_seen=now() WHERE id=${serverId} AND (latest_at IS NULL OR latest_at<${newest.at})`;
  });
}
export async function aggregate() {
  const rawExpr = metricKeys
    .map(
      (k) =>
        `'${k}',jsonb_build_object('avg',avg((m.data->>'${k}')::float8),'min',min((m.data->>'${k}')::float8),'max',max((m.data->>'${k}')::float8))`,
    )
    .join(",");
  const hourExpr = metricKeys
    .map(
      (k) =>
        `'${k}',jsonb_build_object('avg',sum((m.data->'${k}'->>'avg')::float8*m.count)/sum(m.count),'min',min((m.data->'${k}'->>'min')::float8),'max',max((m.data->'${k}'->>'max')::float8))`,
    )
    .join(",");
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(741829003)`;
    const dirty =
      await tx`DELETE FROM dirty_buckets WHERE (server_id,bucket) IN (SELECT server_id,bucket FROM dirty_buckets WHERE bucket<date_trunc('minute',now()) ORDER BY bucket LIMIT 10000 FOR UPDATE SKIP LOCKED) RETURNING server_id,bucket`;
    if (!dirty.length) return;
    const buckets = dirty.map((d) => ({
      server_id: d.server_id,
      bucket: new Date(d.bucket).toISOString(),
    }));
    await tx`INSERT INTO metric_rollups SELECT d.server_id,60,d.bucket,count(*)::int,jsonb_build_object(${tx.unsafe(rawExpr)}) FROM jsonb_to_recordset(${tx.json(buckets)}) AS d(server_id uuid,bucket timestamptz) JOIN metric_samples m ON m.server_id=d.server_id AND m.collected_at>=d.bucket AND m.collected_at<d.bucket+interval '1 minute' GROUP BY d.server_id,d.bucket ON CONFLICT(server_id,resolution,bucket) DO UPDATE SET count=EXCLUDED.count,data=EXCLUDED.data`;
    const hourBuckets = [
      ...new Map(
        buckets.map((d) => {
          const bucket = new Date(
            Math.floor(Date.parse(d.bucket) / 3600000) * 3600000,
          ).toISOString();
          return [`${d.server_id}:${bucket}`, { server_id: d.server_id, bucket }];
        }),
      ).values(),
    ];
    await tx`INSERT INTO metric_rollups SELECT d.server_id,3600,d.bucket,sum(m.count)::int,jsonb_build_object(${tx.unsafe(hourExpr)}) FROM jsonb_to_recordset(${tx.json(hourBuckets)}) AS d(server_id uuid,bucket timestamptz) JOIN metric_rollups m ON m.server_id=d.server_id AND m.resolution=60 AND m.bucket>=d.bucket AND m.bucket<d.bucket+interval '1 hour' GROUP BY d.server_id,d.bucket ON CONFLICT(server_id,resolution,bucket) DO UPDATE SET count=EXCLUDED.count,data=EXCLUDED.data`;
  });
}
export async function retention() {
  await ensurePartitions();
  await aggregate();
  const tables =
    await sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'metric_samples_%'`;
  for (const t of tables) {
    const match = /^metric_samples_(\d{4})(\d{2})(\d{2})$/.exec(t.tablename);
    if (match && Date.UTC(+match[1], +match[2] - 1, +match[3]) + 86400000 < Date.now() - 86400000) {
      const pending =
        await sql`SELECT 1 FROM dirty_buckets WHERE bucket<${new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]) + 86400000)} LIMIT 1`;
      if (!pending.length) await sql.unsafe(`DROP TABLE ${t.tablename}`);
    }
  }
  await sql`DELETE FROM metric_rollups WHERE (resolution=60 AND bucket<now()-interval '30 days') OR bucket<now()-interval '365 days'`;
  await sql`DELETE FROM traffic_daily WHERE day<current_date-400`;
  await sql`DELETE FROM check_results WHERE checked_at<now()-interval '7 days'`;
  await sql`DELETE FROM audit_events WHERE created_at<now()-interval '180 days'`;
  await sql`DELETE FROM terminal_sessions WHERE started_at<now()-interval '180 days'`;
  await sql`DELETE FROM sessions WHERE expires_at<now()`;
  await sql`DELETE FROM terminal_tickets WHERE expires_at<now()`;
  await sql`DELETE FROM rate_limits WHERE reset_at<now()`;
  await sql`DELETE FROM enrollments WHERE expires_at<now()-interval '1 day'`;
  await sql`DELETE FROM diagnostic_jobs WHERE created_at<now()-interval '1 day'`;
  await sql`DELETE FROM notification_outbox WHERE created_at<now()-interval '30 days'`;
}
export function billingStart(day: number, now = new Date()) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (now.getUTCDate() < day ? 1 : 0), day),
  );
}
export async function traffic(serverId: string, day: number, interfaces: string[]) {
  const start = billingStart(day).toISOString().slice(0, 10);
  const rows =
    await sql`SELECT interface,sum(rx)::text AS rx,sum(tx)::text AS tx FROM traffic_daily WHERE server_id=${serverId} AND day>=${start} GROUP BY interface ORDER BY interface`;
  const selected = rows.filter((r) =>
    interfaces.length
      ? interfaces.includes(r.interface)
      : !/^(lo|docker|br-|veth|tun|tap|wg|tailscale)/.test(r.interface),
  );
  return {
    start,
    interfaces: rows.map((r) => ({ ...r, rx: Number(r.rx), tx: Number(r.tx) })),
    rx: selected.reduce((s, r) => s + Number(r.rx), 0),
    tx: selected.reduce((s, r) => s + Number(r.tx), 0),
  };
}
