"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useState } from "react";
import {
  IconArrowLeft,
  IconTerminal2,
  IconCpu,
  IconDatabase,
  IconNetwork,
  IconClock,
} from "@tabler/icons-react";
import { api, useResource } from "@/lib/client";
import type { Server } from "@/lib/types";
import { status } from "@/lib/types";
import { bytes, percent, when, uptime } from "@/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { ErrorBanner, Loading, ServerStatus, Meter } from "./common";
import { MetricCharts, type History } from "./metric-charts";
import { EnrollmentView } from "./dashboard";
import { Proxies } from "./proxies";
import { SystemIdentity } from "./system-identity";
import { useQueryState } from "@/lib/query-state";
const TerminalPanel = dynamic(() => import("./terminal-panel").then((m) => m.TerminalPanel), {
  ssr: false,
  loading: () => <Loading />,
});
export function ServerDetail({ id }: { id: string }) {
  const { data: s, error, loading, refresh } = useResource<Server>(`servers/${id}`, 5000);
  const [requestedTab, setTab] = useQueryState("tab", "overview"),
    [requestedRange, setRange] = useQueryState("range", "1h"),
    [from] = useQueryState("from", "/");
  const tab = ["overview", "terminal", "diagnostics", "proxy", "settings"].includes(requestedTab)
    ? requestedTab
    : "overview";
  const range = ["1h", "24h", "7d", "30d", "1y"].includes(requestedRange) ? requestedRange : "1h";
  const returnTo = from === "/" || from.startsWith("/?") ? from : "/";
  const history = useResource<History[]>(
    `servers/${id}/history?range=${range}`,
    range === "1h" ? 15000 : 60000,
  );
  if (loading) return <Loading />;
  if (!s) return <ErrorBanner error={error} retry={refresh} />;
  const m = s.latest,
    online = status(s) === "online";
  return (
    <>
      <Link href={returnTo} className="row muted text-xs mb-4">
        <IconArrowLeft size={14} />
        全部服务器
      </Link>
      <div className="page-head">
        <div>
          <div className="row">
            <h1>{s.name}</h1>
            <ServerStatus server={s} />
          </div>
          <div className="detail-identity">
            <SystemIdentity os={s.info.os} />
            <span className="muted text-xs">
              {s.group_name} · {s.info.arch ?? "—"}
            </span>
          </div>
        </div>
        <Button variant="outline" onClick={() => setTab("terminal")}>
          <IconTerminal2 size={16} />
          网页终端
        </Button>
      </div>
      <ErrorBanner error={error} retry={refresh} />
      <div className="tabs-bar" role="tablist" aria-label="服务器详情">
        {[
          { id: "overview", name: "监控概览" },
          { id: "terminal", name: "网页终端" },
          { id: "diagnostics", name: "运行诊断" },
          { id: "proxy", name: "代理服务" },
          { id: "settings", name: "服务器设置" },
        ].map((t) => (
          <button
            role="tab"
            id={`server-tab-${t.id}`}
            aria-controls={`server-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            aria-selected={tab === t.id}
            key={t.id}
            onClick={() => setTab(t.id)}
            onKeyDown={(event) => {
              const buttons = Array.from(
                event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                  "[role=tab]",
                ),
              );
              const index = buttons.indexOf(event.currentTarget);
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % buttons.length
                  : event.key === "ArrowLeft"
                    ? (index + buttons.length - 1) % buttons.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? buttons.length - 1
                        : -1;
              if (next >= 0) {
                event.preventDefault();
                buttons[next].focus();
                buttons[next].click();
              }
            }}
          >
            {t.name}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`server-panel-${tab}`} aria-labelledby={`server-tab-${tab}`}>
        {tab === "overview" && (
          <>
            <div className="stats">
              <div className="stat">
                <div className="stat-label">
                  CPU 使用率
                  <IconCpu size={17} />
                </div>
                <div className="stat-value">{percent(online ? m?.cpu : null)}</div>
                <div className="stat-note">
                  {s.info.cpuCount ?? "—"} 核 · 负载{" "}
                  {m?.load?.map((n) => n.toFixed(2)).join(" / ") ?? "—"}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">
                  内存使用
                  <IconDatabase size={17} />
                </div>
                <div className="stat-value">{percent(online ? m?.memory : null)}</div>
                <div className="stat-note">
                  {bytes(m?.memoryUsed)} / {bytes(m?.memoryTotal)}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">
                  本周期流量
                  <IconNetwork size={17} />
                </div>
                <div className="stat-value">
                  {s.traffic ? bytes(s.traffic.rx + s.traffic.tx) : "—"}
                </div>
                <div className="stat-note">
                  {s.traffic?.start ?? "—"} 起 ·{" "}
                  {s.quota_bytes ? `配额 ${bytes(Number(s.quota_bytes))}` : "未设置配额"}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">
                  持续运行
                  <IconClock size={17} />
                </div>
                <div className="stat-value" style={{ fontSize: 22 }}>
                  {m ? uptime(m.uptime) : "—"}
                </div>
                <div className="stat-note">最近心跳 {when(s.last_seen)}</div>
              </div>
            </div>
            <div className="row between mb-3">
              <h2>历史趋势</h2>
              <select
                aria-label="历史时间范围"
                value={range}
                onChange={(e) => setRange(e.target.value)}
              >
                <option value="1h">最近 1 小时</option>
                <option value="24h">最近 24 小时</option>
                <option value="7d">最近 7 天</option>
                <option value="30d">最近 30 天</option>
                <option value="1y">最近 1 年</option>
              </select>
            </div>
            <ErrorBanner error={history.error} retry={history.refresh} />
            <MetricCharts data={history.data ?? []} />
            <div className="detail-grid section-gap">
              <div className="stack">
                <section className="panel">
                  <div className="panel-header">
                    <h2>磁盘与存储</h2>
                    <small className="muted">
                      读 {bytes(m?.diskReadRate)}/s · 写 {bytes(m?.diskWriteRate)}/s
                    </small>
                  </div>
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>挂载点</th>
                          <th>已用 / 容量</th>
                          <th>使用率</th>
                          <th>inode 使用率</th>
                        </tr>
                      </thead>
                      <tbody>
                        {m?.disks?.map((d) => (
                          <tr key={`${d.name}:${d.mount}`}>
                            <td className="mono">
                              {d.mount}
                              <span className="subline">{d.name}</span>
                            </td>
                            <td className="mono">
                              {bytes(d.used)} / {bytes(d.total)}
                            </td>
                            <td>
                              <Meter value={d.total ? (d.used / d.total) * 100 : 0} />
                            </td>
                            <td className="mono">
                              {d.inodesTotal
                                ? percent(((d.inodesUsed ?? 0) / d.inodesTotal) * 100)
                                : "不可用"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!m?.disks?.length && <p className="panel-body muted text-xs">暂无磁盘数据</p>}
                </section>
                <section className="panel">
                  <div className="panel-header">
                    <h2>网卡流量</h2>
                    <small className="muted">周期累计 / 实时速率</small>
                  </div>
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>网卡</th>
                          <th>接收</th>
                          <th>发送</th>
                          <th>本周期累计</th>
                        </tr>
                      </thead>
                      <tbody>
                        {m?.networks?.map((n) => {
                          const t = s.traffic?.interfaces.find((t) => t.interface === n.name);
                          return (
                            <tr key={n.name}>
                              <td className="mono">{n.name}</td>
                              <td className="mono">{bytes(n.rxRate)}/s</td>
                              <td className="mono">{bytes(n.txRate)}/s</td>
                              <td className="mono">{t ? bytes(t.rx + t.tx) : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
              <section className="panel self-start">
                <div className="panel-header">
                  <h2>主机信息</h2>
                </div>
                <div className="panel-body">
                  <dl className="kv">
                    <dt>主机名</dt>
                    <dd>{s.info.hostname ?? "—"}</dd>
                    <dt>CPU 型号</dt>
                    <dd>{s.info.cpuModel ?? "—"}</dd>
                    <dt>内核</dt>
                    <dd className="mono">{s.info.kernel ?? "—"}</dd>
                    <dt>Agent 版本</dt>
                    <dd className="mono">{s.info.version ?? "—"}</dd>
                    <dt>Swap</dt>
                    <dd>
                      {bytes(m?.swapUsed)} / {bytes(m?.swapTotal)}
                    </dd>
                    <dt>温度</dt>
                    <dd>
                      {m?.temperatures?.length
                        ? m.temperatures
                            .map((t) => `${t.name}: ${t.value.toFixed(1)}°C`)
                            .join(" · ")
                        : "设备未提供"}
                    </dd>
                    <dt>标签</dt>
                    <dd>{s.tags.join(" · ") || "—"}</dd>
                    <dt>最后采样</dt>
                    <dd>{when(s.latest_at)}</dd>
                    <dt>备注</dt>
                    <dd>{s.notes || "—"}</dd>
                  </dl>
                </div>
              </section>
            </div>
          </>
        )}
        <div hidden={tab !== "terminal"}>
          <TerminalPanel serverId={id} enabled={online && !!s.info.terminal} />
        </div>
        {tab === "diagnostics" && <Diagnostics server={s} />}
        {tab === "proxy" && <Proxies serverId={id} />}
        {tab === "settings" && <ServerSettings server={s} refresh={refresh} />}
      </div>
    </>
  );
}
function Diagnostics({ server }: { server: Server }) {
  const [kind, setKind] = useState("processes"),
    [unit, setUnit] = useState(""),
    [jobId, setJobId] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>按需诊断</h2>
        <small className="muted">只读 · 有界输出</small>
      </div>
      <div className="panel-body">
        <div className="row">
          <select aria-label="诊断类型" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="processes">进程 Top 30</option>
            <option value="services">systemd 服务状态</option>
            <option value="logs">最近系统日志</option>
          </select>
          {kind === "logs" && (
            <Input
              className="max-w-64"
              aria-label="systemd 单元"
              placeholder="可选：nginx.service"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
            />
          )}
          <Button
            disabled={busy || !server.info.diagnostics || status(server) !== "online"}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const r = await api<{ id: string }>(`servers/${server.id}/diagnostics`, "POST", {
                  kind,
                  ...(kind === "logs" && unit ? { unit } : {}),
                });
                setJobId(r.id);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            获取诊断
          </Button>
        </div>
        <p className="muted text-xs my-3">
          日志最多 100 行，范围为最近 1 小时。可见内容取决于 Agent 的系统权限。
        </p>
        <ErrorBanner error={error} />
        {jobId ? (
          <DiagnosticResult key={jobId} id={jobId} />
        ) : (
          <div className="notice">选择诊断类型后获取服务器当前状态。</div>
        )}
      </div>
    </section>
  );
}
function DiagnosticResult({ id }: { id: string }) {
  const job = useResource<{ state: string; result: string | null }>(`jobs/${id}`, 2000);
  return (
    <>
      <ErrorBanner error={job.error} />
      <pre className="code-block">
        {job.data?.result ?? (job.data?.state === "running" ? "正在执行…" : "等待 Agent 响应…")}
      </pre>
    </>
  );
}
function ServerSettings({ server: s, refresh }: { server: Server; refresh: () => void }) {
  const [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [busy, setBusy] = useState(false),
    [revoke, setRevoke] = useState(false),
    [enrollment, setEnrollment] = useState<Parameters<typeof EnrollmentView>[0]["value"] | null>(
      null,
    );
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api(`servers/${s.id}`, "PATCH", {
        name: f.get("name"),
        groupName: f.get("group"),
        tags: String(f.get("tags") || "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        notes: f.get("notes"),
        quotaBytes: f.get("quota") ? Math.round(Number(f.get("quota")) * 1024 ** 3) : null,
        billingDay: Number(f.get("billingDay")),
        billingInterfaces: String(f.get("interfaces") || "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setSuccess("设置已保存");
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-header">
          <h2>服务器设置</h2>
        </div>
        <form onSubmit={save} className="panel-body">
          <div className="form-grid">
            <label className="field">
              名称
              <Input name="name" defaultValue={s.name} required maxLength={100} />
            </label>
            <label className="field">
              分组
              <Input name="group" defaultValue={s.group_name} required maxLength={64} />
            </label>
            <label className="field full">
              标签
              <Input name="tags" defaultValue={s.tags.join(", ")} placeholder="英文逗号分隔" />
            </label>
            <label className="field">
              周期流量配额（GiB）
              <Input
                name="quota"
                type="number"
                min="1"
                max="8000000"
                defaultValue={s.quota_bytes ? Number(s.quota_bytes) / 1024 ** 3 : ""}
              />
              <small>留空则不启用配额提醒。</small>
            </label>
            <label className="field">
              每月起始日（UTC）
              <Input
                name="billingDay"
                type="number"
                min="1"
                max="28"
                defaultValue={s.billing_day}
                required
              />
            </label>
            <label className="field full">
              计费网卡
              <Input
                name="interfaces"
                defaultValue={s.billing_interfaces.join(", ")}
                placeholder="例如 eth0, ens3"
              />
              <small>
                留空会排除常见回环、桥接、容器和隧道网卡。流量是 Agent
                观测值，可能与服务商账单不同。
              </small>
            </label>
            <label className="field full">
              备注
              <Textarea name="notes" defaultValue={s.notes} maxLength={2000} />
            </label>
          </div>
          <div className="form-actions">
            {success && (
              <span role="status" className="success text-xs">
                {success}
              </span>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? "保存中…" : "保存设置"}
            </Button>
          </div>
          <ErrorBanner error={error} />
        </form>
      </section>
      <section className="panel">
        <div className="panel-header">
          <h2>接入凭证</h2>
        </div>
        <div className="panel-body stack">
          <p className="muted text-sm">
            重新接入会使旧凭证失效；吊销会关闭现有 Agent 连接与终端会话，保留历史数据。
          </p>
          <div className="row">
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  setEnrollment(await api(`servers/${s.id}/enrollment`, "POST", {}));
                  refresh();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              重新生成接入凭证
            </Button>
            <Button variant="destructive" disabled={s.revoked} onClick={() => setRevoke(true)}>
              吊销服务器凭证
            </Button>
          </div>
        </div>
      </section>
      <Dialog open={revoke} onOpenChange={setRevoke}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>吊销 {s.name} 的凭证？</DialogTitle>
            <DialogDescription>
              Agent 和终端连接将在最多 10 秒内关闭。重新接入需要生成新凭证。
            </DialogDescription>
          </DialogHeader>
          <ErrorBanner error={error} />
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await api(`servers/${s.id}/revoke`, "POST", {});
                setRevoke(false);
                refresh();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            确认吊销
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!enrollment}
        onOpenChange={(open) => {
          if (!open) setEnrollment(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新的接入凭证</DialogTitle>
            <DialogDescription>旧凭证已经失效。</DialogDescription>
          </DialogHeader>
          {enrollment && <EnrollmentView value={enrollment} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
