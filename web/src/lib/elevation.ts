"use client";
import { useSyncExternalStore } from "react";

export class ActionCancelled extends Error {
  constructor() {
    super("");
    this.name = "ActionCancelled";
  }
}
type Challenge = {
  id: number;
  surface: string | null;
  action: string;
  returnFocus: HTMLElement | null;
};
let current: Challenge | null = null;
let complete: ((verified: boolean) => void) | null = null;
let sequence = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => current;
const serverSnapshot = () => null;
export function useElevation() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
export function requestElevation(
  surface: string | null,
  action: string,
  returnFocus: HTMLElement | null,
) {
  // Do not queue unrelated mutations behind one verification.
  if (current) return Promise.reject(new Error("请先完成当前安全验证，再执行其他操作"));
  return new Promise<void>((resolve, reject) => {
    current = { id: ++sequence, surface, action, returnFocus };
    complete = (verified) => (verified ? resolve() : reject(new ActionCancelled()));
    listeners.forEach((listener) => listener());
  });
}
export function finishElevation(verified: boolean, id?: number) {
  if (!current || (id !== undefined && current.id !== id)) return;
  const done = complete;
  const focus = current.returnFocus;
  current = null;
  complete = null;
  listeners.forEach((listener) => listener());
  done?.(verified);
  requestAnimationFrame(() => {
    if (focus?.isConnected) focus.focus();
  });
}
export function cancelSurfaceElevation(surface: string) {
  if (current?.surface === surface) finishElevation(false);
}
export function protectedActionLabel(path: string, method: string) {
  if (path.includes("terminal-ticket")) return "连接服务器终端";
  if (path === "servers") return "添加服务器";
  if (path.endsWith("/enrollment")) return "重新生成接入凭证";
  if (path.endsWith("/revoke")) return "吊销服务器凭证";
  if (path === "auth/revoke-sessions") return "退出其他设备";
  if (path.endsWith("/link")) return "查看订阅链接";
  if (path.endsWith("/rotate")) return "重置订阅链接";
  if (path.includes("subscriptions")) return method === "DELETE" ? "删除订阅" : "保存订阅";
  if (path.startsWith("proxy/settings")) return "更新 DNS 与证书设置";
  if (path.startsWith("proxy/")) return method === "DELETE" ? "移除代理服务" : "更新代理配置";
  if (path.startsWith("channels")) return "管理通知渠道";
  return "完成当前操作";
}
