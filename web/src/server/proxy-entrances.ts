import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { hostname } from "./proxy-model";

export type EntranceKind = "reality" | "anytls" | "vless";
export type EntranceClient = {
  security: "reality" | "tls" | "xtls";
  flow: string;
  alpn: string[];
};
export type EntranceSpec = {
  enabled: boolean;
  domain: string;
  port: number;
  client: EntranceClient;
};
export type ImportedEntranceCandidate = {
  key: string;
  label: string;
  kind: EntranceKind;
  port: number;
  domain: string;
  domains: string[];
  client: EntranceClient;
  reason: string;
  credentials: Record<string, string>;
  fingerprint: string;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const strings = (value: unknown) =>
  (typeof value === "string" ? [value] : array(value)).filter(
    (item): item is string => typeof item === "string",
  );

function realityPublicKey(value: unknown) {
  const key = text(value);
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) return "";
  try {
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b656e04220420", "hex"),
        Buffer.from(key, "base64url"),
      ]),
      format: "der",
      type: "pkcs8",
    });
    return createPublicKey(privateKey).export({ format: "jwk" }).x ?? "";
  } catch {
    return "";
  }
}

// Only server inbounds become candidates; remote outbounds never become local entrances.
export function importedEntranceCandidates(
  engine: string,
  snapshot: unknown,
): ImportedEntranceCandidate[] {
  if (!["xray", "sing-box"].includes(engine)) return [];
  const config = object(object(snapshot).effective);
  const result: ImportedEntranceCandidate[] = [];
  for (const [index, value] of array(config.inbounds).slice(0, 100).entries()) {
    const inbound = object(value);
    const protocol = text(inbound.protocol ?? inbound.type);
    if (protocol !== "vless" && !(engine === "sing-box" && protocol === "anytls")) continue;
    const xray = engine === "xray";
    const settings = xray ? object(inbound.settings) : inbound;
    const stream = object(inbound.streamSettings);
    const tls = xray
      ? object(stream.security === "xtls" ? stream.xtlsSettings : stream.tlsSettings)
      : object(inbound.tls);
    const reality = xray ? object(stream.realitySettings) : object(tls.reality);
    const isReality = xray
      ? stream.security === "reality"
      : tls.enabled === true && reality.enabled === true;
    const kind: EntranceKind = protocol === "anytls" ? "anytls" : isReality ? "reality" : "vless";
    const security = isReality ? "reality" : stream.security === "xtls" ? "xtls" : "tls";
    const hasTls = xray
      ? ["tls", "xtls", "reality"].includes(text(stream.security))
      : tls.enabled === true;
    const port = Number(inbound.port ?? inbound.listen_port);
    const listen = text(inbound.listen);
    const domains = strings(
      xray && isReality
        ? reality.serverNames
        : tls.server_name ||
            tls.serverName ||
            (isReality ? object(reality.handshake).server : undefined),
    )
      .map((name) => name.toLowerCase())
      .filter((name) => hostname.safeParse(name).success);
    const domain =
      domains[0] ||
      strings(object(tls.acme).domain).find((name) => hostname.safeParse(name).success) ||
      "";
    const publicKey = isReality ? realityPublicKey(reality.privateKey ?? reality.private_key) : "";
    const shortIds = strings(reality.shortIds ?? reality.short_id);
    const shortId = shortIds.find((id) => /^(?:[0-9a-fA-F]{2}){0,8}$/.test(id));
    const users = array(settings.clients ?? settings.users).slice(0, 100);
    const raw = object(stream.rawSettings ?? stream.tcpSettings);
    let problem = "";
    if (!Number.isInteger(port) || port < 1 || port > 65535) problem = "需要单个有效监听端口";
    else if (
      listen &&
      (!isIP(listen) ||
        listen.startsWith("127.") ||
        listen === "::1" ||
        listen.startsWith("::ffff:127."))
    )
      problem = "此服务未监听可访问的网络地址";
    else if (!hasTls || (kind === "anytls" && isReality))
      problem = "入口需要直接提供 TLS 或 REALITY";
    else if (
      (xray && !["", "tcp", "raw"].includes(text(stream.network ?? stream.method))) ||
      (!xray && Object.keys(object(inbound.transport)).length > 0) ||
      (object(raw.header).type && object(raw.header).type !== "none") ||
      raw.acceptProxyProtocol ||
      object(stream.sockopt).acceptProxyProtocol ||
      Object.keys(object(stream.finalmask)).length ||
      inbound.detour ||
      (xray && settings.decryption && settings.decryption !== "none")
    )
      problem = "暂不支持此入口的附加传输、PROXY protocol 或 VLESS Encryption 配置";
    else if (
      ["require-any", "require-and-verify"].includes(text(tls.client_authentication)) ||
      tls.verifyPeerCertInNames ||
      tls.pinnedPeerCertificateChainSha256
    )
      problem = "此入口要求额外的客户端证书认证";
    else if (isReality && (!publicKey || shortId === undefined || (xray && !domains.length)))
      problem = "REALITY 缺少有效私钥、Short ID 或 SNI 域名";
    else if (isReality && reality.mldsa65Seed) problem = "暂不支持启用 ML-DSA-65 的 REALITY 入口";
    for (const [userIndex, userValue] of (users.length ? users : [null]).entries()) {
      const user = object(userValue);
      const flow = text(user.flow);
      const credentials: Record<string, string> =
        kind === "anytls"
          ? { password: text(user.password) }
          : {
              uuid: text(user.id ?? user.uuid),
              ...(isReality ? { publicKey, shortId: shortId ?? "" } : {}),
            };
      let reason = problem;
      if (
        !reason &&
        (kind === "anytls"
          ? !credentials.password || credentials.password.length > 4096
          : !z.uuid().safeParse(credentials.uuid).success)
      )
        reason = "缺少有效的用户认证配置";
      if (
        !reason &&
        ![
          "",
          "xtls-rprx-vision",
          ...(security === "xtls" ? ["xtls-rprx-direct", "xtls-rprx-origin"] : []),
        ].includes(flow)
      )
        reason = "暂不支持此 XTLS flow";
      const client: EntranceClient = { security, flow, alpn: strings(tls.alpn).slice(0, 16) };
      result.push({
        key: `${index}:${users.length ? userIndex : -1}`,
        label: [
          text(inbound.tag) || `${kind === "anytls" ? "AnyTLS" : "VLESS"} :${port}`,
          text(user.name ?? user.email) || `用户 ${userIndex + 1}`,
        ]
          .join(" · ")
          .slice(0, 200),
        kind,
        port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0,
        domain,
        domains: isReality && xray ? domains : [],
        client,
        reason,
        credentials,
        // Unrelated routes, users and certificate renewals don't invalidate this connection.
        fingerprint: createHash("sha256")
          .update(JSON.stringify({ kind, port, listen, domains, domain, client, credentials }))
          .digest("hex"),
      });
    }
  }
  return result;
}
