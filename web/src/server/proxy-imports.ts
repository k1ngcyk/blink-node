import { createHash } from "node:crypto";
import { isIP } from "node:net";

const methods = new Set([
  "2022-blake3-aes-128-gcm",
  "2022-blake3-aes-256-gcm",
  "2022-blake3-chacha20-poly1305",
  "aes-128-gcm",
  "aes-256-gcm",
  "chacha20-ietf-poly1305",
]);
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as ObjectValue) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export type ImportedExitCandidate = {
  key: string;
  label: string;
  port: number;
  method: string;
  udp: boolean;
  reason: string;
  password: string;
  fingerprint: string;
};

export function importedExitCandidates(engine: string, snapshot: unknown): ImportedExitCandidate[] {
  if (engine !== "xray" && engine !== "sing-box") return [];
  const result: ImportedExitCandidate[] = [];
  for (const [index, value] of array(object(object(snapshot).effective).inbounds)
    .slice(0, 100)
    .entries()) {
    const inbound = object(value);
    if ((inbound.protocol ?? inbound.type) !== "shadowsocks") continue;
    const settings = engine === "xray" ? object(inbound.settings) : inbound;
    const users = array(settings.clients ?? settings.users).slice(0, 100);
    const serverMethod = text(settings.method);
    const is2022 = serverMethod.startsWith("2022-");
    const port = Number(inbound.port ?? inbound.listen_port);
    const listen = text(inbound.listen);
    const stream = object(inbound.streamSettings);
    const network = settings.network;
    const supports = (name: string) =>
      network === undefined ||
      (typeof network === "string" ? network.split(",") : array(network)).includes(name);
    for (const [userIndex, value] of (users.length ? users : [null]).entries()) {
      const user = object(value);
      const method = is2022 ? serverMethod : text(user.method) || serverMethod;
      const password = users.length
        ? (is2022 ? text(settings.password) + ":" : "") + text(user.password)
        : text(settings.password);
      let reason = "";
      if (!Number.isInteger(port) || port < 1 || port > 65535) reason = "需要单个有效监听端口";
      else if (
        listen &&
        (!isIP(listen) ||
          listen.startsWith("127.") ||
          listen === "::1" ||
          listen.startsWith("::ffff:127."))
      )
        reason = "此服务未监听可访问的网络地址";
      else if (
        (stream.network && !["tcp", "raw"].includes(text(stream.network))) ||
        (stream.security && stream.security !== "none") ||
        settings.plugin ||
        inbound.detour ||
        array(settings.destinations).length
      )
        reason = "暂不支持此服务的附加传输或中继配置";
      else if (!supports("tcp")) reason = "此服务未开启 TCP";
      else if (!methods.has(method)) reason = "暂不支持此 Shadowsocks 加密方法";
      else if (method.startsWith("2022-") && !is2022)
        reason = "SS2022 加密方法需要在服务端统一配置";
      else if (!password || password.length > 1024) reason = "缺少有效的认证配置";
      else if (is2022) {
        const size = method === "2022-blake3-aes-128-gcm" ? 16 : 32;
        const keys = password.split(":");
        if (
          keys.length > 2 ||
          keys.some(
            (key) =>
              !/^[A-Za-z0-9+/]+={0,2}$/.test(key) ||
              Buffer.from(key, "base64").length !== size ||
              Buffer.from(key, "base64").toString("base64") !== key,
          )
        )
          reason = "SS2022 密钥格式无效";
        else if (keys.length > 1 && method === "2022-blake3-chacha20-poly1305")
          reason = "暂不支持此 SS2022 多用户加密方法";
      }
      const udp = supports("udp");
      result.push({
        key: `${index}:${users.length ? userIndex : -1}`,
        label: [
          text(inbound.tag) || `Shadowsocks :${port}`,
          text(user.name ?? user.email) || (users.length ? `用户 ${userIndex + 1}` : ""),
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 200),
        port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0,
        method,
        udp,
        reason,
        password,
        fingerprint: createHash("sha256")
          .update(JSON.stringify({ port, method, password, udp, listen, stream }))
          .digest("hex"),
      });
    }
  }
  return result;
}
