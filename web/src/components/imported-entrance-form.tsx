"use client";
import { useState } from "react";
import { api, useResource } from "@/lib/client";
import { subscriptionProtocols } from "@/lib/subscriptions";
import type { EntranceKind } from "@/server/proxy-entrances";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ErrorBanner } from "./common";

type Candidate = {
  key: string;
  label: string;
  kind: EntranceKind;
  port: number;
  domain: string;
  domains: string[];
  flow: string;
  reason: string;
  existing: { id: string; name: string; spec: { domain: string }; state: string } | null;
};

export function ImportedEntranceForm({
  importId,
  candidateKey,
  serverName,
  hasAddress,
  onSaved,
}: {
  importId: string;
  candidateKey?: string;
  serverName: string;
  hasAddress: boolean;
  onSaved: () => void;
}) {
  const candidates = useResource<Candidate[]>(`proxy/imports/${importId}/entrances`);
  const [chosen, setChosen] = useState(candidateKey ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selected =
    chosen || candidates.data?.find((item) => !item.reason)?.key || candidates.data?.[0]?.key || "";
  const candidate = candidates.data?.find((item) => item.key === selected);
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setBusy(true);
        setError("");
        try {
          await api(`proxy/imports/${importId}/entrances`, "POST", {
            candidateKey: selected,
            name: data.get("name"),
            domain: data.get("domain"),
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
        已有入口服务 / 用户
        <select
          aria-label="已有入口服务 / 用户"
          value={selected}
          disabled={busy || !candidates.data?.length}
          onChange={(event) => setChosen(event.target.value)}
        >
          <option value="" disabled>
            选择扫描到的入口
          </option>
          {candidates.data?.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label} · {subscriptionProtocols[item.kind]}
              {item.existing ? " · 已添加" : ""}
            </option>
          ))}
        </select>
      </label>
      <div key={candidate?.key ?? "loading"} className="stack">
        <label className="field">
          入口名称
          <Input
            name="name"
            required
            maxLength={100}
            disabled={busy}
            defaultValue={candidate?.existing?.name ?? `${serverName} · 已有入口`}
          />
        </label>
        <label className="field">
          TLS / REALITY 域名（SNI）
          {candidate?.domains.length ? (
            <select
              name="domain"
              aria-label="TLS / REALITY 域名（SNI）"
              required
              disabled={busy}
              defaultValue={
                candidate.domains.includes(candidate.existing?.spec.domain ?? "")
                  ? candidate.existing!.spec.domain
                  : candidate.domain
              }
            >
              {candidate.domains.map((domain) => (
                <option key={domain} value={domain}>
                  {domain}
                </option>
              ))}
            </select>
          ) : (
            <Input
              name="domain"
              aria-label="TLS / REALITY 域名（SNI）"
              required
              maxLength={253}
              disabled={busy}
              placeholder="node.example.com"
              defaultValue={candidate?.existing?.spec.domain ?? candidate?.domain ?? ""}
            />
          )}
          <small>使用已有服务的证书域名或 REALITY SNI，客户端通过节点公网 IP 连接。</small>
        </label>
      </div>
      {candidate && (
        <p className="muted text-sm">
          端口 {candidate.port}
          {candidate.flow ? ` · ${candidate.flow}` : ""}
        </p>
      )}
      {!hasAddress && (
        <p className="notice text-sm">请先在节点连接设置中保存入口服务器的公网 IP。</p>
      )}
      {candidate?.reason && <p className="notice text-sm">{candidate.reason}</p>}
      {candidates.data && !candidates.data.length && (
        <p className="notice text-sm">
          此配置没有可识别的 AnyTLS 或 VLESS（TLS / XTLS / REALITY）入站。
        </p>
      )}
      <ErrorBanner error={error || candidates.error} />
      <Button type="submit" disabled={busy || !candidate || !!candidate.reason || !hasAddress}>
        {busy ? "正在添加…" : candidate?.existing ? "更新入口引用" : "确认添加入口"}
      </Button>
    </form>
  );
}
