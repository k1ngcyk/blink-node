"use client";

import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import {
  IconArrowDown,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconCheck,
  IconClipboard,
  IconCopy,
  IconKeyboard,
  IconLoader2,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { MoreActions } from "../more-actions";
import { wsUrl } from "@/lib/client";
import { terminalArrowKey, terminalControlKey, terminalInputChunks } from "@/lib/terminal-input";
import { XtermTerminal, type TerminalSize, type TerminalTools } from "./xterm-terminal";

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";
const labels: Record<ConnectionState, string> = {
  connecting: "正在连接…",
  connected: "已连接",
  disconnected: "已断开",
  error: "连接失败",
};

function ToolButton({
  label,
  children,
  ...props
}: {
  label: string;
  children: ReactNode;
} & Omit<React.ComponentProps<typeof Button>, "children">) {
  return (
    <Button type="button" size="icon" variant="ghost" aria-label={label} title={label} {...props}>
      {children}
    </Button>
  );
}

export function TerminalSession({
  ticket,
  active,
  id,
  busy,
  canConnect,
  onReconnect,
  onKeyboard,
}: {
  ticket: string;
  active: boolean;
  id: number;
  busy: boolean;
  canConnect: boolean;
  onReconnect: () => void;
  onKeyboard: () => void;
}) {
  const tools = useRef<TerminalTools | null>(null);
  const ctrl = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [error, setError] = useState("");
  const [size, setSize] = useState<TerminalSize | null>(null);
  const [fontSize, setFontSize] = useState(14);
  const [screenReaderMode, setScreenReaderMode] = useState(false);
  const [selected, setSelected] = useState(false);
  const [ctrlPressed, setCtrlPressed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState(true);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteDraft, setPasteDraft] = useState("");
  const [feedback, setFeedback] = useState("");
  const connected = state === "connected";
  const focusOnReady = useEffectEvent(() => {
    // Don't steal focus from another tab or summon a mobile keyboard asynchronously.
    if (active && !window.matchMedia("(pointer: coarse)").matches) tools.current?.terminal.focus();
  });
  useEffect(() => {
    if (state === "connected") focusOnReady();
  }, [state]);
  useEffect(() => {
    if (searchOpen && active) searchInput.current?.focus();
  }, [searchOpen, active]);

  function setControl(value: boolean) {
    ctrl.current = value;
    setCtrlPressed(value);
  }

  function attach({ terminal, search }: TerminalTools) {
    tools.current = { terminal, search };
    let disposed = false;
    let ready = false;
    const socket = new WebSocket(wsUrl("/ws/terminal"));
    socket.binaryType = "arraybuffer";
    const timeout = window.setTimeout(() => {
      if (!disposed && !ready) {
        setError("连接超时，请确认 Agent 在线后重试。");
        socket.close();
      }
    }, 15000);
    const resize = () => {
      setSize({ cols: terminal.cols, rows: terminal.rows });
      if (ready && socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
    };
    socket.onopen = () => socket.send(JSON.stringify({ type: "auth", ticket }));
    socket.onmessage = (event) => {
      if (disposed) return;
      if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data));
      else {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "ready" && !ready) {
            ready = true;
            clearTimeout(timeout);
            terminal.options.disableStdin = false;
            setState("connected");
            resize();
          }
        } catch {
          setError("终端收到无效响应");
        }
      }
    };
    socket.onclose = (event) => {
      clearTimeout(timeout);
      if (disposed) return;
      ready = false;
      terminal.options.disableStdin = true;
      setControl(false);
      setState("disconnected");
      if (event.code !== 1000)
        setError((previous) => previous || "连接已中断，请检查网络与 Agent 状态后重新连接。");
    };
    socket.onerror = () => {
      if (!disposed) setError("无法建立终端连接，请检查网络后重试。");
    };
    const input = terminal.onData((data) => {
      if (!ready || socket.readyState !== WebSocket.OPEN) return;
      if (ctrl.current) {
        data = terminalControlKey(data);
        setControl(false);
      }
      for (const chunk of terminalInputChunks(data)) {
        if (socket.bufferedAmount > 1024 * 1024) {
          setError("网络发送缓慢，会话已断开。请重新连接后检查命令执行情况。");
          socket.close();
          return;
        }
        socket.send(JSON.stringify({ type: "input", data: chunk }));
      }
    });
    const resized = terminal.onResize(resize);
    const selection = terminal.onSelectionChange(() => setSelected(terminal.hasSelection()));
    const mobileFocus = () => {
      if (window.matchMedia("(pointer: coarse)").matches) onKeyboard();
    };
    terminal.textarea?.addEventListener("focus", mobileFocus);
    terminal.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyF") {
        if (event.type === "keydown") {
          event.preventDefault();
          setSearchOpen(true);
        }
        return false;
      }
      return true;
    });
    resize();
    return () => {
      disposed = true;
      clearTimeout(timeout);
      input.dispose();
      resized.dispose();
      selection.dispose();
      terminal.textarea?.removeEventListener("focus", mobileFocus);
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
      tools.current = null;
    };
  }

  function send(data: string) {
    if (!connected) return;
    tools.current?.terminal.input(data);
    tools.current?.terminal.focus();
  }
  function find(value: string, previous = false, incremental = false) {
    const search = tools.current?.search;
    setFound(
      !value ||
        !!(previous ? search?.findPrevious(value) : search?.findNext(value, { incremental })),
    );
    if (!value) search?.clearDecorations();
  }
  function paste(text: string) {
    if (!connected || !tools.current) return;
    setControl(false);
    // xterm handles bracketed paste and newline normalization for the active application.
    tools.current.terminal.paste(text);
    tools.current.terminal.focus();
    setPasteOpen(false);
    setPasteDraft("");
  }
  async function readClipboard() {
    setFeedback("");
    try {
      const text = await navigator.clipboard.readText();
      if (text) paste(text);
      else setFeedback("剪贴板为空");
    } catch {
      setSearchOpen(false);
      setPasteOpen(true);
      setFeedback("无法读取剪贴板，可在输入框内长按粘贴。");
    }
  }
  async function copy() {
    const text = tools.current?.terminal.getSelection();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setFeedback("已复制选中内容");
    } catch {
      setFeedback("无法访问剪贴板，请使用系统复制菜单。");
    }
  }

  return (
    <div
      className="terminal-session"
      hidden={!active}
      role="tabpanel"
      id={`terminal-session-${id}`}
      aria-labelledby={`terminal-tab-${id}`}
    >
      <div className="terminal-session-toolbar">
        <div className="terminal-connection" role="status">
          {state === "connecting" ? (
            <IconLoader2 size={14} className="terminal-spinner" />
          ) : (
            <span className="terminal-status-dot" data-state={state} />
          )}
          <span>{labels[state]}</span>
          {size && (
            <span className="terminal-dimensions">
              {size.cols} × {size.rows}
            </span>
          )}
        </div>
        <div className="terminal-tools">
          <ToolButton
            label="搜索终端内容"
            onClick={() => {
              setPasteOpen(false);
              setSearchOpen((open) => !open);
            }}
            aria-expanded={searchOpen}
          >
            <IconSearch size={17} />
          </ToolButton>
          <ToolButton label="复制选中内容" disabled={!selected} onClick={() => void copy()}>
            <IconCopy size={17} />
          </ToolButton>
          <ToolButton label="粘贴" disabled={!connected} onClick={() => void readClipboard()}>
            <IconClipboard size={17} />
          </ToolButton>
          <select
            aria-label="终端字号"
            className="terminal-font-size"
            value={fontSize}
            onChange={(event) => setFontSize(Number(event.target.value))}
          >
            {[12, 13, 14, 15, 16, 18, 20].map((value) => (
              <option key={value} value={value}>
                {value} px
              </option>
            ))}
          </select>
          <ToolButton
            label="打开键盘"
            className="terminal-keyboard-toggle"
            disabled={!connected}
            onClick={() => {
              onKeyboard();
              tools.current?.terminal.focus();
            }}
          >
            <IconKeyboard size={18} />
          </ToolButton>
          <MoreActions
            label="终端更多操作"
            items={[
              {
                label: screenReaderMode ? "关闭屏幕阅读器优化" : "开启屏幕阅读器优化",
                onSelect: () => setScreenReaderMode((enabled) => !enabled),
              },
              { label: "滚动到底部", onSelect: () => tools.current?.terminal.scrollToBottom() },
              { label: "选择全部输出", onSelect: () => tools.current?.terminal.selectAll() },
              {
                label: "清空屏幕与回滚",
                onSelect: () => {
                  tools.current?.terminal.clear();
                  setFeedback("已清空屏幕与回滚，当前命令继续运行");
                },
              },
            ]}
          />
        </div>
      </div>
      {searchOpen && (
        <div className="terminal-search" role="search" aria-label="终端内容搜索">
          <IconSearch size={16} />
          <Input
            ref={searchInput}
            aria-label="搜索终端内容"
            placeholder="搜索输出…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              find(event.target.value, false, true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                find(query, event.shiftKey);
              }
              if (event.key === "Escape") {
                setSearchOpen(false);
                tools.current?.terminal.focus();
              }
            }}
          />
          <span className="terminal-search-result" role="status">
            {query && !found ? "未找到" : ""}
          </span>
          <ToolButton label="上一个匹配" disabled={!query} onClick={() => find(query, true)}>
            <IconArrowUp size={16} />
          </ToolButton>
          <ToolButton label="下一个匹配" disabled={!query} onClick={() => find(query)}>
            <IconArrowDown size={16} />
          </ToolButton>
          <ToolButton
            label="关闭搜索"
            onClick={() => {
              setSearchOpen(false);
              tools.current?.search.clearDecorations();
              tools.current?.terminal.focus();
            }}
          >
            <IconX size={16} />
          </ToolButton>
        </div>
      )}
      {(error || state === "disconnected" || state === "error") && (
        <div className="terminal-message" role={error ? "alert" : "status"}>
          <span>{error || "会话已结束，输出仍可查看和复制。"}</span>
          {(state === "disconnected" || state === "error") && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canConnect}
              onClick={onReconnect}
            >
              重新连接
            </Button>
          )}
        </div>
      )}
      <div className="terminal-surface">
        <XtermTerminal
          active={active}
          fontSize={fontSize}
          screenReaderMode={screenReaderMode}
          onReady={attach}
          onError={(error) => {
            setError(error.message);
            setState("error");
          }}
        />
      </div>
      {pasteOpen && (
        <form
          className="terminal-paste"
          onSubmit={(event) => {
            event.preventDefault();
            paste(pasteDraft);
          }}
        >
          <label htmlFor={`terminal-paste-${id}`}>粘贴文本</label>
          <Textarea
            id={`terminal-paste-${id}`}
            autoFocus
            rows={2}
            value={pasteDraft}
            onChange={(event) => setPasteDraft(event.target.value)}
            placeholder="在这里长按或使用系统快捷键粘贴"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <div className="row between">
            <span className="muted text-xs">不会额外发送回车</span>
            <div className="row">
              <Button type="button" variant="ghost" size="sm" onClick={() => setPasteOpen(false)}>
                取消
              </Button>
              <Button type="submit" size="sm" disabled={!connected || !pasteDraft}>
                粘贴到终端
              </Button>
            </div>
          </div>
        </form>
      )}
      <div className="terminal-keybar" role="group" aria-label="终端快捷键" hidden={pasteOpen}>
        <div className="terminal-key-group">
          <button
            type="button"
            disabled={!connected}
            aria-label="Ctrl 组合键"
            aria-pressed={ctrlPressed}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              setControl(!ctrl.current);
              tools.current?.terminal.focus();
            }}
          >
            Ctrl
          </button>
          {[
            { label: "Esc", data: "\x1b" },
            { label: "Tab", data: "\t" },
            { label: "Ctrl C", data: "\x03" },
          ].map((key) => (
            <button
              type="button"
              key={key.label}
              disabled={!connected}
              aria-label={key.label}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                setControl(false);
                send(key.data);
              }}
            >
              {key.label}
            </button>
          ))}
        </div>
        <div className="terminal-key-group">
          {(
            [
              ["D", "方向左", IconArrowLeft],
              ["B", "方向下", IconArrowDown],
              ["A", "方向上", IconArrowUp],
              ["C", "方向右", IconArrowRight],
            ] as const
          ).map(([direction, label, Icon]) => (
            <button
              type="button"
              key={direction}
              aria-label={label}
              disabled={!connected}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() =>
                send(
                  terminalArrowKey(
                    direction,
                    !!tools.current?.terminal.modes.applicationCursorKeysMode,
                  ),
                )
              }
            >
              <Icon size={16} />
            </button>
          ))}
          <button
            type="button"
            disabled={!connected}
            aria-label="回车"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => send("\r")}
          >
            Enter
          </button>
        </div>
      </div>
      <div className="terminal-footer">
        <span role="status">
          {ctrlPressed ? (
            "Ctrl 已开启 · 点按下一个字母"
          ) : feedback ? (
            <>
              {feedback.startsWith("已") && <IconCheck size={12} />}
              {feedback}
            </>
          ) : (
            "空闲 15 分钟后断开"
          )}
        </span>
        <span className="terminal-footer-hint">Ctrl ⇧ F 搜索 · 输入不记录</span>
      </div>
    </div>
  );
}
