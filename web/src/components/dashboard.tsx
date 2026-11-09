"use client";
import Link from "next/link";
import { useState } from "react";
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
import { Server, status } from "@/lib/types";
import { bytes, percent } from "@/lib/utils";
import { ErrorBanner, Loading, Empty, ServerStatus, Meter } from "./common";
import { agentInstallCommand, agentVersion } from "@/lib/agent-install";
type Enrollment = { id: string; enrollmentToken: string; serverUrl: string; expiresIn: number };
export function EnrollmentView({ value }: { value: Enrollment }) {
  const [copied, setCopied] = useState(false),
    [terminal, setTerminal] = useState(false),
    [error, setError] = useState("");
  const command = agentInstallCommand(value.serverUrl, value.enrollmentToken, terminal);
  return (
    <div className="stack">
      <div className="notice">
        接入凭证将在 15 分钟后失效，只能接入这一台服务器。以 root 身份运行下方命令（或先执行 sudo
        -i），自动完成下载、校验、注册和开机启动。
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
        启用网页终端（普通 blink-agent 用户）
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
        支持 systemd Linux x86_64 / ARM64，需要 curl 和 CA 证书。Agent
        默认低权限运行。命令含一次性凭证，请勿分享；已安装的节点请按部署文档升级或重新接入。
      </p>
      <Link href={`/servers/${value.id}`}>
        <Button className="w-full">
          查看服务器
          <IconChevronRight size={15} />
        </Button>
      </Link>
    </div>
  );
}
export function Dashboard() {
  const { data, loading, error, refresh } = useResource<Server[]>("servers", 5000);
  const [search, setSearch] = useState(""),
    [group, setGroup] = useState("all"),
    [filter, setFilter] = useState("all"),
    [open, setOpen] = useState(false),
    [enrollment, setEnrollment] = useState<Enrollment | null>(null),
    [saveError, setSaveError] = useState(""),
    [saving, setSaving] = useState(false);
  const servers = data ?? [],
    online = servers.filter((s) => status(s) === "online");
  const groups = [...new Set(servers.map((s) => s.group_name))];
  const filtered = servers.filter(
    (s) =>
      (group === "all" || s.group_name === group) &&
      (filter === "all" || status(s) === filter) &&
      `${s.name} ${s.group_name} ${s.tags.join(" ")} ${s.info.hostname ?? ""}`
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
          <h1>服务器概览</h1>
          <p>基础设施的实时状态，一目了然。</p>
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
      {loading ? (
        <Loading />
      ) : (
        <>
          <div className="stats">
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
                {online.length
                  ? percent(online.reduce((a, s) => a + (s.latest?.cpu ?? 0), 0) / online.length)
                  : "—"}
              </div>
              <div className="stat-note">当前在线服务器的平均值</div>
            </div>
            <div className="stat">
              <div className="stat-label">
                实时接收
                <IconActivity size={17} />
              </div>
              <div className="stat-value">
                {bytes(online.reduce((a, s) => a + (s.latest?.rxRate ?? 0), 0))}
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
                {bytes(online.reduce((a, s) => a + (s.latest?.txRate ?? 0), 0))}
                <span className="muted text-sm font-normal">/s</span>
              </div>
              <div className="stat-note">5 秒采样 · 自动刷新</div>
            </div>
          </div>
          <section className="panel">
            <div className="panel-header">
              <h2>
                服务器 <span className="muted font-normal text-xs ml-2">{servers.length}</span>
              </h2>
              <span className="status online">实时监控</span>
            </div>
            <div className="toolbar">
              <div className="search">
                <IconSearch size={16} />
                <Input
                  aria-label="搜索服务器"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索名称、标签或主机名"
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
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>服务器 / 分组</th>
                      <th>状态</th>
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
                        <td>
                          <Link className="server-name" href={`/servers/${s.id}`}>
                            <IconServer size={16} className="muted" />
                            {s.name}
                          </Link>
                          <span className="subline">
                            {s.group_name}
                            {s.tags.length ? ` · ${s.tags.join(" / ")}` : ""}
                          </span>
                        </td>
                        <td>
                          <ServerStatus server={s} />
                        </td>
                        <td>
                          <Meter value={status(s) === "online" ? s.latest?.cpu : null} />
                        </td>
                        <td>
                          <Meter value={status(s) === "online" ? s.latest?.memory : null} />
                        </td>
                        <td>
                          <div className="mono text-xs">
                            ↓ {bytes(status(s) === "online" ? s.latest?.rxRate : null)}/s
                          </div>
                          <div className="mono text-xs muted">
                            ↑ {bytes(status(s) === "online" ? s.latest?.txRate : null)}/s
                          </div>
                        </td>
                        <td>
                          <span>{s.info.arch ?? "—"}</span>
                          <span className="subline">
                            {s.info.cpuCount
                              ? `${s.info.cpuCount} 核 · ${bytes(s.latest?.memoryTotal)}`
                              : "等待 Agent 上报"}
                          </span>
                        </td>
                        <td>
                          <Link href={`/servers/${s.id}`} aria-label={`查看 ${s.name}`}>
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
