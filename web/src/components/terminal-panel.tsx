"use client";

import { useEffect, useRef, useState } from "react";
import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconPlus,
  IconTerminal2,
  IconX,
} from "@tabler/icons-react";
import { Button } from "./ui/button";
import { api } from "@/lib/client";
import { ActionCancelled } from "@/lib/elevation";
import { TerminalSession } from "./terminal/terminal-session";
import "./terminal/terminal.css";

export function TerminalPanel({
  serverId,
  serverName,
  enabled,
  visible = true,
}: {
  serverId: string;
  serverName: string;
  enabled: boolean;
  visible?: boolean;
}) {
  const [sessions, setSessions] = useState<{ id: number; ticket: string }[]>([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const container = useRef<HTMLElement>(null);
  const connecting = useRef(false);
  const sequence = useRef(0);
  const request = useRef(0);
  const fullscreen = expanded && visible;

  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  useEffect(() => {
    if (!fullscreen) return;
    const panel = container.current!;
    const viewport = window.visualViewport;
    const update = () => {
      // Pin to the visual viewport so the keyboard never covers the key strip.
      if (viewport && viewport.scale !== 1) return;
      panel.style.setProperty(
        "--terminal-viewport-height",
        `${viewport?.height ?? window.innerHeight}px`,
      );
      panel.style.setProperty("--terminal-viewport-top", `${viewport?.offsetTop ?? 0}px`);
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const inertElements: { element: HTMLElement; inert: boolean }[] = [];
    for (let node: HTMLElement | null = panel; node?.parentElement; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling !== node && sibling instanceof HTMLElement) {
          inertElements.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
    }
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      document.body.style.overflow = overflow;
      for (const { element, inert } of inertElements) element.inert = inert;
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      panel.style.removeProperty("--terminal-viewport-height");
      panel.style.removeProperty("--terminal-viewport-top");
    };
  }, [fullscreen]);

  async function connect(existingId?: number) {
    if (connecting.current || !enabled || (!existingId && sessions.length >= 4)) return;
    connecting.current = true;
    const current = ++request.current;
    setBusy(true);
    setError("");
    try {
      const { ticket } = await api<{ ticket: string }>(
        `servers/${serverId}/terminal-ticket`,
        "POST",
        {},
      );
      if (current !== request.current) return;
      const id = existingId ?? ++sequence.current;
      setSessions((sessions) =>
        existingId
          ? sessions.map((s) => (s.id === id ? { id, ticket } : s))
          : [...sessions, { id, ticket }],
      );
      setActive(id);
    } catch (error) {
      if (current === request.current && !(error instanceof ActionCancelled))
        setError(error instanceof Error ? error.message : "无法连接终端");
    } finally {
      if (current === request.current) {
        connecting.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <section
      ref={container}
      className={`terminal-workspace${fullscreen ? " terminal-expanded" : ""}`}
      aria-label={`${serverName}的网页终端`}
    >
      <div className="terminal-workspace-header">
        <div className="terminal-identity">
          <IconTerminal2 size={19} />
          <span title={serverName}>
            {serverName}
            <small>远程终端</small>
          </span>
        </div>
        <div className="terminal-header-actions">
          {sessions.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={!enabled || busy || sessions.length >= 4}
              onClick={() => void connect()}
            >
              <IconPlus size={15} />
              <span>新建会话</span>
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            aria-label={fullscreen ? "退出专注模式" : "进入专注模式"}
            title={fullscreen ? "退出专注模式" : "进入专注模式"}
            aria-pressed={fullscreen}
            onClick={() => setExpanded(!fullscreen)}
          >
            {fullscreen ? <IconArrowsMinimize size={18} /> : <IconArrowsMaximize size={18} />}
          </Button>
        </div>
      </div>
      {!!sessions.length && (
        <div className="terminal-tabs" role="tablist" aria-label="终端会话">
          {sessions.map(({ id }) => (
            <div className="terminal-tab" key={id} data-active={id === active}>
              <button
                type="button"
                role="tab"
                id={`terminal-tab-${id}`}
                aria-controls={`terminal-session-${id}`}
                aria-selected={id === active}
                tabIndex={id === active ? 0 : -1}
                onClick={() => setActive(id)}
                onKeyDown={(event) => {
                  const index = sessions.findIndex((session) => session.id === id);
                  const next =
                    event.key === "ArrowRight"
                      ? (index + 1) % sessions.length
                      : event.key === "ArrowLeft"
                        ? (index + sessions.length - 1) % sessions.length
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? sessions.length - 1
                            : -1;
                  if (next >= 0) {
                    event.preventDefault();
                    setActive(sessions[next].id);
                    document.getElementById(`terminal-tab-${sessions[next].id}`)?.focus();
                  }
                }}
              >
                <IconTerminal2 size={14} />
                会话 {id}
              </button>
              <button
                type="button"
                aria-label={`关闭会话 ${id}`}
                disabled={busy}
                onClick={() => {
                  setSessions((sessions) => sessions.filter((session) => session.id !== id));
                  if (active === id)
                    setActive(sessions.find((session) => session.id !== id)?.id ?? 0);
                }}
              >
                <IconX size={14} />
              </button>
            </div>
          ))}
          <span className="terminal-session-count">{sessions.length} / 4</span>
        </div>
      )}
      {error && (
        <div className="terminal-message" role="alert">
          {error}
        </div>
      )}
      {!enabled && (
        <div className="terminal-message" role="status">
          此服务器当前无法使用终端。请确认 Agent 在线，并已配置 <code>terminal_enabled</code> 与
          Unix 用户。
        </div>
      )}
      {sessions.length ? (
        sessions.map(({ id, ticket }) => (
          <TerminalSession
            key={ticket}
            id={id}
            ticket={ticket}
            active={visible && id === active}
            busy={busy}
            canConnect={enabled}
            onReconnect={() => void connect(id)}
            onKeyboard={() => {
              if (window.matchMedia("(max-width: 767px)").matches) setExpanded(true);
            }}
          />
        ))
      ) : (
        <div className="terminal-empty">
          <div className="terminal-empty-icon">
            <IconTerminal2 size={28} />
          </div>
          <h2>从这里，连接你的服务器</h2>
          <p>
            打开交互式 Shell，查看日志、运行命令。
            <br />
            支持多会话，也为手机准备了快捷键。
          </p>
          <Button disabled={busy || !enabled} onClick={() => void connect()}>
            <IconTerminal2 size={16} />
            {busy ? "正在连接…" : "连接终端"}
          </Button>
          <small>连接到 Agent 配置的 Unix 用户 · 关闭页面会结束会话</small>
        </div>
      )}
    </section>
  );
}
