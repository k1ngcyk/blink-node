"use client";
import { useState } from "react";
import { api, useResource } from "@/lib/client";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ErrorBanner } from "./common";

type Settings = { configured: boolean; zone_id: string; zone_name: string; acme_email: string };
export function ProxySettings() {
  const settings = useResource<Settings>("proxy/settings");
  const [token, setToken] = useState(""),
    [zones, setZones] = useState<{ id: string; name: string }[]>([]),
    [zone, setZone] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const available = zones.length
    ? zones
    : settings.data?.zone_id
      ? [{ id: settings.data.zone_id, name: settings.data.zone_name }]
      : [];
  return (
    <section className="panel section-gap">
      <div className="panel-header">
        <h2>代理节点 · DNS 与证书</h2>
        <small className="muted">Cloudflare DNS-only / 节点 HTTP-01</small>
      </div>
      <form
        className="panel-body stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setMessage("");
          const form = new FormData(e.currentTarget);
          const selected = available.find((z) => z.id === (zone || settings.data?.zone_id));
          try {
            if (!selected) throw new Error("请先读取并选择 Cloudflare 域名");
            await api("proxy/settings", "POST", {
              ...(token ? { token } : {}),
              zoneId: selected.id,
              zoneName: selected.name,
              acmeEmail: form.get("email"),
            });
            setToken("");
            setMessage("配置已保存，Token 加密保存于主控");
            void settings.refresh();
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted text-sm">
          Token 只用于创建、更新节点 A/AAAA 记录。证书由节点通过公网 TCP 80 自动申请、续期，无需
          DNS-01。
        </p>
        <div className="form-grid">
          <label className="field full">
            Cloudflare API Token
            <Input
              type="password"
              autoComplete="new-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                settings.data?.configured
                  ? "已配置；留空保留原 Token"
                  : "限定目标 Zone：DNS Edit + Zone Read"
              }
              maxLength={256}
            />
          </label>
          <label className="field">
            托管域名
            <select
              value={zone || settings.data?.zone_id || ""}
              onChange={(e) => setZone(e.target.value)}
              required
            >
              <option value="">选择域名</option>
              {available.map((z) => (
                <option value={z.id} key={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            ACME 联系邮箱
            <Input
              key={settings.data?.acme_email}
              name="email"
              type="email"
              defaultValue={settings.data?.acme_email}
              required
              placeholder="admin@example.com"
            />
          </label>
        </div>
        <ErrorBanner error={error || settings.error} />
        {message && (
          <p role="status" className="success text-sm">
            {message}
          </p>
        )}
        <div className="row">
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const result = await api<{ id: string; name: string }[]>(
                  "proxy/zones",
                  "POST",
                  token ? { token } : {},
                );
                setZones(result);
                if (!result.length) throw new Error("Token 没有可访问的已激活域名");
                setZone(result[0].id);
              } catch (error) {
                setError((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            读取域名
          </Button>
          <Button disabled={busy} type="submit">
            保存 DNS 配置
          </Button>
        </div>
      </form>
    </section>
  );
}
