"use client";
import Link from "next/link";
import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { IconCheck, IconCopy, IconPlus, IconSearch } from "@tabler/icons-react";
import { api, useResource } from "@/lib/client";
import {
  subscriptionProtocols,
  shadowrocketSubscriptionUri,
  type ProxySubscription,
  type SubscriptionData,
  type SubscriptionAccess,
} from "@/lib/subscriptions";
import { when } from "@/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Empty, ErrorBanner, Loading } from "./common";
import { MoreActions } from "./more-actions";

const endpoint = "proxy/subscriptions";
type Draft = {
  name: string;
  displayName: string;
  nodeDisplayNames: Record<string, string>;
  enabled: boolean;
  nodeIds: string[];
  encryptionPassword?: string;
};
type Shared = SubscriptionAccess & { id: string; name: string };

function SubscriptionEditor({
  value,
  nodes,
  onSave,
  onClose,
}: {
  value: ProxySubscription | "new";
  nodes: SubscriptionData["nodes"];
  onSave: (draft: Draft) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(value === "new" ? "" : value.name);
  const [displayName, setDisplayName] = useState(value === "new" ? "" : (value.displayName ?? ""));
  const [nodeDisplayNames, setNodeDisplayNames] = useState<Record<string, string>>(
    value === "new"
      ? {}
      : Object.fromEntries(
          value.nodes.flatMap((node) =>
            node.instanceId ? [[node.instanceId, node.displayName ?? ""]] : [],
          ),
        ),
  );
  const [enabled, setEnabled] = useState(value === "new" ? true : value.enabled);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [selected, setSelected] = useState<string[]>(
    value === "new"
      ? []
      : value.nodes.flatMap((node) => (node.instanceId ? [node.instanceId] : [])),
  );
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const filtered = nodes.filter((node) =>
    `${node.name} ${nodeDisplayNames[node.instanceId] ?? ""} ${node.serverName} ${node.address ?? ""} ${node.kind ? subscriptionProtocols[node.kind] : ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const selectable = filtered.filter((node) => !node.reason).map((node) => node.instanceId);
  const available = nodes.filter(
    (node) => selected.includes(node.instanceId) && !node.reason,
  ).length;
  const deleted = value === "new" ? [] : value.nodes.filter((node) => !node.instanceId);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl max-h-[90dvh] overflow-auto">
        <DialogHeader>
          <DialogTitle>{value === "new" ? "创建订阅" : "编辑订阅"}</DialogTitle>
          <DialogDescription>
            选择 REALITY / AnyTLS 入口，客户端更新订阅时自动获取最新连接配置。
          </DialogDescription>
        </DialogHeader>
        <form
          className="stack"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              await onSave({
                name: name.trim(),
                displayName: displayName.trim(),
                nodeDisplayNames: Object.fromEntries(
                  selected.map((id) => [id, (nodeDisplayNames[id] ?? "").trim()]),
                ),
                enabled,
                nodeIds: selected,
                encryptionPassword: password || undefined,
              });
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="field">
              订阅名称
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：日常使用"
                required
                maxLength={100}
                disabled={busy}
              />
            </label>
            <label className="field">
              Shadowrocket 订阅名称
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={name.trim() || "留空使用订阅名称"}
                maxLength={100}
                disabled={busy}
              />
            </label>
          </div>
          <p className="text-xs muted">
            客户端名称用于二维码和订阅标题，留空使用订阅名称。已有订阅可重新扫码同步名称。
          </p>
          <label className="row">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={busy}
            />
            启用订阅
          </label>
          <fieldset disabled={busy} className="min-w-0 space-y-3">
            <legend className="mb-3 text-sm font-medium">订阅加密 · 必需</legend>
            <label className="field">
              加密密码
              <Input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={value !== "new" ? "留空保留现有密码" : "16–128 个字符，建议随机生成"}
                autoComplete="new-password"
                spellCheck={false}
                required={value === "new"}
                minLength={16}
                maxLength={128}
              />
            </label>
            <div className="row">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setPassword(
                    Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
                      byte.toString(16).padStart(2, "0"),
                    ).join(""),
                  );
                  setShowPassword(true);
                }}
              >
                生成随机密码
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-pressed={showPassword}
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? "隐藏密码" : "显示密码"}
              </Button>
            </div>
            <p className="text-xs muted">
              所有订阅均加密。保存后可用 Shadowrocket 扫码导入，或手动填写 Subscribe → Password。
              {value !== "new" && "更换密码后，请重新扫码或更新客户端的 Password。"}
            </p>
          </fieldset>
          <fieldset disabled={busy} className="min-w-0">
            <legend className="mb-3 text-sm font-medium">
              入口节点 · 已选 {selected.length} 个
            </legend>
            <p className="text-xs muted mb-3">
              勾选节点后可设置客户端显示名称；留空使用「服务器 · 节点」名称。
            </p>
            <div className="row between mb-3">
              <div className="search">
                <IconSearch size={16} />
                <Input
                  aria-label="搜索入口节点"
                  placeholder="搜索节点、服务器、IP 或协议"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="row">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!selectable.length}
                  onClick={() =>
                    setSelected((current) => [...new Set([...current, ...selectable])])
                  }
                >
                  全选可用
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!selected.length}
                  onClick={() => setSelected([])}
                >
                  清空
                </Button>
              </div>
            </div>
            <div className="max-h-[38dvh] overflow-auto rounded-md border divide-y">
              {filtered.map((node) => (
                <div key={node.instanceId} className="p-3 space-y-3 hover:bg-accent/30">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      className="mt-1"
                      type="checkbox"
                      checked={selected.includes(node.instanceId)}
                      disabled={!!node.reason && !selected.includes(node.instanceId)}
                      onChange={(e) =>
                        setSelected((current) =>
                          e.target.checked
                            ? [...current, node.instanceId]
                            : current.filter((id) => id !== node.instanceId),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words">
                        {node.name} <span className="muted font-normal">· {node.serverName}</span>
                      </span>
                      <span className="block text-xs muted font-normal break-all mt-1">
                        {node.kind && subscriptionProtocols[node.kind]} ·{" "}
                        {node.address
                          ? `${node.address.includes(":") ? `[${node.address}]` : node.address}:${node.port}`
                          : "缺少公网 IP"}
                      </span>
                      {node.reason && (
                        <span className="block text-xs warning font-normal mt-1">
                          {node.reason} · 暂停输出
                        </span>
                      )}
                    </span>
                  </label>
                  {selected.includes(node.instanceId) && (
                    <label className="field ml-6">
                      <span className="text-xs muted">客户端显示名称</span>
                      <Input
                        aria-label={`${node.name} 的客户端显示名称`}
                        placeholder={`${node.serverName} · ${node.name}`}
                        value={nodeDisplayNames[node.instanceId] ?? ""}
                        onChange={(e) =>
                          setNodeDisplayNames((current) => ({
                            ...current,
                            [node.instanceId]: e.target.value,
                          }))
                        }
                        maxLength={100}
                      />
                    </label>
                  )}
                </div>
              ))}
              {!filtered.length && (
                <p className="p-5 muted text-sm">
                  {nodes.length ? (
                    "没有匹配的入口节点"
                  ) : (
                    <>
                      还没有入口节点，先到
                      <Link href="/proxies" className="text-primary underline">
                        代理服务
                      </Link>
                      安装 REALITY 或 AnyTLS。
                    </>
                  )}
                </p>
              )}
            </div>
          </fieldset>
          {!!deleted.length && (
            <p className="text-sm warning">
              {deleted.map((node) => node.displayName || node.name).join("、")}{" "}
              已删除，保存后从订阅中移除。
            </p>
          )}
          <p className="text-xs muted">
            当前可输出 {available} / {selected.length}{" "}
            个入口。停用或部署中的已选节点会暂时跳过，恢复后自动加入。
          </p>
          <ErrorBanner error={error} />
          <div className="form-actions">
            <Button variant="outline" type="button" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button
              type="submit"
              disabled={busy || !name.trim() || !selected.length || (value === "new" && !password)}
            >
              {busy ? "正在保存…" : value === "new" ? "创建订阅" : "保存修改"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Subscriptions() {
  const resource = useResource<SubscriptionData>(endpoint, 10000);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<ProxySubscription | "new" | null>(null);
  const [shared, setShared] = useState<Shared | null>(null);
  const [confirmation, setConfirmation] = useState<{
    item: ProxySubscription;
    action: "rotate" | "delete";
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const [copyError, setCopyError] = useState("");
  const [copied, setCopied] = useState(false);
  const [passwordCopied, setPasswordCopied] = useState(false);
  const [showSharedPassword, setShowSharedPassword] = useState(false);
  const [message, setMessage] = useState("");
  const subscriptions = resource.data?.subscriptions ?? [];
  const filtered = subscriptions.filter((item) =>
    `${item.name} ${item.displayName ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  function showLink(value: Shared) {
    setCopied(false);
    setPasswordCopied(false);
    setShowSharedPassword(false);
    setCopyError("");
    setShared(value);
  }
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      resource.refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>代理订阅</h1>
          <p>把入口节点整理成加密订阅，在 Shadowrocket 中扫码导入和更新。</p>
        </div>
        <Button
          disabled={resource.loading || !resource.data || busy}
          onClick={() => setEditing("new")}
        >
          <IconPlus size={17} />
          创建订阅
        </Button>
      </div>
      <ErrorBanner error={error || resource.error} retry={resource.refresh} />
      {message && (
        <p role="status" className="success text-sm mb-4">
          {message}
        </p>
      )}
      {resource.loading ? (
        <Loading />
      ) : (
        <section className="panel">
          <div className="panel-header">
            <h2>
              订阅 <span className="muted text-xs ml-2 font-normal">{subscriptions.length}</span>
            </h2>
            <span className="muted text-xs">Shadowrocket · 强制加密</span>
          </div>
          {!!subscriptions.length && (
            <div className="toolbar">
              <div className="search">
                <IconSearch size={16} />
                <Input
                  aria-label="搜索订阅"
                  placeholder="搜索订阅名称"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
          )}
          {!subscriptions.length ? (
            <Empty
              title="创建你的第一个订阅"
              description="勾选已部署的入口节点，生成可以持续更新的订阅链接。"
              action={
                <Button
                  variant="outline"
                  disabled={!resource.data}
                  onClick={() => setEditing("new")}
                >
                  <IconPlus size={16} />
                  选择入口节点
                </Button>
              }
            />
          ) : !filtered.length ? (
            <Empty
              title="没有匹配的订阅"
              description="试试其他名称，或清除搜索条件。"
              action={
                <Button variant="outline" onClick={() => setSearch("")}>
                  清除搜索
                </Button>
              }
            />
          ) : (
            <ul className="divide-y">
              {filtered.map((item) => {
                const available = item.nodes.filter((node) => !node.reason).length;
                return (
                  <li
                    key={item.id}
                    className="px-5 py-5 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="row">
                        <h3 className="break-all">{item.name}</h3>
                        <span className={`status ${item.enabled ? "online" : "revoked"}`}>
                          {item.enabled ? "已启用" : "已停用"}
                        </span>
                        {item.encrypted && <span className="status">已加密</span>}
                      </div>
                      {item.displayName && (
                        <p className="text-xs muted mt-2 break-words">
                          客户端名称：{item.displayName}
                        </p>
                      )}
                      <p className="text-xs muted mt-2">
                        {available} / {item.nodes.length} 个入口可输出 · 更新于{" "}
                        {when(item.updatedAt)}
                      </p>
                      {available < item.nodes.length && (
                        <details className="mt-2 text-xs warning">
                          <summary className="cursor-pointer">
                            {item.nodes.length - available} 个入口暂停输出
                          </summary>
                          <ul className="mt-1 space-y-1">
                            {item.nodes
                              .filter((node) => node.reason)
                              .map((node, index) => (
                                <li key={node.instanceId ?? `deleted-${index}`}>
                                  {node.displayName || node.name}：{node.reason}
                                </li>
                              ))}
                          </ul>
                        </details>
                      )}
                    </div>
                    <div className="row shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const result = await api<SubscriptionAccess>(
                              `${endpoint}/${item.id}/link`,
                              "POST",
                              {},
                            );
                            showLink({ id: item.id, name: item.name, ...result });
                          })
                        }
                      >
                        <IconCopy size={14} />
                        订阅链接
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setEditing(item)}
                      >
                        编辑
                      </Button>
                      <MoreActions
                        label={`管理 ${item.name}`}
                        disabled={busy}
                        items={[
                          {
                            label: item.enabled ? "停用订阅" : "启用订阅",
                            onSelect: () =>
                              void act(async () => {
                                await api(`${endpoint}/${item.id}`, "PATCH", {
                                  enabled: !item.enabled,
                                });
                                setMessage(`「${item.name}」已${item.enabled ? "停用" : "启用"}`);
                              }),
                          },
                          {
                            label: "重置链接",
                            onSelect: () => {
                              setConfirmError("");
                              setConfirmation({ item, action: "rotate" });
                            },
                          },
                          {
                            label: "删除订阅",
                            destructive: true,
                            onSelect: () => {
                              setConfirmError("");
                              setConfirmation({ item, action: "delete" });
                            },
                          },
                        ]}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      {editing && (
        <SubscriptionEditor
          value={editing}
          nodes={resource.data?.nodes ?? []}
          onClose={() => setEditing(null)}
          onSave={async (draft) => {
            if (editing === "new") {
              const created = await api<SubscriptionAccess & { id: string }>(
                endpoint,
                "POST",
                draft,
              );
              setEditing(null);
              showLink({ ...created, name: draft.name });
            } else {
              await api(`${endpoint}/${editing.id}`, "PATCH", draft);
              setEditing(null);
              setMessage(
                draft.encryptionPassword ||
                  (draft.displayName || draft.name) !== (editing.displayName || editing.name)
                  ? `「${draft.name}」已保存，请重新扫码同步订阅名称与密码`
                  : `「${draft.name}」已保存，客户端更新订阅后生效`,
              );
            }
            resource.refresh();
          }}
        />
      )}
      <Dialog
        open={!!shared}
        onOpenChange={(open) => {
          if (!open) setShared(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>订阅链接</DialogTitle>
            <DialogDescription>
              {shared?.displayName} · 用 Shadowrocket 扫码导入，或手动填写名称、URL 和密码。
            </DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="qr">
            <TabsList className="w-full">
              <TabsTrigger value="qr">扫码导入</TabsTrigger>
              <TabsTrigger value="manual">手动复制</TabsTrigger>
            </TabsList>
            <TabsContent value="qr" className="space-y-3 pt-3">
              {shared && (
                <QRCodeSVG
                  value={shadowrocketSubscriptionUri(shared)}
                  size={288}
                  level="L"
                  boostLevel
                  marginSize={4}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  className="mx-auto max-w-full h-auto rounded-md"
                  role="img"
                  aria-label="Shadowrocket 订阅二维码"
                  title="Shadowrocket 订阅二维码"
                />
              )}
              <p className="text-sm text-center">打开 Shadowrocket，点击首页扫一扫。</p>
              <p className="text-xs muted text-center">
                二维码包含订阅链接和解密密码，仅在本地生成，请勿分享截图。
              </p>
            </TabsContent>
            <TabsContent value="manual" className="space-y-4 pt-3">
              <label className="field">
                订阅名称（Alias）
                <Input
                  value={shared?.displayName ?? ""}
                  readOnly
                  onFocus={(e) => e.target.select()}
                />
              </label>
              <label className="field">
                订阅 URL
                <Input
                  aria-label="订阅 URL"
                  className="mono text-xs"
                  value={shared?.url ?? ""}
                  readOnly
                  onFocus={(e) => e.target.select()}
                />
              </label>
              <p className="muted text-xs">
                将下方密码填入 Subscribe → Password。链接和密码请分别保管。
              </p>
              <ErrorBanner error={copyError} />
              <Button
                className="w-full"
                onClick={async () => {
                  if (!shared) return;
                  try {
                    await navigator.clipboard.writeText(shared.url);
                    setCopied(true);
                    setCopyError("");
                  } catch {
                    setCopyError("无法访问剪贴板，请手动选择并复制上方链接");
                  }
                }}
              >
                {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                {copied ? "已复制订阅链接" : "复制订阅链接"}
              </Button>
              {shared?.encryptionPassword && (
                <>
                  <label className="field">
                    订阅加密密码
                    <Input
                      type={showSharedPassword ? "text" : "password"}
                      className="mono text-xs"
                      value={shared.encryptionPassword}
                      readOnly
                      autoComplete="off"
                      onFocus={(e) => e.target.select()}
                    />
                  </label>
                  <div className="row">
                    <Button
                      variant="outline"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(shared.encryptionPassword);
                          setPasswordCopied(true);
                          setCopyError("");
                        } catch {
                          setCopyError("无法访问剪贴板，请显示密码后手动选择并复制");
                        }
                      }}
                    >
                      {passwordCopied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                      {passwordCopied ? "已复制密码" : "复制密码"}
                    </Button>
                    <Button
                      variant="ghost"
                      aria-pressed={showSharedPassword}
                      onClick={() => setShowSharedPassword(!showSharedPassword)}
                    >
                      {showSharedPassword ? "隐藏密码" : "显示密码"}
                    </Button>
                  </div>
                </>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmation?.action === "delete" ? "删除订阅" : "重置订阅链接"}
            </DialogTitle>
            <DialogDescription>
              {confirmation?.action === "delete"
                ? `删除「${confirmation.item.name}」后，原链接将无法继续更新订阅。`
                : `重置「${confirmation?.item.name}」后，旧链接立即失效，需要在客户端替换为新链接。`}
            </DialogDescription>
          </DialogHeader>
          <ErrorBanner error={confirmError} />
          <div className="row justify-end">
            <Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>
              取消
            </Button>
            <Button
              variant={confirmation?.action === "delete" ? "destructive" : "default"}
              disabled={busy}
              onClick={async () => {
                if (!confirmation) return;
                setBusy(true);
                setConfirmError("");
                try {
                  const { item, action } = confirmation;
                  if (action === "delete") {
                    await api(`${endpoint}/${item.id}`, "DELETE");
                    setMessage(`「${item.name}」已删除`);
                  } else {
                    const result = await api<SubscriptionAccess>(
                      `${endpoint}/${item.id}/rotate`,
                      "POST",
                      {},
                    );
                    showLink({ id: item.id, name: item.name, ...result });
                  }
                  setConfirmation(null);
                  resource.refresh();
                } catch (error) {
                  setConfirmError((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "正在处理…" : confirmation?.action === "delete" ? "删除订阅" : "重置链接"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
