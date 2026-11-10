"use client";
import { useSearchParams } from "next/navigation";

export function useQueryState(key: string, fallback = "") {
  const params = useSearchParams();
  const value = params.get(key) ?? fallback;
  function update(next: string) {
    const url = new URL(window.location.href);
    if (next === fallback) url.searchParams.delete(key);
    else url.searchParams.set(key, next);
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  return [value, update] as const;
}
