"use client";
import Link from "next/link";
import { useState } from "react";
import { IconCheck, IconCopy, IconPlus, IconSearch } from "@tabler/icons-react";
import { api, useResource } from "@/lib/client";
import {
  subscriptionProtocols,
  type ProxySubscription,
  type SubscriptionData,
} from "@/lib/subscriptions";
import { when } from "@/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Empty, ErrorBanner, Loading } from "./common";

const endpoint = "proxy/subscriptions";
type Draft = { name: string; enabled: boolean; nodeIds: string[] };
type Shared = { id: string; name: string; url: string };

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
  const [enabled, setEnabled] = useState(value === "new" ? true : value.enabled);
  const [selected, setSelected] = useState<string[]>(
    value === "new"
      ? []
      : value.nodes.flatMap((node) => (node.instanceId ? [node.instanceId] : [])),
  );
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const filtered = nodes.filter((node) =>
    `${node.name} ${node.serverName} ${node.address ?? ""} ${node.kind ? subscriptionProtocols[node.kind] : ""}`
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
              await onSave({ name: name.trim(), enabled, nodeIds: selected });
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
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
          <label className="row">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={busy}
            />
            启用订阅
          </label>
          <fieldset disabled={busy} className="min-w-0">
            <legend className="mb-3 text-sm font-medium">
              入口节点 · 已选 {selected.length} 个
            </legend>
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
                <label
                  key={node.instanceId}
                  className="flex items-start gap-3 p-3 cursor-pointer hover:bg-accent/30"
                >
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
              {deleted.map((node) => node.name).join("、")} 已删除，保存后从订阅中移除。
            </p>
          )}
          <p className="text-xs muted">
            当前可输出 {available} / {selected.length}{" "}
            个入口。停用或部署中的已选节点会暂时跳过，恢复后自动加入。
          </p>
          <ErrorBanner error={error} />
          <div className="row justify-end">
            <Button variant="outline" type="button" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !selected.length}>
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
  const [message, setMessage] = useState("");
  const subscriptions = resource.data?.subscriptions ?? [];
  const filtered = subscriptions.filter((item) =>
    item.name.toLowerCase().includes(search.toLowerCase()),
  );
  function showLink(value: Shared) {
    setCopied(false);
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
          <p>把入口节点整理成订阅，在 Shadowrocket 等客户端中导入和更新。</p>
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
            <span className="muted text-xs">Shadowrocket · 通用链接格式</span>
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
                      </div>
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
                                  {node.name}：{node.reason}
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
                            const result = await api<{ url: string }>(
                              `${endpoint}/${item.id}/link`,
                              "POST",
                              {},
                            );
                            showLink({ id: item.id, name: item.name, url: result.url });
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
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api(`${endpoint}/${item.id}`, "PATCH", {
                              enabled: !item.enabled,
                            });
                            setMessage(`「${item.name}」已${item.enabled ? "停用" : "启用"}`);
                          })
                        }
                      >
                        {item.enabled ? "停用" : "启用"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setConfirmError("");
                          setConfirmation({ item, action: "rotate" });
                        }}
                      >
                        重置链接
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={busy}
                        onClick={() => {
                          setConfirmError("");
                          setConfirmation({ item, action: "delete" });
                        }}
                      >
                        删除
                      </Button>
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
              const created = await api<{ id: string; url: string }>(endpoint, "POST", draft);
              setEditing(null);
              showLink({ ...created, name: draft.name });
            } else {
              await api(`${endpoint}/${editing.id}`, "PATCH", draft);
              setEditing(null);
              setMessage(`「${draft.name}」已保存，客户端更新订阅后生效`);
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
              {shared?.name} · 在 Shadowrocket 中添加「Subscribe」类型，并粘贴下方 URL。
            </DialogDescription>
          </DialogHeader>
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
            此链接包含节点访问凭证，请仅保存在自己的客户端。节点选择或配置变化后，更新同一订阅即可。
          </p>
          <ErrorBanner error={copyError} />
          <Button
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
                    const result = await api<{ url: string }>(
                      `${endpoint}/${item.id}/rotate`,
                      "POST",
                      {},
                    );
                    showLink({ id: item.id, name: item.name, url: result.url });
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
