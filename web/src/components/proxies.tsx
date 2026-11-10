"use client";
import Link from "next/link";
import { useState } from "react";
import { IconPlus, IconRefresh, IconNetwork } from "@tabler/icons-react";
import { api, useResource } from "@/lib/client";
import type { Server } from "@/lib/types";
import type { ProxySpec, ProxyStatus } from "@/server/proxy-model";
import { when } from "@/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { ErrorBanner } from "./common";
import { useQueryState } from "@/lib/query-state";
import { ImportedEntranceForm } from "./imported-entrance-form";
import { subscriptionProtocols } from "@/lib/subscriptions";
import type { EntranceKind, EntranceSpec } from "@/server/proxy-entrances";

type Instance = {
  id: string;
  server_id: string;
  server_name: string;
  name: string;
  kind: ProxySpec["kind"];
  spec: ProxySpec;
  state: string;
  error?: string;
};
type Imported = {
  id: string;
  source_key: string;
  updated_at: string;
  summary: {
    engine: string;
    unit: string;
    active: boolean;
    paths: string[];
    warnings: string[];
    managed: boolean;
    inbounds: { protocol: string; port: number; reality: boolean }[];
    mode?: string;
    proxyCount?: number;
    proxyGroupCount?: number;
    ruleCount?: number;
  };
};
type Exit = {
  id: string;
  server_id: string;
  server_name: string;
  name: string;
  port: number;
  method: string;
  source: "managed" | "imported";
  state: string;
  addresses: string[];
};
type Entrance = {
  id: string;
  server_id: string;
  import_id: string;
  candidate_key: string;
  name: string;
  kind: EntranceKind;
  spec: EntranceSpec;
  state: string;
  addresses: string[];
};
type Host = {
  addresses: string[];
  firewall: string;
  desired_version?: number;
  applied_version?: number;
  firewall_desired_version?: number;
  firewall_applied_version?: number;
  scanned_at?: string;
  observed?: ProxyStatus;
  imports: Imported[];
  jobs: {
    id: string;
    operation: string;
    state: string;
    created_at: string;
    result?: { message?: string; error?: string; warnings?: string[] };
  }[];
};
const names = {
  reality: "VLESS · REALITY / Vision",
  anytls: "AnyTLS",
  shadowsocks2022: "Shadowsocks 2022",
};
const states: Record<string, string> = {
  pending: "部署中",
  active: "已部署",
  failed: "失败",
  disabled: "已停用",
  deleting: "删除中",
  queued: "等待节点",
  running: "执行中",
  done: "完成",
  stale: "配置已变化，请重新扫描并添加",
  missing_address: "待配置公网 IP",
};
const ufwStates: Record<string, string> = {
  active: "已启用",
  inactive: "未启用",
  not_installed: "未安装",
  error: "读取失败",
};

export function Proxies({ serverId }: { serverId?: string }) {
  const servers = useResource<Server[]>("servers", 10000),
    instances = useResource<Instance[]>("proxy/instances", 5000),
    exits = useResource<Exit[]>("proxy/exits", 5000),
    entrances = useResource<Entrance[]>("proxy/entrances", 5000);
  const [selected, setSelected] = useQueryState("server");
  const [editing, setEditing] = useState<Instance | "new" | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [detail, setDetail] = useState<{ title: string; value: unknown } | null>(null),
    [importing, setImporting] = useState<Imported | null>(null),
    [importingEntrance, setImportingEntrance] = useState<{
      importId: string;
      candidateKey?: string;
    } | null>(null),
    [hostDraft, setHostDraft] = useState<{
      id: string;
      addresses: string;
      firewall: string;
    } | null>(null);
  const selectedId = serverId || selected || servers.data?.[0]?.id;
  const server = servers.data?.find((s) => s.id === selectedId);
  const resource = useResource<Host & { server_id: string }>(
    selectedId ? `proxy/hosts/${selectedId}` : "",
    5000,
  );
  const host = {
    ...resource,
    data: resource.data?.server_id === selectedId ? resource.data : null,
  };
  const local = instances.data?.filter((i) => i.server_id === selectedId) ?? [];
  const jobsRunning = host.data?.jobs.some((j) => ["queued", "running"].includes(j.state));
  const draft = hostDraft?.id === selectedId ? hostDraft : null;
  const addressValue = draft?.addresses ?? host.data?.addresses.join(", ") ?? "";
  const firewallValue = draft?.firewall ?? host.data?.firewall ?? "existing";
  const observed = host.data?.observed;
  const ufwState =
    observed?.ufwState ?? observed?.ufw?.match(/^Status:\s*(active|inactive)\s*$/m)?.[1];
  const ufwLabel = ufwStates[ufwState ?? ""] ?? "等待节点上报";
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      void host.refresh();
      void instances.refresh();
      void exits.refresh();
      void entrances.refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {!serverId && (
        <div className="page-head">
          <div>
            <h1>代理服务</h1>
            <p>入口、SS2022 落地与服务端分流。节点自动管理安装和证书续期。</p>
          </div>
          <Link href="/settings?section=dns" className="muted text-sm">
            DNS 与证书设置
          </Link>
        </div>
      )}
      <ErrorBanner
        error={
          error || instances.error || exits.error || entrances.error || host.error || servers.error
        }
      />
      <div className="row between mb-4">
        {!serverId && (
          <select
            aria-label="代理服务器"
            value={selectedId || ""}
            disabled={busy}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="" disabled>
              选择服务器
            </option>
            {servers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <div className="row">
          <Button
            variant="outline"
            disabled={!host.data || !server?.info.proxy || busy || jobsRunning}
            onClick={() => void act(() => api(`proxy/hosts/${selectedId}/scan`, "POST", {}))}
          >
            <IconRefresh size={15} />
            刷新节点扫描
          </Button>
          <Button
            disabled={!host.data || !server?.info.proxy || busy || jobsRunning}
            onClick={() => setEditing("new")}
          >
            <IconPlus size={15} />
            安装代理
          </Button>
        </div>
      </div>
      {server && !server.info.proxy && (
        <div className="notice mb-4">
          此节点尚未启用代理部署器。新安装的 Agent 会自动配置；存量节点请使用新版安装包中的{" "}
          <code>enable-proxy.sh</code> 启用，随后重启 Agent。
        </div>
      )}
      {selectedId && (
        <details
          className="panel node-config mb-5"
          key={selectedId}
          open={draft || (host.data && !host.data.addresses.length) ? true : undefined}
        >
          <summary>
            <span>
              <strong>节点连接与防火墙</strong>
              <span className="subline">
                {host.data?.addresses.join(" · ") || "尚未配置公网 IP"} · UFW {ufwLabel}
              </span>
            </span>
            <span className="muted text-xs">
              配置 {host.data?.applied_version ?? 0} / {host.data?.desired_version ?? 0}
            </span>
          </summary>
          <form
            key={selectedId}
            className="panel-body"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(async () => {
                await api(`proxy/hosts/${selectedId}`, "PATCH", {
                  addresses: String(f.get("addresses"))
                    .split(/[\s,]+/)
                    .filter(Boolean),
                  firewall: f.get("firewall"),
                });
                await host.refresh();
                setHostDraft((current) => (current?.id === selectedId ? null : current));
              });
            }}
          >
            <div className="form-grid">
              <label className="field">
                公网 IP（IPv4 / IPv6）
                <Input
                  name="addresses"
                  disabled={!host.data || busy}
                  value={addressValue}
                  onChange={(e) =>
                    setHostDraft({
                      id: selectedId,
                      addresses: e.target.value,
                      firewall: firewallValue,
                    })
                  }
                  placeholder="每种地址族一个，逗号分隔"
                  required
                />
                <small>
                  自动识别节点公网 IP，可手动调整。客户端使用 IP 连接，域名仅用于 TLS / SNI。
                </small>
                {observed?.network?.addresses.map((item) => (
                  <small key={item.address}>
                    <span className="mono">{item.address}</span> ·{" "}
                    {item.source === "interface"
                      ? `${item.interface || "网卡"} / ip a`
                      : "ip.sb 出口探测"}
                  </small>
                ))}
                {observed?.network && (
                  <small>
                    {observed.network.addresses.length
                      ? "地址探测"
                      : "未探测到公网 IP，请手动填写或刷新扫描"}{" "}
                    · {when(observed.network.checkedAt)}
                  </small>
                )}
              </label>
              <label className="field">
                防火墙策略
                <select
                  name="firewall"
                  disabled={!host.data || busy}
                  value={firewallValue}
                  onChange={(e) =>
                    setHostDraft({
                      id: selectedId,
                      addresses: addressValue,
                      firewall: e.target.value,
                    })
                  }
                >
                  <option value="existing">管理已启用的 UFW</option>
                  <option value="enable">安装并启用 UFW（自动保留 SSH）</option>
                  <option value="external">由外部管理</option>
                </select>
                <small>云厂商安全组需单独放行；HTTP-01 需要 TCP 80。</small>
              </label>
            </div>
            <div className="stack mt-4 border-t pt-4">
              <div className="row between">
                <div className="row text-sm">
                  <span>UFW 实际状态</span>
                  <strong
                    className={
                      ufwState === "active"
                        ? "success"
                        : ufwState === "error"
                          ? "error-text"
                          : "muted"
                    }
                  >
                    {ufwLabel}
                  </strong>
                </div>
                <small className="muted">
                  {observed?.checkedAt
                    ? `更新于 ${when(observed.checkedAt)}`
                    : "刷新节点扫描可获取最新状态"}
                </small>
              </div>
              {!!host.data?.firewall_desired_version && (
                <small className="muted">
                  已有出口 UFW 同步版本 {host.data.firewall_applied_version ?? 0} /{" "}
                  {host.data.firewall_desired_version}
                </small>
              )}
              {observed?.ufw && (
                <details className="text-sm">
                  <summary className="cursor-pointer muted">查看 UFW 状态与规则</summary>
                  <pre className="code-block mt-3 whitespace-pre-wrap break-all">
                    {observed.ufw}
                  </pre>
                </details>
              )}
            </div>
            <div className="form-actions">
              <Button
                type="button"
                variant="outline"
                disabled={
                  busy ||
                  jobsRunning ||
                  (!local.length &&
                    !exits.data?.some(
                      (exit) => exit.source === "imported" && exit.server_id === selectedId,
                    ))
                }
                onClick={() => void act(() => api(`proxy/hosts/${selectedId}/apply`, "POST", {}))}
              >
                重新应用配置
              </Button>
              <Button
                disabled={!host.data || busy || jobsRunning || !server?.info.proxy}
                type="submit"
              >
                保存节点设置
              </Button>
            </div>
          </form>
        </details>
      )}
      <section className="panel">
        <div className="panel-header">
          <h2 className="row">
            <IconNetwork size={18} />
            已管理的代理
          </h2>
          <small className="muted">{local.length} 个实例</small>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>服务</th>
                <th>入口 / 端口</th>
                <th>出站策略</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {local.map((item) => {
                const observed = host.data?.observed?.instances?.find((i) => i.id === item.id);
                return (
                  <tr key={item.id}>
                    <td>
                      {item.name}
                      <span className="subline">{names[item.kind]}</span>
                    </td>
                    <td className="mono">
                      {host.data?.addresses.length
                        ? host.data.addresses.map((address) => (
                            <span className="block" key={address}>
                              {address.includes(":") ? `[${address}]` : address}:{item.spec.port}
                            </span>
                          ))
                        : "等待公网 IP"}
                      {item.spec.domain && <span className="subline">SNI：{item.spec.domain}</span>}
                      {observed?.certificate?.notAfter && (
                        <span className="subline">证书至 {observed.certificate.notAfter}</span>
                      )}
                    </td>
                    <td>
                      {item.spec.defaultOutbound === "direct"
                        ? "直接出网"
                        : (exits.data?.find((i) => i.id === item.spec.defaultOutbound)?.name ??
                          "出口不可用")}
                      <span className="subline">{item.spec.rules.length} 条分流规则</span>
                    </td>
                    <td>
                      <span
                        className={
                          item.state === "failed"
                            ? "error-text"
                            : item.state === "active"
                              ? "success"
                              : "muted"
                        }
                      >
                        {states[item.state] || item.state}
                      </span>
                      {observed && <span className="subline">服务：{observed.state}</span>}
                      {item.error && <span className="subline error-text">{item.error}</span>}
                    </td>
                    <td>
                      <div className="row">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy || jobsRunning}
                          onClick={() => setEditing(item)}
                        >
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            void act(async () => {
                              const credentials = await api<Record<string, string>>(
                                `proxy/instances/${item.id}/credentials`,
                                "POST",
                                {},
                              );
                              setDetail({
                                title: `${item.name} · 客户端配置`,
                                value: {
                                  protocol: item.kind,
                                  server: host.data?.addresses[0],
                                  addresses: host.data?.addresses,
                                  port: item.spec.port,
                                  serverName: item.spec.domain,
                                  ...(item.kind === "reality"
                                    ? {
                                        flow: "xtls-rprx-vision",
                                        fingerprint: "chrome",
                                        testedClient:
                                          "Xray 26.11.9（旧版 REALITY / sing-box 1.14.4 客户端不兼容）",
                                      }
                                    : {}),
                                  ...credentials,
                                },
                              });
                            })
                          }
                        >
                          连接参数
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy || jobsRunning}
                          onClick={() =>
                            void act(() => api(`proxy/instances/${item.id}`, "DELETE"))
                          }
                        >
                          卸载
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!local.length && (
          <p className="panel-body muted text-sm">
            在落地服务器安装 SS2022，或将扫描到的已有服务添加为出口，再为入口选择出站策略。
          </p>
        )}
      </section>
      <DeploymentJobs jobs={host.data?.jobs ?? []} />
      {!!entrances.data?.some((item) => item.server_id === selectedId) && (
        <section className="panel section-gap">
          <div className="panel-header">
            <h2>已添加的已有服务入口</h2>
            <Link href="/subscriptions" className="muted text-sm">
              代理订阅
            </Link>
          </div>
          <div className="panel-body">
            <ul className="plain-list">
              {entrances.data
                .filter((item) => item.server_id === selectedId)
                .map((item) => (
                  <li className="row between" key={item.id}>
                    <div>
                      <strong className="font-medium">{item.name}</strong>
                      <span className="subline">
                        {subscriptionProtocols[item.kind]} · {item.spec.port} · SNI：
                        {item.spec.domain}
                      </span>
                      <span
                        className={
                          item.state === "active" && item.addresses?.length
                            ? "subline success"
                            : "subline error-text"
                        }
                      >
                        {!item.addresses?.length
                          ? states.missing_address
                          : item.state === "active"
                            ? "可在代理订阅中选择"
                            : states[item.state] || item.state}
                      </span>
                    </div>
                    <div className="row">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || jobsRunning}
                        onClick={() =>
                          setImportingEntrance({
                            importId: item.import_id,
                            candidateKey: item.candidate_key,
                          })
                        }
                      >
                        更新入口引用
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void act(() => api(`proxy/entrances/${item.id}`, "DELETE"))}
                      >
                        移除入口引用
                      </Button>
                    </div>
                  </li>
                ))}
            </ul>
          </div>
        </section>
      )}
      {!!exits.data?.some(
        (item) => item.source === "imported" && item.server_id === selectedId,
      ) && (
        <section className="panel section-gap">
          <div className="panel-header">
            <h2>已添加的已有服务出口</h2>
          </div>
          <ul className="plain-list panel-body">
            {exits.data
              .filter((item) => item.source === "imported" && item.server_id === selectedId)
              .map((item) => (
                <li className="row between" key={item.id}>
                  <div>
                    <strong className="font-medium">{item.name}</strong>
                    <span className="subline mono">
                      {item.addresses
                        ?.map(
                          (address) =>
                            `${address.includes(":") ? `[${address}]` : address}:${item.port}`,
                        )
                        .join(" / ")}{" "}
                      · {item.method}
                    </span>
                    <span
                      className={item.state === "active" ? "subline success" : "subline error-text"}
                    >
                      {item.state === "active"
                        ? "可用作其他节点的默认出口或规则出口"
                        : states[item.state] || item.state}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void act(() => api(`proxy/exits/${item.id}`, "DELETE"))}
                  >
                    移除出口引用
                  </Button>
                </li>
              ))}
          </ul>
        </section>
      )}
      <section className="panel section-gap">
        <div className="panel-header">
          <h2>已有服务扫描</h2>
          <small className="muted">最近扫描 {when(host.data?.scanned_at ?? null)}</small>
        </div>
        <div className="panel-body">
          <p className="muted text-sm mb-4">
            读取实际启动配置、多文件来源及关联 Web 服务，配置快照加密保存。兼容的 Shadowsocks /
            SS2022 服务可添加为出口；AnyTLS、VLESS（TLS / XTLS /
            REALITY）可添加为入口并用于代理订阅。
          </p>
          <ul className="plain-list">
            {host.data?.imports.map((item) => (
              <li key={item.id} className="row between">
                <div>
                  <strong className="font-medium">
                    {item.summary.unit || item.summary.engine}
                  </strong>
                  <span className="subline">
                    {item.summary.active ? "运行中" : "配置文件"} ·{" "}
                    {item.summary.inbounds
                      .map(
                        (i) => `${i.reality ? "REALITY" : i.protocol}${i.port ? `:${i.port}` : ""}`,
                      )
                      .join(" / ") || item.summary.engine}
                  </span>
                  <span className="subline mono">{item.summary.paths.join(", ")}</span>
                  {item.summary.engine === "mihomo" && (
                    <span className="subline">
                      Mihomo · {item.summary.mode} · {item.summary.proxyCount ?? 0} 个代理 ·{" "}
                      {item.summary.proxyGroupCount ?? 0} 个策略组 · {item.summary.ruleCount ?? 0}{" "}
                      条规则
                    </span>
                  )}
                  {item.summary.warnings.map((w) => (
                    <span className="subline" key={w}>
                      {w}
                    </span>
                  ))}
                </div>
                <div className="row">
                  {!item.summary.managed && ["xray", "sing-box"].includes(item.summary.engine) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || jobsRunning}
                      onClick={() => setImportingEntrance({ importId: item.id })}
                    >
                      添加为入口
                    </Button>
                  )}
                  {!item.summary.managed &&
                    ["xray", "sing-box", "mihomo"].includes(item.summary.engine) && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || jobsRunning}
                        onClick={() => setImporting(item)}
                      >
                        添加为出口
                      </Button>
                    )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void act(async () =>
                        setDetail({
                          title: `${item.summary.engine} · 已导入配置`,
                          value: await api(`proxy/imports/${item.id}`),
                        }),
                      )
                    }
                  >
                    查看配置
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {!host.data?.imports.length && (
            <p className="muted text-sm">暂无扫描记录。启用部署器后首次接入会自动扫描。</p>
          )}
        </div>
      </section>
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? "安装代理服务" : "编辑代理服务"}</DialogTitle>
            <DialogDescription>
              REALITY 使用 TCP 443 → 本机 Caddy TLS 站点。证书通过 HTTP-01 自动续期。
            </DialogDescription>
          </DialogHeader>
          {editing && selectedId && (
            <ProxyForm
              key={editing === "new" ? selectedId : editing.id}
              serverId={selectedId}
              instance={editing === "new" ? undefined : editing}
              exits={exits.data?.filter((i) => i.server_id !== selectedId) ?? []}
              onSaved={() => {
                setEditing(null);
                void instances.refresh();
                void host.refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!importing}
        onOpenChange={(open) => {
          if (!open) setImporting(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>将已有代理添加为出口</DialogTitle>
            <DialogDescription>
              从加密扫描记录读取连接参数，添加后可在入口的默认出口和分流规则中选择。
            </DialogDescription>
          </DialogHeader>
          {importing && (
            <ImportedExitForm
              key={importing.id}
              imported={importing}
              serverName={server?.name ?? "已有代理"}
              hasAddress={!!host.data?.addresses.length}
              onSaved={() => {
                setImporting(null);
                void exits.refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!importingEntrance}
        onOpenChange={(open) => {
          if (!open) setImportingEntrance(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>将已有代理添加为入口</DialogTitle>
            <DialogDescription>
              复用扫描到的用户凭证和连接参数，添加后可在代理订阅中选择。
            </DialogDescription>
          </DialogHeader>
          {importingEntrance && (
            <ImportedEntranceForm
              key={`${importingEntrance.importId}:${importingEntrance.candidateKey ?? ""}`}
              {...importingEntrance}
              serverName={server?.name ?? "已有代理"}
              hasAddress={!!host.data?.addresses.length}
              onSaved={() => {
                setImportingEntrance(null);
                void entrances.refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{detail?.title}</DialogTitle>
            <DialogDescription>连接参数包含认证信息，请妥善保存。</DialogDescription>
          </DialogHeader>
          <pre className="code-block whitespace-pre-wrap break-all">
            {JSON.stringify(detail?.value, null, 2)}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DeploymentJobs({ jobs }: { jobs: Host["jobs"] }) {
  return (
    <section className="panel section-gap">
      <div className="panel-header">
        <h2>部署任务</h2>
        <small className="muted">配置校验 · 自动回滚 · 断线重试</small>
      </div>
      <div className="panel-body">
        <ul className="plain-list">
          {jobs.map((job) => (
            <li key={job.id}>
              <div className="row between">
                <strong className="font-medium">
                  {job.operation === "scan"
                    ? "扫描服务"
                    : job.operation === "firewall"
                      ? "同步出口 UFW"
                      : "应用节点配置"}
                </strong>
                <span
                  className={
                    job.state === "failed"
                      ? "error-text"
                      : job.state === "done"
                        ? "success"
                        : "muted"
                  }
                >
                  {states[job.state]}
                </span>
              </div>
              <span className="subline">
                {when(job.created_at)} ·{" "}
                {job.result?.error ||
                  job.result?.message ||
                  (job.state === "done" ? "节点配置已更新" : "等待节点完成")}
              </span>
              {job.result?.warnings?.map((warning) => (
                <span className="subline" key={warning}>
                  {warning}
                </span>
              ))}
            </li>
          ))}
        </ul>
        {!jobs.length && (
          <p className="muted text-sm">暂无部署任务。安装或修改服务后，可在这里查看执行结果。</p>
        )}
      </div>
    </section>
  );
}

function ImportedExitForm({
  imported,
  serverName,
  hasAddress,
  onSaved,
}: {
  imported: Imported;
  serverName: string;
  hasAddress: boolean;
  onSaved: () => void;
}) {
  type Candidate = {
    key: string;
    label: string;
    port: number;
    method: string;
    reason: string;
    existing: { id: string; name: string; state: string } | null;
  };
  const candidates = useResource<Candidate[]>(`proxy/imports/${imported.id}/exits`);
  const [chosen, setChosen] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const selected =
    chosen || candidates.data?.find((item) => !item.reason)?.key || candidates.data?.[0]?.key || "";
  const candidate = candidates.data?.find((item) => item.key === selected);
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        const data = new FormData(event.currentTarget);
        try {
          await api(`proxy/imports/${imported.id}/exits`, "POST", {
            candidateKey: selected,
            name: data.get("name"),
          });
          onSaved();
        } catch (error) {
          setError((error as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        出口名称
        <Input name="name" required maxLength={100} defaultValue={`${serverName} · 已有代理`} />
      </label>
      <label className="field">
        已有代理服务
        <select
          aria-label="已有代理服务"
          value={selected}
          onChange={(event) => setChosen(event.target.value)}
          disabled={busy || !candidates.data?.length}
        >
          <option value="" disabled>
            选择扫描到的服务
          </option>
          {candidates.data?.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label} · {item.method}
              {item.existing ? " · 已添加" : ""}
            </option>
          ))}
        </select>
      </label>
      {!hasAddress && (
        <p className="notice text-sm">请先在节点连接设置中保存出口服务器的公网 IP。</p>
      )}
      {candidate?.reason && <p className="notice text-sm">{candidate.reason}</p>}
      {candidates.data && !candidates.data.length && (
        <p className="notice text-sm">此配置没有可识别的 Shadowsocks / SS2022 入站。</p>
      )}
      <ErrorBanner error={error || candidates.error} />
      <Button type="submit" disabled={busy || !candidate || !!candidate.reason || !hasAddress}>
        {busy ? "正在添加…" : candidate?.existing ? "更新出口引用" : "确认添加出口"}
      </Button>
    </form>
  );
}

function ProxyForm({
  serverId,
  instance,
  exits,
  onSaved,
}: {
  serverId: string;
  instance?: Instance;
  exits: Exit[];
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<ProxySpec["kind"]>(instance?.kind || "reality"),
    [defaultOutbound, setDefaultOutbound] = useState(instance?.spec.defaultOutbound ?? "direct"),
    [rules, setRules] = useState<ProxySpec["rules"]>(instance?.spec.rules ?? []),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  function exitOptions(selected: string) {
    return (
      <>
        <option value="direct">直接出网</option>
        {exits.map((i) => (
          <option value={i.id} key={i.id} disabled={i.state !== "active"}>
            {i.name} · {i.server_name} · {i.source === "imported" ? "已有服务" : "面板部署"}
            {i.state !== "active" ? ` · ${states[i.state] || i.state}` : ""}
          </option>
        ))}
        {selected !== "direct" && !exits.some((item) => item.id === selected) && (
          <option value={selected} disabled>
            原出口不可用，请重新选择
          </option>
        )}
      </>
    );
  }
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        const f = new FormData(e.currentTarget);
        try {
          await api(
            `proxy/instances${instance ? `/${instance.id}` : ""}`,
            instance ? "PATCH" : "POST",
            {
              serverId,
              kind,
              name: f.get("name"),
              port: Number(f.get("port")),
              domain: f.get("domain") || "",
              fallbackPort: Number(f.get("fallbackPort") || 8003),
              upstream: f.get("upstream") || "",
              defaultOutbound: kind === "shadowsocks2022" ? "direct" : f.get("outbound"),
              rules:
                kind === "shadowsocks2022"
                  ? []
                  : rules.map((r) => ({
                      ...r,
                      values: r.values.map((v) => v.trim()).filter(Boolean),
                    })),
              manageDns: f.get("manageDns") === "on",
              enabled: f.get("enabled") === "on",
              udp: kind === "shadowsocks2022" ? f.get("udp") === "on" : true,
            },
          );
          onSaved();
        } catch (error) {
          setError((error as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid">
        <label className="field">
          名称
          <Input name="name" required maxLength={100} defaultValue={instance?.name} />
        </label>
        <label className="field">
          协议
          <select
            aria-label="协议"
            value={kind}
            disabled={!!instance}
            onChange={(e) => setKind(e.target.value as ProxySpec["kind"])}
          >
            {Object.entries(names).map(([key, value]) => (
              <option key={key} value={key}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          监听端口
          <Input
            key={kind}
            name="port"
            type="number"
            min={1}
            max={65535}
            required
            readOnly={kind === "reality"}
            defaultValue={instance?.spec.port ?? (kind === "shadowsocks2022" ? 8388 : 443)}
          />
        </label>
        {kind !== "shadowsocks2022" && (
          <label className="field">
            证书域名 / SNI
            <Input
              name="domain"
              placeholder="hk01.example.com"
              required
              defaultValue={instance?.spec.domain}
            />
            <small>用于证书验证和 TLS 握手，客户端连接地址为节点公网 IP。</small>
          </label>
        )}
        {kind !== "shadowsocks2022" && (
          <>
            <label className="field">
              {kind === "reality" ? "本机 Caddy TLS 端口" : "本机 AnyTLS 内部端口"}
              <Input
                name="fallbackPort"
                type="number"
                min={1024}
                max={65535}
                defaultValue={instance?.spec.fallbackPort ?? 8003}
                required
              />
              {kind === "anytls" && <small>仅监听本机，公网端口同时提供代理和网页访问。</small>}
            </label>
            <label className="field">
              伪装网站上游
              <Input
                name="upstream"
                type="url"
                placeholder="https://www.example.com"
                defaultValue={instance?.spec.upstream}
                required={kind === "reality"}
              />
              {kind === "anytls" && (
                <small>可选。留空显示默认欢迎页；填写后反向代理该 HTTPS 网站。</small>
              )}
            </label>
          </>
        )}
        {kind !== "shadowsocks2022" && (
          <label className="field full">
            默认出口
            <select
              name="outbound"
              aria-label="默认出口"
              value={defaultOutbound}
              onChange={(event) => setDefaultOutbound(event.target.value)}
            >
              {exitOptions(defaultOutbound)}
            </select>
          </label>
        )}
      </div>
      <div className="row">
        <label className="row text-sm">
          <input type="checkbox" name="enabled" defaultChecked={instance?.spec.enabled ?? true} />
          启用服务
        </label>
        {kind !== "shadowsocks2022" && (
          <label className="row text-sm">
            <input
              type="checkbox"
              name="manageDns"
              defaultChecked={instance?.spec.manageDns ?? true}
            />
            自动维护 Cloudflare DNS
          </label>
        )}
        {kind === "shadowsocks2022" && (
          <label className="row text-sm">
            <input type="checkbox" name="udp" defaultChecked={instance?.spec.udp ?? true} />
            启用 UDP
          </label>
        )}
      </div>
      {kind !== "shadowsocks2022" && (
        <>
          <div className="row between">
            <h3>分流规则</h3>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                setRules([...rules, { match: "domain_suffix", values: [], outbound: "direct" }])
              }
            >
              添加规则
            </Button>
          </div>
          <p className="muted text-xs">
            按列表从上到下匹配，未命中使用默认出口。每行一个域名或 CIDR。
          </p>
          {rules.map((rule, index) => (
            <div className="stack border-t pt-3" key={index}>
              <div className="row">
                <select
                  aria-label={`规则 ${index + 1} 类型`}
                  value={rule.match}
                  onChange={(e) =>
                    setRules(
                      rules.map((r, i) =>
                        i === index ? { ...r, match: e.target.value as typeof r.match } : r,
                      ),
                    )
                  }
                >
                  <option value="domain">完整域名</option>
                  <option value="domain_suffix">域名及子域名</option>
                  <option value="ip_cidr">IP / CIDR</option>
                </select>
                <select
                  aria-label={`规则 ${index + 1} 出口`}
                  value={rule.outbound}
                  onChange={(e) =>
                    setRules(
                      rules.map((r, i) => (i === index ? { ...r, outbound: e.target.value } : r)),
                    )
                  }
                >
                  {exitOptions(rule.outbound)}
                </select>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!index}
                  onClick={() => {
                    const next = [...rules];
                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                    setRules(next);
                  }}
                >
                  上移
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setRules(rules.filter((_, i) => i !== index))}
                >
                  删除
                </Button>
              </div>
              <Textarea
                aria-label={`规则 ${index + 1} 匹配值`}
                required
                value={rule.values.join("\n")}
                onChange={(e) =>
                  setRules(
                    rules.map((r, i) =>
                      i === index ? { ...r, values: e.target.value.split("\n") } : r,
                    ),
                  )
                }
              />
            </div>
          ))}
        </>
      )}
      <ErrorBanner error={error} />
      <Button type="submit" disabled={busy}>
        {busy ? "提交部署…" : instance ? "保存并应用" : "安装并应用"}
      </Button>
    </form>
  );
}
