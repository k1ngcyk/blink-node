"use client";
import { IconServer, IconAlertCircle, IconRefresh } from "@tabler/icons-react";
import { Button } from "./ui/button";
import type { Server } from "@/lib/types";
import { status, statusText } from "@/lib/types";
export function ErrorBanner({ error, retry }: { error: string; retry?: () => void }) {
  return error ? (
    <div role="alert" className="error-banner row between">
      <span>
        <IconAlertCircle size={15} className="inline mr-2" />
        {error}
      </span>
      {retry && (
        <Button variant="ghost" size="sm" onClick={retry}>
          <IconRefresh size={14} />
          重试
        </Button>
      )}
    </div>
  ) : null;
}
export function Loading() {
  return (
    <div aria-label="正在加载" aria-busy="true">
      <div className="skeleton" />
      <div className="skeleton" style={{ height: 240 }} />
    </div>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <IconServer size={32} stroke={1.4} />
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function ServerStatus({ server }: { server: Server }) {
  const s = status(server);
  return <span className={`status ${s}`}>{statusText[s]}</span>;
}
export function Meter({ value }: { value: number | undefined | null }) {
  return (
    <div>
      <span className="mono">{value == null ? "—" : `${value.toFixed(1)}%`}</span>
      <div className="meter">
        <span
          style={{
            width: `${Math.min(100, value ?? 0)}%`,
            background: (value ?? 0) >= 90 ? "var(--destructive)" : undefined,
          }}
        />
      </div>
    </div>
  );
}
