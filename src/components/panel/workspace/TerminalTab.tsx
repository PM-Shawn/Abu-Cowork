import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useActiveConversation } from '@/stores/chatStore';
import { useI18n, format } from '@/i18n';
import { createLogger } from '@/core/logging/logger';

const terminalLogger = createLogger('terminal');

/**
 * A real pty-backed terminal (Rust `portable-pty` + `@xterm/xterm`). One
 * instance per terminal tab id; `WorkspacePanel` keep-alive mounts tabs (CSS
 * `hidden`, never unmounted on tab switch), so this component only unmounts
 * when the tab is actually closed — which is exactly when killing the pty
 * session is correct. See docs/2026-07-17-workspace-tabs-design.md.
 */
export default function TerminalTab({ tabId }: { tabId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const conversation = useActiveConversation();
  const { t } = useI18n();

  // Resolve the starting cwd once, at mount time: the active conversation's
  // workspace dir if resolvable, else undefined (Rust falls back to the
  // shell's own default — typically $HOME). A pty session's cwd is fixed for
  // its lifetime, so later conversation switches must not move it.
  const cwdRef = useRef<string | undefined>(conversation?.workspacePath ?? undefined);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace',
      cursorBlink: true,
      convertEol: false,
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    // A keep-alive-hidden ancestor (`hidden` -> display:none) reports 0
    // client dimensions; fitting against that would collapse the terminal to
    // 0x0 rows/cols. Only fit (and later, resize) when actually visible.
    const fitIfVisible = (): boolean => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return false;
      try {
        fitAddon.fit();
        return true;
      } catch {
        return false;
      }
    };

    let disposed = false;
    const unlistenFns: UnlistenFn[] = [];

    async function start() {
      fitIfVisible();

      try {
        const dataUnlisten = await listen<number[]>(`pty://data/${tabId}`, (event) => {
          // Rust emits raw output bytes as a JSON number array (binary-safe —
          // terminal output can split a UTF-8 codepoint across chunks; xterm
          // handles partial writes/re-assembly internally).
          term.write(new Uint8Array(event.payload));
        });
        if (disposed) {
          dataUnlisten();
          return;
        }
        unlistenFns.push(dataUnlisten);

        const exitUnlisten = await listen<number | null>(`pty://exit/${tabId}`, () => {
          term.write(`\r\n\x1b[2m${t.workspace.terminalProcessExited}\x1b[0m\r\n`);
        });
        if (disposed) {
          exitUnlisten();
          return;
        }
        unlistenFns.push(exitUnlisten);

        term.onData((data) => {
          void invoke('pty_write', { id: tabId, data });
        });

        await invoke('pty_spawn', {
          id: tabId,
          cols: term.cols,
          rows: term.rows,
          cwd: cwdRef.current,
        });
        // If the tab was closed while pty_spawn was in flight, the cleanup's
        // pty_kill already ran (before the session existed) — kill again now
        // that the session is registered, so we don't orphan the shell.
        if (disposed) {
          void invoke('pty_kill', { id: tabId });
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        terminalLogger.error('Failed to start terminal', { error: message });
        term.write(`\r\n${format(t.workspace.terminalStartFailed, { error: message })}\r\n`);
      }
    }

    void start();

    // Lightly debounced: dragging the chat/workspace splitter fires many
    // ResizeObserver callbacks in a row.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!fitIfVisible()) return;
        void invoke('pty_resize', { id: tabId, cols: term.cols, rows: term.rows });
      }, 80);
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      unlistenFns.forEach((fn) => fn());
      void invoke('pty_kill', { id: tabId });
      term.dispose();
    };
  // t is stable from the i18n singleton; cwdRef is a ref (identity-stable).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden px-2 py-1" />;
}
