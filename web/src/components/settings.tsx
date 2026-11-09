"use client";
import { useState } from "react";
import { IconShieldLock, IconPlus, IconSend, IconTrash } from "@tabler/icons-react";
import { api, useResource } from "@/lib/client";
import { when } from "@/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { ErrorBanner } from "./common";
import { ProxySettings } from "./proxy-settings";
type Channel = { id: string; name: string; kind: string; enabled: boolean };
export function Settings() {
  const session = useResource<{ username: string; elevatedUntil: string }>("session", 30000),
    channels = useResource<Channel[]>("channels"),
    deliveries = useResource<
      {
        id: string;
        channel_name: string;
        attempts: number;
        delivered_at: string | null;
        last_error: string | null;
        created_at: string;
      }[]
    >("notifications", 10000);
  const [open, setOpen] = useState(false),
    [kind, setKind] = useState("webhook"),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [saving, setSaving] = useState(false),
    [deleting, setDeleting] = useState<Channel | null>(null);
  async function act(fn: () => Promise<unknown>, success: string) {
    setError("");
    setMessage("");
    setSaving(true);
    try {
      await fn();
      setMessage(success);
      void session.refresh();
      void channels.refresh();
      void deliveries.refresh();
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
          <h1>设置</h1>
          <p>管理安全验证、通知渠道与运行策略。</p>
        </div>
      </div>
      <ErrorBanner error={error || channels.error || session.error} />
      {message && (
        <div role="status" className="notice mb-5 success">
          {message}
        </div>
      )}
      <div className="two-col">
        <section className="panel">
          <div className="panel-header">
            <h2 className="row">
              <IconShieldLock size={18} />
              安全验证
            </h2>
          </div>
          <div className="panel-body stack">
            <dl className="kv">
              <dt>当前账号</dt>
              <dd>{session.data?.username ?? "—"} · 所有者</dd>
              <dt>双因素认证</dt>
              <dd className="success">已强制启用</dd>
              <dt>高权限验证</dt>
              <dd>
                {session.data && new Date(session.data.elevatedUntil) > new Date()
                  ? `有效至 ${when(session.data.elevatedUntil)}`
                  : "需要重新验证"}
              </dd>
            </dl>
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void act(
                  () => api("auth/elevate", "POST", { code: f.get("code") }),
                  "高权限验证有效期已更新为 10 分钟",
                );
              }}
            >
              <label className="field">
                动态验证码
                <Input
                  name="code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  required
                />
                <small>打开终端、修改接入凭证和通知渠道前，需要近期双因素验证。</small>
              </label>
              <Button disabled={saving} type="submit">
                重新验证
              </Button>
            </form>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() =>
                void act(() => api("auth/revoke-sessions", "POST", {}), "其他登录会话已撤销")
              }
            >
              退出其他设备
            </Button>
          </div>
        </section>
        <section className="panel">
          <div className="panel-header">
            <h2>数据与权限策略</h2>
          </div>
          <div className="panel-body stack">
            <dl className="kv">
              <dt>采样频率</dt>
              <dd>默认 5 秒</dd>
              <dt>原始指标</dt>
              <dd>24–48 小时，按日分区清理</dd>
              <dt>分钟聚合</dt>
              <dd>30 天</dd>
              <dt>小时聚合</dt>
              <dd>365 天</dd>
              <dt>探测记录</dt>
              <dd>7 天</dd>
              <dt>操作审计</dt>
              <dd>180 天</dd>
              <dt>终端空闲</dt>
              <dd>15 分钟后关闭</dd>
              <dt>登录有效期</dt>
              <dd>8 小时</dd>
            </dl>
            <div className="notice">
              服务器、终端和探针仅对所有者开放。后续代理节点用户使用独立的资源授权。
            </div>
          </div>
        </section>
      </div>
      <ProxySettings />
      <section className="panel section-gap">
        <div className="panel-header">
          <h2>通知渠道</h2>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(true);
              setError("");
            }}
          >
            <IconPlus size={15} />
            添加渠道
          </Button>
        </div>
        <div className="panel-body">
          {!channels.data?.length ? (
            <p className="muted text-sm">
              还没有通知渠道。添加 Telegram 或 Webhook 后即可收到告警与恢复通知。
            </p>
          ) : (
            <ul className="plain-list">
              {channels.data.map((c) => (
                <li key={c.id} className="row between">
                  <div>
                    <strong className="font-medium">{c.name}</strong>
                    <span className="subline">
                      {c.kind === "telegram" ? "Telegram" : "HTTPS Webhook"} · 凭证加密保存
                    </span>
                  </div>
                  <div className="row">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={saving}
                      onClick={() =>
                        void act(
                          () => api(`channels/${c.id}/test`, "POST", {}),
                          "测试通知已进入投递队列，请查看投递记录",
                        )
                      }
                    >
                      <IconSend size={14} />
                      测试
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
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <section className="panel section-gap">
        <div className="panel-header">
          <h2>最近投递</h2>
          <small className="muted">失败后自动退避重试，最多 8 次</small>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>通知渠道</th>
                <th>创建时间</th>
                <th>尝试次数</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.data?.map((d) => (
                <tr key={d.id}>
                  <td>{d.channel_name}</td>
                  <td>{when(d.created_at)}</td>
                  <td className="mono">{d.attempts}</td>
                  <td>
                    <span
                      className={
                        d.delivered_at ? "success" : d.attempts >= 8 ? "error-text" : "muted"
                      }
                    >
                      {d.delivered_at
                        ? "已送达"
                        : d.attempts >= 8
                          ? "投递失败"
                          : d.last_error
                            ? "等待重试"
                            : "等待投递"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!deliveries.data?.length && <p className="panel-body muted text-sm">暂无投递记录</p>}
        </div>
      </section>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加通知渠道</DialogTitle>
            <DialogDescription>凭证加密存储，保存后无法再次读取明文。</DialogDescription>
          </DialogHeader>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              setSaving(true);
              setError("");
              try {
                await api("channels", "POST", {
                  name: f.get("name"),
                  kind,
                  ...(kind === "webhook"
                    ? { url: f.get("url"), secret: f.get("secret") }
                    : { botToken: f.get("botToken"), chatId: f.get("chatId") }),
                });
                setOpen(false);
                void channels.refresh();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setSaving(false);
              }
            }}
          >
            <label className="field">
              名称
              <Input name="name" required maxLength={100} />
            </label>
            <label className="field">
              渠道类型
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="webhook">HTTPS Webhook</option>
                <option value="telegram">Telegram</option>
              </select>
            </label>
            {kind === "webhook" ? (
              <>
                <label className="field">
                  Webhook URL
                  <Input
                    name="url"
                    type="url"
                    placeholder="https://hooks.example.com/blink"
                    required
                  />
                </label>
                <label className="field">
                  签名密钥
                  <Input
                    name="secret"
                    type="password"
                    minLength={32}
                    maxLength={256}
                    autoComplete="new-password"
                    required
                  />
                  <small>至少 32 字符。请求包含时间戳、投递 ID 与 HMAC-SHA256 签名。</small>
                </label>
              </>
            ) : (
              <>
                <label className="field">
                  Bot Token
                  <Input name="botToken" type="password" autoComplete="new-password" required />
                </label>
                <label className="field">
                  Chat ID
                  <Input name="chatId" required pattern="-?[0-9]+" />
                </label>
              </>
            )}
            <ErrorBanner error={error} />
            <Button disabled={saving}>{saving ? "保存中…" : "保存渠道"}</Button>
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
            <DialogTitle>删除通知渠道 {deleting?.name}？</DialogTitle>
            <DialogDescription>该渠道的待投递通知也会被删除。</DialogDescription>
          </DialogHeader>
          <Button
            variant="destructive"
            onClick={() =>
              void act(async () => {
                await api(`channels/${deleting!.id}`, "DELETE");
                setDeleting(null);
              }, "通知渠道已删除")
            }
          >
            确认删除
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
