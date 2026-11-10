import type { Metric } from "@/server/protocol";
export type LiveMetric = Metric & {
  memory: number;
  swap: number;
  disk: number;
  rxRate: number;
  txRate: number;
};
export type Server = {
  id: string;
  name: string;
  group_name: string;
  tags: string[];
  notes: string;
  revoked: boolean;
  last_seen: string | null;
  latest_at: string | null;
  latest: LiveMetric | null;
  quota_bytes: number | null;
  billing_day: number;
  billing_interfaces: string[];
  created_at: string;
  addresses?: string[];
  connection_ip?: string | null;
  info: {
    hostname?: string;
    os?: string;
    kernel?: string;
    arch?: string;
    cpuModel?: string;
    cpuCount?: number;
    version?: string;
    terminal?: boolean;
    diagnostics?: boolean;
    proxy?: boolean;
  };
  traffic?: {
    start: string;
    rx: number;
    tx: number;
    interfaces: { interface: string; rx: number; tx: number }[];
  };
};
export function serverAddresses(server: Server) {
  return server.addresses?.length
    ? server.addresses
    : server.connection_ip
      ? [server.connection_ip]
      : [];
}
export function status(server: Server): "online" | "offline" | "pending" | "revoked" {
  return server.revoked
    ? "revoked"
    : !server.last_seen
      ? "pending"
      : Date.now() - Date.parse(server.last_seen) < 45000
        ? "online"
        : "offline";
}
export const statusText = {
  online: "在线",
  offline: "离线",
  pending: "等待接入",
  revoked: "已吊销",
};
export type Check = {
  id: string;
  name: string;
  server_id: string | null;
  server_name: string | null;
  kind: string;
  target: string;
  interval_seconds: number;
  enabled: boolean;
  latest: {
    ok: boolean;
    at: string;
    latencyMs: number | null;
    loss: number | null;
    status: number | null;
    certificateDays: number | null;
    error: string | null;
  } | null;
};
