"use client";
import { useCallback, useEffect, useReducer, useState } from "react";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T = unknown>(path: string, method = "GET", data?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: data !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });
  const value = await res.json();
  if (!res.ok) {
    if (res.status === 401 && path !== "auth/login" && path !== "auth/elevate")
      window.dispatchEvent(new Event("blink:unauthorized"));
    throw new ApiError(res.status, value.error ?? "请求失败");
  }
  return value;
}
export function useResource<T>(path: string, interval = 0) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const [revision, bump] = useReducer((n) => n + 1, 0);
  const refresh = useCallback(() => bump(), []);
  useEffect(() => {
    if (!path) return;
    let alive = true,
      inFlight = false;
    function load() {
      if (inFlight) return;
      inFlight = true;
      void api<T>(path)
        .then((value) => {
          if (alive) {
            setData(value);
            setError("");
          }
        })
        .catch((e) => {
          if (alive) setError(e instanceof Error ? e.message : "请求失败");
        })
        .finally(() => {
          inFlight = false;
          if (alive) setLoading(false);
        });
    }
    load();
    const timer = interval ? setInterval(load, interval) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [path, interval, revision]);
  return { data, error, loading, refresh };
}
export function wsUrl(path: string) {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // Local development reverse proxy uses the same origin in normal use.
  return url.toString();
}
