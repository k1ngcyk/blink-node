"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";

export type TerminalSize = { cols: number; rows: number };
export type TerminalTools = { terminal: Terminal; search: SearchAddon };

/** Browser-only renderer. The caller owns the transport and returns its cleanup. */
export function XtermTerminal({
  active,
  fontSize,
  screenReaderMode = false,
  onReady,
  onError,
}: {
  active: boolean;
  fontSize: number;
  screenReaderMode?: boolean;
  onReady: (tools: TerminalTools) => () => void;
  onError: (error: Error) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<Terminal | null>(null);
  const fitFrame = useRef<(() => void) | null>(null);
  const ready = useEffectEvent((tools: TerminalTools) => {
    tools.terminal.options.fontSize = fontSize;
    tools.terminal.options.screenReaderMode = screenReaderMode;
    return onReady(tools);
  });
  const failed = useEffectEvent(onError);

  useEffect(() => {
    let disposed = false;
    let frame = 0;
    let terminal: Terminal | undefined;
    let observer: ResizeObserver | undefined;
    let disconnect: (() => void) | undefined;
    const cleanup = () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      disconnect?.();
      terminal?.dispose();
      disconnect = undefined;
      terminal = undefined;
      instance.current = null;
      fitFrame.current = null;
    };
    void (async () => {
      const [{ Terminal }, { FitAddon }, { SearchAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-search"),
      ]);
      if (disposed || !element.current) return;
      terminal = new Terminal({
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        fontSize: 14,
        lineHeight: 1.3,
        scrollback: 5000,
        cursorStyle: "bar",
        cursorWidth: 2,
        cursorBlink: false,
        disableStdin: true,
        // Opt-in: xterm's screen-reader mode suppresses mobile insertText events.
        screenReaderMode: false,
        allowProposedApi: false,
        theme: {
          background: "#10191b",
          foreground: "#d7e9e6",
          cursor: "#86d3c1",
          cursorAccent: "#10191b",
          selectionBackground: "#335450",
          selectionInactiveBackground: "#293e3c",
          black: "#243432",
          red: "#f18a91",
          green: "#86d3b2",
          yellow: "#e5bf83",
          blue: "#88b9e8",
          magenta: "#c7a5e8",
          cyan: "#88d6d8",
          white: "#d7e9e6",
          brightBlack: "#829b96",
          brightRed: "#ffadb2",
          brightGreen: "#a5e9c9",
          brightYellow: "#f3d6a5",
          brightBlue: "#add4fa",
          brightMagenta: "#dec2f7",
          brightCyan: "#b2eef0",
          brightWhite: "#f1faf7",
        },
      });
      instance.current = terminal;
      const fit = new FitAddon();
      const search = new SearchAddon();
      terminal.loadAddon(fit);
      terminal.loadAddon(search);
      terminal.open(element.current);
      if (terminal.textarea) {
        terminal.textarea.setAttribute("aria-label", "终端输入");
        terminal.textarea.setAttribute("autocapitalize", "off");
        terminal.textarea.setAttribute("autocorrect", "off");
        terminal.textarea.setAttribute("spellcheck", "false");
        terminal.textarea.setAttribute("enterkeyhint", "send");
      }
      const resize = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          // Hidden sessions retain their buffer and PTY size until visible again.
          if (disposed || !element.current?.offsetWidth || !element.current.offsetHeight) return;
          const size = fit.proposeDimensions();
          if (size && Number.isFinite(size.cols) && Number.isFinite(size.rows))
            terminal?.resize(
              Math.max(2, Math.min(500, size.cols)),
              Math.max(2, Math.min(300, size.rows)),
            );
        });
      };
      fitFrame.current = resize;
      disconnect = ready({ terminal, search });
      observer = new ResizeObserver(resize);
      observer.observe(element.current);
      resize();
      void document.fonts.ready.then(() => {
        if (!disposed) resize();
      });
    })().catch((error: unknown) => {
      if (!disposed) {
        cleanup();
        failed(error instanceof Error ? error : new Error("终端加载失败"));
      }
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  useEffect(() => {
    if (instance.current) {
      instance.current.options.fontSize = fontSize;
      instance.current.options.screenReaderMode = screenReaderMode;
    }
    fitFrame.current?.();
  }, [fontSize, active, screenReaderMode]);

  return <div className="terminal-canvas" ref={element} />;
}
