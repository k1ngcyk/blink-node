import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export function bytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  const i = Math.min(5, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB", "PiB"][i]}`;
}
export function when(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未接入";
}
export function percent(value: number | null | undefined) {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}
export function uptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return days
    ? `${days} 天 ${hours} 小时`
    : `${hours} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`;
}
