"use client";
import Link from "next/link";
import { useState } from "react";
import { IconPlus, IconBellOff, IconTrash } from "@tabler/icons-react";
import { api, useResource } from "@/lib/client";
import { when } from "@/lib/utils";
import type { Server } from "@/lib/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Empty, ErrorBanner, Loading } from "./common";
type Alert = {
  id: string;
  rule_id: string;
  server_id: string | null;
  check_id: string | null;
  server_name: string;
  name: string;
  metric: string;
  state: string;
  since: string;
  value: number;
  updated_at: string;
  muted_until: string | null;
};
type Rule = {
  id: string;
  name: string;
  metric: string;
  threshold: number;
  recovery: number;
  duration_seconds: number;
  enabled: boolean;
  muted_until: string | null;
  server_id: string | null;
};
const metrics: Record<string, string> = {
  offline: "离线时长（秒）",
  cpu: "CPU 使用率（%）",
  memory: "内存使用率（%）",
  swap: "Swap 使用率（%）",
  disk: "磁盘最高使用率（%）",
  check: "检查失败（1 / 0）",
  certificate: "证书剩余天数",
  traffic: "周期流量配额（%）",
};
export function Alerts() {
  const alerts = useResource<Alert[]>("alerts", 10000),
    rules = useResource<Rule[]>("rules", 15000),
    servers = useResource<Server[]>("servers");
  const [tab, setTab] = useState("events"),
    [open, setOpen] = useState(false),
    [metric, setMetric] = useState("cpu"),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [deleting, setDeleting] = useState<Rule | null>(null);
  async function change(id: string, data: unknown) {
    try {
      await api(`rules/${id}`, "PATCH", data);
      void rules.refresh();
      void alerts.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      await api("rules", "POST", {
        name: f.get("name"),
        serverId: f.get("serverId") || null,
        metric,
        threshold: Number(f.get("threshold")),
        recovery: Number(f.get("recovery")),
        durationSeconds: Number(f.get("duration")),
      });
      setOpen(false);
      void rules.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>告警中心</h1>
          <p>持续异常才触发，恢复后自动通知。</p>
        </div>
        <Button
          onClick={() => {
            setOpen(true);
            setError("");
          }}
        >
          <IconPlus size={16} />
          添加规则
        </Button>
      </div>
      <ErrorBanner error={alerts.error || rules.error || (!open ? error : "")} />
      <div className="tabs-bar" role="tablist" aria-label="告警中心">
        <button role="tab" aria-selected={tab === "events"} onClick={() => setTab("events")}>
          告警状态
        </button>
        <button role="tab" aria-selected={tab === "rules"} onClick={() => setTab("rules")}>
          规则配置
        </button>
        <Link href="/settings" className="muted text-xs p-3 ml-auto">
          配置通知渠道 →
        </Link>
      </div>
      {tab === "events" ? (
        alerts.loading ? (
          <Loading />
        ) : (
          <section className="panel">
            {!alerts.data?.length ? (
              <Empty
                title="当前没有告警"
                description="资源阈值与离线规则已启用。服务器出现持续异常时，会在这里显示。"
              />
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>告警 / 服务器</th>
                      <th>状态</th>
                      <th>当前值</th>
                      <th>开始时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alerts.data.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <span className="font-medium">{a.name}</span>
                          <Link
                            href={a.server_id ? `/servers/${a.server_id}` : "/checks"}
                            className="subline"
                          >
                            {a.server_name} →
                          </Link>
                        </td>
                        <td>
                          <span
                            className={`status ${a.state === "firing" ? "offline" : a.state === "pending" ? "pending" : "online"}`}
                          >
                            {a.state === "firing"
                              ? "告警中"
                              : a.state === "pending"
                                ? "等待确认"
                                : "已恢复"}
                          </span>
                          {a.muted_until && new Date(a.muted_until) > new Date() && (
                            <span className="subline">通知已静默</span>
                          )}
                        </td>
                        <td className="mono">{Number(a.value).toFixed(2)}</td>
                        <td>{when(a.since)}</td>
                        <td>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void change(a.rule_id, { muteMinutes: 60 })}
                          >
                            <IconBellOff size={15} />
                            静默规则 1 小时
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )
      ) : (
        <section className="panel">
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>规则 / 指标</th>
                  <th>作用范围</th>
                  <th>触发 / 恢复</th>
                  <th>持续时间</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rules.data?.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong className="font-medium">{r.name}</strong>
                      <span className="subline">{metrics[r.metric]}</span>
                    </td>
                    <td>
                      {r.server_id
                        ? (servers.data?.find((s) => s.id === r.server_id)?.name ?? "指定服务器")
                        : "全部服务器"}
                    </td>
                    <td className="mono">
                      {r.metric === "certificate" ? "≤" : "≥"} {r.threshold} /{" "}
                      {r.metric === "certificate" ? "≥" : "≤"} {r.recovery}
                    </td>
                    <td>{r.duration_seconds} 秒</td>
                    <td>
                      <label className="row">
                        <input
                          type="checkbox"
                          checked={r.enabled}
                          onChange={(e) => void change(r.id, { enabled: e.target.checked })}
                        />
                        {r.enabled ? "启用" : "暂停"}
                      </label>
                    </td>
                    <td>
                      <div className="row justify-end">
                        {r.muted_until && new Date(r.muted_until) > new Date() ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void change(r.id, { muteMinutes: 0 })}
                          >
                            取消静默
                          </Button>
                        ) : (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`静默 ${r.name}`}
                            onClick={() => void change(r.id, { muteMinutes: 60 })}
                          >
                            <IconBellOff size={16} />
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`删除 ${r.name}`}
                          onClick={() => setDeleting(r)}
                        >
                          <IconTrash size={16} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加告警规则</DialogTitle>
            <DialogDescription>不同的触发与恢复阈值可以减少通知抖动。</DialogDescription>
          </DialogHeader>
          <form className="stack" onSubmit={create}>
            <label className="field">
              规则名称
              <Input name="name" required maxLength={100} />
            </label>
            <div className="form-grid">
              <label className="field">
                指标
                <select value={metric} onChange={(e) => setMetric(e.target.value)}>
                  {Object.entries(metrics).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                作用范围
                <select name="serverId">
                  <option value="">全部服务器</option>
                  {servers.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                触发阈值
                <Input
                  key={`t-${metric}`}
                  name="threshold"
                  type="number"
                  min={0}
                  step="any"
                  defaultValue={metric === "certificate" ? 14 : metric === "check" ? 1 : 90}
                  required
                />
              </label>
              <label className="field">
                恢复阈值
                <Input
                  key={`r-${metric}`}
                  name="recovery"
                  type="number"
                  min={0}
                  step="any"
                  defaultValue={metric === "certificate" ? 21 : metric === "check" ? 0 : 80}
                  required
                />
              </label>
            </div>
            <label className="field">
              持续时间（秒）
              <Input name="duration" type="number" defaultValue={60} min={0} max={86400} required />
            </label>
            <ErrorBanner error={error} />
            <Button disabled={saving}>{saving ? "保存中…" : "创建规则"}</Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deleting}
        onOpenChange={(v) => {
          if (!v) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除规则 {deleting?.name}？</DialogTitle>
            <DialogDescription>关联告警状态也将被删除。</DialogDescription>
          </DialogHeader>
          <Button
            variant="destructive"
            onClick={async () => {
              try {
                await api(`rules/${deleting!.id}`, "DELETE");
                setDeleting(null);
                void rules.refresh();
                void alerts.refresh();
              } catch (e) {
                setError((e as Error).message);
                setDeleting(null);
              }
            }}
          >
            确认删除
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
