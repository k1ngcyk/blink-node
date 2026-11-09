"use client";
import { useState } from "react";
import {
  IconPlus,
  IconPlayerPause,
  IconPlayerPlay,
  IconTrash,
  IconRadar,
} from "@tabler/icons-react";
import { api, useResource } from "@/lib/client";
import type { Check, Server } from "@/lib/types";
import { when } from "@/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Empty, ErrorBanner, Loading } from "./common";
export function Checks() {
  const list = useResource<Check[]>("checks", 5000),
    servers = useResource<Server[]>("servers");
  const [open, setOpen] = useState(false),
    [kind, setKind] = useState("tcp"),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [selected, setSelected] = useState<Check | null>(null),
    [deleting, setDeleting] = useState<Check | null>(null);
  const failing = list.data?.filter((c) => c.enabled && c.latest && !c.latest.ok).length ?? 0;
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setSaving(true);
    setError("");
    try {
      await api("checks", "POST", {
        name: f.get("name"),
        kind,
        target: f.get("target"),
        serverId: f.get("serverId") || null,
        intervalSeconds: Number(f.get("interval")),
      });
      setOpen(false);
      void list.refresh();
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
          <h1>网络检查</h1>
          <p>从服务器或 Master 发起探测，区分两端的网络视角。</p>
        </div>
        <Button
          onClick={() => {
            setOpen(true);
            setError("");
          }}
        >
          <IconPlus size={16} />
          添加检查
        </Button>
      </div>
      <ErrorBanner error={list.error || (!open ? error : "")} retry={list.refresh} />
      <div className="row mb-5">
        <span className="status online">
          {list.data?.filter((c) => c.enabled && c.latest?.ok).length ?? 0} 项正常
        </span>
        <span className={failing ? "status offline" : "muted text-xs"}>{failing} 项异常</span>
        <span className="muted text-xs">{list.data?.length ?? 0} 项检查</span>
      </div>
      {list.loading ? (
        <Loading />
      ) : (
        <section className="panel">
          {!list.data?.length ? (
            <Empty
              title="让网络状态可观测"
              description="添加 TCP、HTTP、ICMP 或 TLS 检查，持续跟踪延迟、丢包与证书有效期。"
              action={
                <Button variant="outline" onClick={() => setOpen(true)}>
                  <IconPlus size={16} />
                  添加检查
                </Button>
              }
            />
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>检查 / 目标</th>
                    <th>探测位置</th>
                    <th>状态</th>
                    <th>延迟 / 丢包</th>
                    <th>证书剩余</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <button className="server-name" onClick={() => setSelected(c)}>
                          <IconRadar size={16} className="muted" />
                          {c.name}
                        </button>
                        <span className="subline mono max-w-72 truncate" title={c.target}>
                          {c.kind.toUpperCase()} · {c.target}
                        </span>
                      </td>
                      <td>
                        {c.server_name ?? "Master 控制端"}
                        <span className="subline">每 {c.interval_seconds} 秒</span>
                      </td>
                      <td>
                        <span
                          className={`status ${!c.enabled ? "revoked" : !c.latest ? "pending" : c.latest.ok ? "online" : "offline"}`}
                        >
                          {!c.enabled
                            ? "已暂停"
                            : !c.latest
                              ? "等待检查"
                              : c.latest.ok
                                ? "正常"
                                : "失败"}
                        </span>
                        {c.latest?.error && (
                          <span className="subline max-w-48 truncate" title={c.latest.error}>
                            {c.latest.error}
                          </span>
                        )}
                      </td>
                      <td className="mono">
                        {c.latest?.latencyMs != null ? `${c.latest.latencyMs.toFixed(1)} ms` : "—"}
                        <span className="subline">
                          {c.latest?.loss != null
                            ? `丢包 ${c.latest.loss.toFixed(0)}%`
                            : c.latest?.status
                              ? `HTTP ${c.latest.status}`
                              : ""}
                        </span>
                      </td>
                      <td>
                        {c.latest?.certificateDays != null ? (
                          <span className={c.latest.certificateDays < 14 ? "warning" : ""}>
                            {Math.floor(c.latest.certificateDays)} 天
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <div className="row justify-end">
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={c.enabled ? `暂停 ${c.name}` : `启用 ${c.name}`}
                            onClick={async () => {
                              try {
                                await api(`checks/${c.id}`, "PATCH", { enabled: !c.enabled });
                                void list.refresh();
                              } catch (e) {
                                setError((e as Error).message);
                              }
                            }}
                          >
                            {c.enabled ? (
                              <IconPlayerPause size={16} />
                            ) : (
                              <IconPlayerPlay size={16} />
                            )}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`删除 ${c.name}`}
                            onClick={() => setDeleting(c)}
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
          )}
        </section>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加网络检查</DialogTitle>
            <DialogDescription>
              默认只允许公网目标，每次探测均重新校验 DNS 与目的地址。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={create} className="stack">
            <label className="field">
              名称
              <Input name="name" required maxLength={100} placeholder="例如：主站 HTTPS" />
            </label>
            <div className="form-grid">
              <label className="field">
                检查类型
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="tcp">TCP 连接</option>
                  <option value="http">HTTP / HTTPS</option>
                  <option value="icmp">ICMP Ping</option>
                  <option value="tls">TLS 证书</option>
                </select>
              </label>
              <label className="field">
                探测位置
                <select name="serverId">
                  <option value="">Master 控制端</option>
                  {servers.data
                    ?.filter((s) => !s.revoked)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <label className="field">
              目标
              <Input
                name="target"
                key={kind}
                required
                maxLength={2048}
                placeholder={
                  kind === "http"
                    ? "https://example.com/health"
                    : kind === "icmp"
                      ? "1.1.1.1"
                      : "example.com:443"
                }
              />
              <small>
                {kind === "http"
                  ? "不跟随重定向；2xx 或 3xx 视为成功。"
                  : "主机名或公网 IP，TCP / TLS 可指定端口。"}
              </small>
            </label>
            <label className="field">
              检查间隔（秒）
              <Input name="interval" type="number" min={30} max={3600} defaultValue={60} required />
            </label>
            <ErrorBanner error={error} />
            <Button type="submit" disabled={saving}>
              {saving ? "校验目标中…" : "创建检查"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[85dvh] overflow-auto">
          <DialogHeader>
            <DialogTitle>{selected?.name}</DialogTitle>
            <DialogDescription>最近 200 次探测结果</DialogDescription>
          </DialogHeader>
          {selected && <CheckHistory id={selected.id} />}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除检查 {deleting?.name}？</DialogTitle>
            <DialogDescription>该检查及其历史结果将被删除。</DialogDescription>
          </DialogHeader>
          <Button
            variant="destructive"
            onClick={async () => {
              try {
                await api(`checks/${deleting!.id}`, "DELETE");
                setDeleting(null);
                void list.refresh();
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
function CheckHistory({ id }: { id: string }) {
  const history = useResource<{ checked_at: string; data: NonNullable<Check["latest"]> }[]>(
    `checks/${id}/history`,
  );
  return (
    <>
      <ErrorBanner error={history.error} />
      {history.loading ? (
        <Loading />
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>结果</th>
                <th>延迟</th>
                <th>丢包</th>
              </tr>
            </thead>
            <tbody>
              {history.data?.map((h, i) => (
                <tr key={i}>
                  <td>{when(h.checked_at)}</td>
                  <td>{h.data.ok ? "正常" : (h.data.error ?? "失败")}</td>
                  <td>{h.data.latencyMs?.toFixed(1) ?? "—"} ms</td>
                  <td>{h.data.loss != null ? `${h.data.loss}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!history.data?.length && <p className="muted p-4">尚无探测记录</p>}
        </div>
      )}
    </>
  );
}
