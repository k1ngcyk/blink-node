"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  IconPlus,
  IconSearch,
  IconServer,
  IconActivity,
  IconCpu,
  IconArrowsTransferUp,
  IconChevronRight,
  IconCopy,
  IconCheck,
} from "@tabler/icons-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { api, useResource } from "@/lib/client";
import { Server, serverAddresses, status } from "@/lib/types";
import { bytes, percent } from "@/lib/utils";
import { ErrorBanner, Loading, Empty, ServerStatus, Meter } from "./common";
import { agentInstallCommand, agentVersion } from "@/lib/agent-install";
import { SystemIdentity } from "./system-identity";
import { useQueryState } from "@/lib/query-state";
type Enrollment = { id: string; enrollmentToken: string; serverUrl: string; expiresIn: number };
export function EnrollmentView({ value }: { value: Enrollment }) {
  const [copied, setCopied] = useState(false),
    [terminal, setTerminal] = useState(false),
    [error, setError] = useState("");
  const server = useResource<Server>(`servers/${value.id}`, 3000);
  const [issuedAt] = useState(() => Date.now());
  const [remaining, setRemaining] = useState(value.expiresIn);
  useEffect(() => {
    const timer = setInterval(
      () => setRemaining(Math.max(0, value.expiresIn - Math.floor((Date.now() - issuedAt) / 1000))),
      1000,
    );
    return () => clearInterval(timer);
  }, [issuedAt, value.expiresIn]);
  const connected =
    !!server.data?.last_seen &&
    Date.parse(server.data.last_seen) > issuedAt &&
    status(server.data) === "online";
  const command = agentInstallCommand(value.serverUrl, value.enrollmentToken, terminal);
  return (
    <div className="stack">
      <div className={`enrollment-status ${connected ? "connected" : ""}`} role="status">
        <IconCheck size={20} />
        <div>
          <strong>
            {connected
              ? "服务器已连接"
              : remaining
                ? "服务器已创建，等待安装 Agent"
                : "接入凭证已过期"}
          </strong>
          <p>
            {connected
              ? "监控数据已开始上报，可以查看服务器了。"
              : remaining
                ? `在服务器 root Shell 执行安装命令。凭证剩余 ${Math.floor(remaining / 60)} 分 ${remaining % 60} 秒。`
                : "前往服务器设置重新生成接入凭证。"}
          </p>
        </div>
      </div>
      <label className="field">
        Master 地址
        <Input readOnly value={value.serverUrl} />
      </label>
      <label className="row text-sm">
        <input
          type="checkbox"
          checked={terminal}
          onChange={(event) => {
            setTerminal(event.target.checked);
            setCopied(false);
          }}
        />
        启用网页终端（root 用户）
      </label>
      <label className="field">
        一键安装命令 · Agent v{agentVersion}
        <textarea
          aria-label="一键安装命令"
          className="code-block w-full"
          rows={6}
          readOnly
          value={command}
        />
      </label>
      <Button
        className="w-full"
        disabled={connected || !remaining}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setError("");
          } catch {
            setError("无法访问剪贴板，请手动选择并复制安装命令");
          }
        }}
      >
        {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
        {copied ? "已复制安装命令" : "复制一键安装命令"}
      </Button>
      <ErrorBanner error={error} />
      <p className="muted text-xs">
        支持 systemd Linux 和 Alpine / OpenRC（x86_64 / ARM64）；Alpine 自动安装依赖，其他系统需要
        curl、CA 证书和 Python 3.9+。Agent 未启用终端时以低权限运行，启用后以 root 运行，每 15
        分钟检查自动更新。命令含一次性凭证，请勿分享；已安装的节点请按部署文档启用自动更新。
      </p>
      <Button asChild variant={connected ? "default" : "outline"} className="w-full">
        <Link href={`/servers/${value.id}${!remaining && !connected ? "?tab=settings" : ""}`}>
          {!remaining && !connected ? "前往接入设置" : "查看服务器"}
          <IconChevronRight size={15} />
        </Link>
      </Button>
    </div>
  );
}
export function Dashboard() {
  const { data, loading, error, refresh } = useResource<Server[]>("servers", 5000);
  const [search, setSearch] = useQueryState("q"),
    [group, setGroup] = useQueryState("group", "all"),
    [filter, setFilter] = useQueryState("status", "all");
  const [open, setOpen] = useState(false),
    [enrollment, setEnrollment] = useState<Enrollment | null>(null),
    [saveError, setSaveError] = useState(""),
    [copiedIp, setCopiedIp] = useState(""),
    [copyError, setCopyError] = useState(""),
    [saving, setSaving] = useState(false);
  const servers = data ?? [],
    online = servers.filter((s) => status(s) === "online"),
    reporting = online.filter((s) => s.latest != null);
  const listQuery = new URLSearchParams();
  if (search) listQuery.set("q", search);
  if (group !== "all") listQuery.set("group", group);
  if (filter !== "all") listQuery.set("status", filter);
  const serverHref = (id: string) =>
    `/servers/${id}${listQuery.size ? `?from=${encodeURIComponent(`/?${listQuery}`)}` : ""}`;
  const groups = [...new Set(servers.map((s) => s.group_name))];
  const filtered = servers.filter(
    (s) =>
      (group === "all" || s.group_name === group) &&
      (filter === "all" || status(s) === filter) &&
      `${s.name} ${s.group_name} ${s.tags.join(" ")} ${s.info.hostname ?? ""} ${s.info.os ?? ""} ${serverAddresses(s).join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setSaveError("");
    const form = new FormData(e.currentTarget);
    try {
      setEnrollment(
        await api<Enrollment>("servers", "POST", {
          name: form.get("name"),
          groupName: form.get("groupName") || "默认分组",
          tags: String(form.get("tags") || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      );
      void refresh();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">INFRASTRUCTURE</div>
          <h1>服务器概览</h1>
          <p>监控运行状态，连接你的每一台服务器。</p>
        </div>
        <Button
          onClick={() => {
            setOpen(true);
            setEnrollment(null);
            setSaveError("");
          }}
        >
          <IconPlus size={17} />
          添加服务器
        </Button>
      </div>
      <ErrorBanner error={error} retry={refresh} />
      <ErrorBanner error={copyError} />
      {loading ? (
        <Loading />
      ) : (
        <>
          <div className="stats fleet-stats">
            <div className="stat">
              <div className="stat-label">
                在线服务器
                <IconServer size={17} />
              </div>
              <div className="stat-value">
                {online.length}
                <span className="muted text-base font-normal"> / {servers.length}</span>
              </div>
              <div className="stat-note">
                {servers.filter((s) => status(s) === "offline").length} 台离线 ·{" "}
                {servers.filter((s) => status(s) === "pending").length} 台待接入
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">
                平均 CPU 使用率
                <IconCpu size={17} />
              </div>
              <div className="stat-value">
                {reporting.length
                  ? percent(
                      reporting.reduce((a, s) => a + (s.latest?.cpu ?? 0), 0) / reporting.length,
                    )
                  : "—"}
              </div>
              <div className="stat-note">{reporting.length} 台已有采样</div>
            </div>
            <div className="stat">
              <div className="stat-label">
                实时接收
                <IconActivity size={17} />
              </div>
              <div className="stat-value">
                {bytes(
                  reporting.length
                    ? reporting.reduce((a, s) => a + (s.latest?.rxRate ?? 0), 0)
                    : null,
                )}
                <span className="muted text-sm font-normal">/s</span>
              </div>
              <div className="stat-note">全部非回环网卡汇总</div>
            </div>
            <div className="stat">
              <div className="stat-label">
                实时发送
                <IconArrowsTransferUp size={17} />
              </div>
              <div className="stat-value">
                {bytes(
                  reporting.length
                    ? reporting.reduce((a, s) => a + (s.latest?.txRate ?? 0), 0)
                    : null,
                )}
                <span className="muted text-sm font-normal">/s</span>
              </div>
              <div className="stat-note">5 秒采样 · 自动刷新</div>
            </div>
          </div>
          <section className="panel fleet-panel">
            <div className="toolbar">
              <div className="search">
                <IconSearch size={16} />
                <Input
                  aria-label="搜索服务器"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索名称、IP、系统或标签"
                />
              </div>
              <select
                aria-label="分组筛选"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
              >
                <option value="all">全部分组</option>
                {groups.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
              <select
                aria-label="状态筛选"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">全部状态</option>
                <option value="online">在线</option>
                <option value="offline">离线</option>
                <option value="pending">待接入</option>
                <option value="revoked">已吊销</option>
              </select>
              <span className="toolbar-meta">{filtered.length} 台服务器 · 5 秒刷新</span>
            </div>
            {!servers.length ? (
              <Empty
                title="接入你的第一台服务器"
                description="创建一次性接入凭证，在服务器上安装 Rust Agent，即可查看实时状态和历史趋势。"
                action={
                  <Button variant="outline" onClick={() => setOpen(true)}>
                    <IconPlus size={16} />
                    接入服务器
                  </Button>
                }
              />
            ) : !filtered.length ? (
              <Empty
                title="没有匹配的服务器"
                description="试试其他关键词，或清除当前筛选条件。"
                action={
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSearch("");
                      setGroup("all");
                      setFilter("all");
                    }}
                  >
                    清除筛选
                  </Button>
                }
              />
            ) : (
              <div className="table-scroll">
                <table className="data-table server-table">
                  <thead>
                    <tr>
                      <th>服务器 / 分组</th>
                      <th>状态</th>
                      <th>IP 地址</th>
                      <th>CPU</th>
                      <th>内存</th>
                      <th>网络 ↓ / ↑</th>
                      <th>运行环境</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((s) => (
                      <tr key={s.id}>
                        <td className="identity-cell">
                          <Link className="server-name" href={serverHref(s.id)}>
                            {s.name}
                          </Link>
                          <span className="subline">
                            {s.group_name}
                            {s.tags.length ? ` · ${s.tags.join(" / ")}` : ""}
                          </span>
                        </td>
                        <td className="status-cell">
                          <ServerStatus server={s} />
                        </td>
                        <td className="address-cell">
                          {serverAddresses(s).length ? (
                            <>
                              {serverAddresses(s).map((address) => (
                                <button
                                  key={address}
                                  type="button"
                                  className="ip-copy mono"
                                  aria-label={`复制 ${address}`}
                                  title={
                                    copiedIp === `${s.id}:${address}` ? "已复制" : "复制 IP 地址"
                                  }
                                  onClick={async () => {
                                    try {
                                      await navigator.clipboard.writeText(address);
                                      setCopiedIp(`${s.id}:${address}`);
                                      setCopyError("");
                                    } catch {
                                      setCopyError("无法访问剪贴板，请手动选择并复制 IP 地址");
                                    }
                                  }}
                                >
                                  {address}
                                  {copiedIp === `${s.id}:${address}` ? (
                                    <IconCheck size={13} />
                                  ) : (
                                    <IconCopy size={13} className="muted" />
                                  )}
                                </button>
                              ))}
                              <span className="subline">
                                {s.addresses?.length ? "代理节点地址" : "Agent 连接 IP"}
                              </span>
                            </>
                          ) : (
                            <span className="muted">等待地址上报</span>
                          )}
                        </td>
                        <td className="cpu-cell" data-label="CPU">
                          <Meter value={status(s) === "online" ? s.latest?.cpu : null} />
                        </td>
                        <td className="memory-cell" data-label="内存">
                          <Meter value={status(s) === "online" ? s.latest?.memory : null} />
                        </td>
                        <td className="network-cell" data-label="网络 ↓ / ↑">
                          <div className="mono text-xs">
                            ↓ {bytes(status(s) === "online" ? s.latest?.rxRate : null)}/s
                          </div>
                          <div className="mono text-xs muted">
                            ↑ {bytes(status(s) === "online" ? s.latest?.txRate : null)}/s
                          </div>
                        </td>
                        <td className="system-cell">
                          <SystemIdentity
                            os={s.info.os}
                            detail={`${s.info.arch ? `${s.info.arch} · ` : ""}${s.info.cpuCount ? `${s.info.cpuCount} 核 · ${bytes(s.latest?.memoryTotal)}` : "等待 Agent 上报"}`}
                          />
                        </td>
                        <td className="action-cell">
                          <Link
                            className="row-action"
                            href={serverHref(s.id)}
                            aria-label={`查看 ${s.name}`}
                          >
                            <IconChevronRight size={17} />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-auto">
          <DialogHeader>
            <DialogTitle>{enrollment ? "服务器已创建" : "添加服务器"}</DialogTitle>
            <DialogDescription>
              {enrollment
                ? "复制一条命令，在目标服务器完成安装。"
                : "先为服务器命名，再生成独立的接入凭证。"}
            </DialogDescription>
          </DialogHeader>
          {enrollment ? (
            <EnrollmentView value={enrollment} />
          ) : (
            <form onSubmit={create} className="stack">
              <label className="field">
                服务器名称
                <Input name="name" placeholder="例如：东京 · 主服务器" required maxLength={100} />
              </label>
              <label className="field">
                分组
                <Input name="groupName" defaultValue="默认分组" required maxLength={64} />
              </label>
              <label className="field">
                标签
                <Input
                  name="tags"
                  placeholder="用英文逗号分隔，例如 production, jp"
                  maxLength={300}
                />
              </label>
              <ErrorBanner error={saveError} />
              <Button disabled={saving} type="submit">
                {saving ? "正在创建…" : "生成接入凭证"}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
