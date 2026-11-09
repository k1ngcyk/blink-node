"use client";
import { useEffect, useRef, useState } from "react";
import { IconPlus, IconTerminal2, IconX } from "@tabler/icons-react";
import { Button } from "./ui/button";
import { api, wsUrl } from "@/lib/client";
import { ErrorBanner } from "./common";
import "@xterm/xterm/css/xterm.css";

function TerminalSession({ serverId, active }: { serverId: string; active: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const [state, setState] = useState("正在授权…"),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let cleanup = () => {};
    void (async () => {
      const [{ Terminal }, { FitAddon }, auth] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        api<{ ticket: string }>(`servers/${serverId}/terminal-ticket`, "POST", {}),
      ]);
      if (disposed || !element.current) return;
      const terminal = new Terminal({
        fontFamily: '"SFMono-Regular", Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.25,
        scrollback: 2000,
        convertEol: false,
        cursorBlink: false,
        allowProposedApi: false,
        theme: {
          background: "#10191b",
          foreground: "#d7e9e6",
          cursor: "#86d3c1",
          selectionBackground: "#335450",
        },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(element.current);
      fit.fit();
      socket = new WebSocket(wsUrl("/ws/terminal"));
      socket.binaryType = "arraybuffer";
      let ready = false;
      const resize = () => {
        if (disposed || !element.current?.offsetWidth) return;
        fit.fit();
        if (ready && socket?.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      };
      socket.onopen = () => socket?.send(JSON.stringify({ type: "auth", ticket: auth.ticket }));
      socket.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) terminal.write(new Uint8Array(e.data));
        else {
          try {
            const m = JSON.parse(e.data);
            if (m.type === "ready") {
              ready = true;
              setState("已连接");
              resize();
              terminal.focus();
            }
          } catch {
            setError("终端收到无效响应");
          }
        }
      };
      socket.onclose = (e) => {
        if (!disposed) {
          setState("已断开");
          if (e.code !== 1000)
            setError("终端连接已关闭，请检查授权、Agent 配置或连接状态。重新验证可在设置中完成。");
        }
      };
      socket.onerror = () => {
        if (!disposed) setError("无法建立终端连接");
      };
      const input = terminal.onData((data) => {
        if (ready && socket?.readyState === WebSocket.OPEN) {
          for (let i = 0; i < data.length; i += 2048)
            socket.send(JSON.stringify({ type: "input", data: data.slice(i, i + 2048) }));
        }
      });
      const observer = new ResizeObserver(resize);
      observer.observe(element.current);
      cleanup = () => {
        observer.disconnect();
        input.dispose();
        terminal.dispose();
      };
    })().catch((e) => {
      if (!disposed) {
        setError((e as Error).message);
        setState("连接失败");
      }
    });
    return () => {
      disposed = true;
      socket?.close();
      cleanup();
    };
  }, [serverId]);
  return (
    <div style={{ display: active ? "block" : "none" }}>
      <div className="panel-header">
        <span className="row text-xs">
          <IconTerminal2 size={15} />
          {state}
        </span>
        <span className="muted text-xs">空闲 15 分钟后断开 · 输入不会被记录</span>
      </div>
      <ErrorBanner error={error} />
      <div className="terminal-surface">
        <div ref={element} />
      </div>
    </div>
  );
}
export function TerminalPanel({ serverId, enabled }: { serverId: string; enabled: boolean }) {
  const [sessions, setSessions] = useState<number[]>([]),
    [active, setActive] = useState(0);
  const sequence = useRef(0);
  function add() {
    const id = ++sequence.current;
    setSessions((s) => [...s, id]);
    setActive(id);
  }
  if (!enabled)
    return (
      <div className="notice">
        此服务器当前无法使用终端。请确认 Agent 在线，并在服务器配置中显式启用{" "}
        <code>terminal_enabled</code> 与指定的 Unix 用户。
      </div>
    );
  return (
    <section className="panel">
      <div className="panel-header">
        <div className="row">
          {sessions.map((id) => (
            <div className="row" key={id}>
              <Button
                size="sm"
                variant={active === id ? "secondary" : "ghost"}
                onClick={() => setActive(id)}
              >
                会话 {id}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`关闭会话 ${id}`}
                onClick={() => {
                  setSessions((s) => s.filter((i) => i !== id));
                  if (active === id) setActive(sessions.find((i) => i !== id) ?? 0);
                }}
              >
                <IconX size={13} />
              </Button>
            </div>
          ))}
        </div>
        <Button size="sm" variant="outline" disabled={sessions.length >= 4} onClick={add}>
          <IconPlus size={15} />
          新建会话
        </Button>
      </div>
      {sessions.length ? (
        sessions.map((id) => (
          <TerminalSession key={id} serverId={serverId} active={id === active} />
        ))
      ) : (
        <div className="empty">
          <IconTerminal2 size={30} />
          <h2>连接到服务器终端</h2>
          <p>会话通过加密通道连接到 Agent 配置的 Unix 用户。关闭页面将结束会话。</p>
          <Button onClick={add}>连接终端</Button>
        </div>
      )}
    </section>
  );
}
