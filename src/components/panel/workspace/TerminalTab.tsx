import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useActiveConversation, useChatStore } from '@/stores/chatStore';
import { useI18n, format, getI18n } from '@/i18n';
import { createLogger } from '@/core/logging/logger';
import { useEffectiveThemeIsDark } from '@/hooks/useEffectiveThemeIsDark';
import { isMacOS } from '@/utils/platform';
import { SelectionToolbar } from '@/features/reference/SelectionToolbar';
import { createDocReference } from '@/types/chatReference';

const terminalLogger = createLogger('terminal');

/**
 * Terminal colors from the app's own `--abu-*` tokens instead of a fixed
 * "VS Code dark+" palette — the old hardcoded `#1e1e1e` background read as a
 * jarring black box against Abu's warm light theme (the default since the
 * v0.42 migration). `--abu-bg-base` matches the surrounding workspace panel
 * card, so the terminal blends into it instead of looking bolted on.
 *
 * `selectionBackground` MUST be set explicitly: xterm's built-in default is
 * `rgba(255,255,255,0.3)` (white), which is invisible on the light theme's
 * near-white background — users dragged to select and saw nothing, and
 * concluded copying was broken. The clay fill matches the app's ::selection.
 */
function resolveTerminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string) => styles.getPropertyValue(name).trim();
  return {
    background: read('--abu-bg-base'),
    foreground: read('--abu-text-primary'),
    cursor: read('--abu-clay'),
    selectionBackground: read('--abu-clay-20'),
  };
}

function copyTerminalSelection(term: Terminal): void {
  const text = term.getSelection();
  if (!text) return;
  navigator.clipboard.writeText(text).catch((err) => {
    terminalLogger.error('Failed to copy terminal selection', { error: String(err) });
  });
}

async function pasteClipboardIntoTerminal(term: Terminal): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (text) term.paste(text);
  } catch (err) {
    terminalLogger.error('Failed to paste into terminal', { error: String(err) });
  }
}

/**
 * Clipboard keyboard conventions (same split as VS Code / Windows Terminal):
 * - macOS ⌘C/⌘V already work natively (menu roles dispatch DOM copy/paste
 *   events that xterm handles), so nothing to intercept there.
 * - Ctrl+Shift+C / Ctrl+Shift+V: always copy/paste (all platforms — xterm
 *   maps neither, so without this they were dead keys).
 * - Windows/Linux Ctrl+C: copy when a selection exists (then clear it so the
 *   next Ctrl+C is SIGINT again); plain SIGINT otherwise.
 * Exported for tests via module scope; returns xterm's "handled" contract:
 * `false` means "consumed, don't send to the pty".
 */
// eslint-disable-next-line react-refresh/only-export-components
export function handleTerminalCopyPasteKeys(term: Terminal, e: KeyboardEvent): boolean {
  if (e.type !== 'keydown') return true;
  const key = e.key.toLowerCase();
  const ctrlOnly = e.ctrlKey && !e.altKey && !e.metaKey;
  if (ctrlOnly && e.shiftKey && key === 'c') {
    e.preventDefault();
    copyTerminalSelection(term);
    return false;
  }
  if (ctrlOnly && e.shiftKey && key === 'v') {
    e.preventDefault();
    void pasteClipboardIntoTerminal(term);
    return false;
  }
  if (!isMacOS() && ctrlOnly && !e.shiftKey && key === 'c' && term.hasSelection()) {
    e.preventDefault();
    copyTerminalSelection(term);
    term.clearSelection();
    return false;
  }
  return true;
}

interface TerminalContextMenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

interface TerminalSelectionState {
  text: string;
  rect: DOMRect;
}

/**
 * A real pty-backed terminal (Rust `portable-pty` + `@xterm/xterm`). One
 * instance per terminal tab id; `WorkspacePanel` keep-alive mounts tabs (CSS
 * `hidden`, never unmounted on tab switch), so this component only unmounts
 * when the tab is actually closed — which is exactly when killing the pty
 * session is correct. See docs/2026-07-17-workspace-tabs-design.md.
 */
export default function TerminalTab({ tabId }: { tabId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const conversation = useActiveConversation();
  const { t } = useI18n();
  const isDark = useEffectiveThemeIsDark();
  const [contextMenu, setContextMenu] = useState<TerminalContextMenuState | null>(null);
  // Selection → "add to chat" toolbar (same reference flow as the doc preview's
  // DocSelectionLayer). xterm keeps its own selection model — window.getSelection()
  // never sees it — so the toolbar is driven by xterm's selection API instead.
  const [sel, setSel] = useState<TerminalSelectionState | null>(null);
  const [editing, setEditing] = useState(false);
  // Read synchronously inside native-event handlers registered once per pty
  // session — a state closure would go stale (same pattern as useTextSelection).
  const editingRef = useRef(editing);
  // eslint-disable-next-line react-hooks/refs
  editingRef.current = editing;

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
      theme: resolveTerminalTheme(),
    });
    termRef.current = term;
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    term.attachCustomKeyEventHandler((e) => handleTerminalCopyPasteKeys(term, e));

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

    // Show the toolbar on mouseup (not during drag — parity with
    // useTextSelection's debounce): left button only, and only when xterm
    // actually holds a non-whitespace selection. The rect anchors the toolbar
    // at the release point; xterm's buffer coordinates have no cheap DOM rect.
    let mouseUpTimer: ReturnType<typeof setTimeout> | null = null;
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const { clientX, clientY } = e;
      if (mouseUpTimer) clearTimeout(mouseUpTimer);
      mouseUpTimer = setTimeout(() => {
        const text = term.getSelection();
        if (text.trim()) {
          setSel({ text, rect: new DOMRect(clientX, clientY, 0, 0) });
          setEditing(false);
        }
      }, 120);
    };
    container.addEventListener('mouseup', onMouseUp);

    // Dismissals — all skipped while the comment editor is open so a scroll
    // or stray keystroke doesn't discard typed text (parity with the doc
    // layer). The commit path uses the text captured at mouseup, so a later
    // selection collapse can't lose the reference content.
    const dismiss = () => {
      if (editingRef.current) return;
      setSel((s) => (s ? null : s));
    };
    const selectionDisposable = term.onSelectionChange(() => {
      if (!term.hasSelection()) dismiss();
    });
    const scrollDisposable = term.onScroll(dismiss);
    window.addEventListener('resize', dismiss);

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
          // Typing while the toolbar is up means the user moved on — dismiss.
          dismiss();
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
      if (mouseUpTimer) clearTimeout(mouseUpTimer);
      resizeObserver.disconnect();
      container.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('resize', dismiss);
      selectionDisposable.dispose();
      scrollDisposable.dispose();
      unlistenFns.forEach((fn) => fn());
      void invoke('pty_kill', { id: tabId });
      term.dispose();
      termRef.current = null;
      setSel(null);
      setContextMenu(null);
    };
  // t is stable from the i18n singleton; cwdRef is a ref (identity-stable).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // Live-recolor on theme toggle, without touching the pty session above:
  // xterm supports swapping `options.theme` on an existing instance, so a
  // light/dark switch just repaints instead of tearing down the terminal.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = resolveTerminalTheme();
  }, [isDark]);

  // Context menu: dismiss on any outside mousedown or Escape (same lifecycle
  // as TabStrip's tab context menu).
  useEffect(() => {
    if (!contextMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-terminal-context-menu]')) return;
      setContextMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  const openContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const term = termRef.current;
    if (!term) return;
    setContextMenu({ x: e.clientX, y: e.clientY, hasSelection: term.hasSelection() });
  }, []);

  const menuAction = useCallback((action: 'copy' | 'paste' | 'selectAll') => {
    const term = termRef.current;
    setContextMenu(null);
    if (!term) return;
    if (action === 'copy') copyTerminalSelection(term);
    else if (action === 'paste') void pasteClipboardIntoTerminal(term);
    else term.selectAll();
    term.focus();
  }, []);

  const commitSelection = useCallback(
    (comment?: string) => {
      if (!sel) return;
      // getI18n(), not the hook's `t`: keeps this callback stable and the
      // reference name correct even if the locale flipped mid-selection.
      const ref = createDocReference({
        path: `terminal://${tabId}`,
        name: getI18n().workspace.terminalTitle,
        docType: 'text',
        text: sel.text,
        comment,
      });
      useChatStore.getState().addPendingReference(ref);
      termRef.current?.clearSelection();
      setSel(null);
      setEditing(false);
    },
    [sel, tabId],
  );

  const menuItemClass =
    'w-full text-left px-3 py-1.5 text-minor text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        className="h-full w-full overflow-hidden px-2 py-1"
        onContextMenu={openContextMenu}
      />
      {contextMenu && (
        <div
          data-terminal-context-menu
          className="fixed z-[60] min-w-[150px] rounded-md border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] shadow-md py-1"
          style={{
            top: Math.min(contextMenu.y, window.innerHeight - 120),
            left: Math.min(contextMenu.x, window.innerWidth - 158),
          }}
        >
          <button
            type="button"
            className={menuItemClass}
            disabled={!contextMenu.hasSelection}
            onClick={() => menuAction('copy')}
          >
            {t.workspace.terminalCopy}
          </button>
          <button type="button" className={menuItemClass} onClick={() => menuAction('paste')}>
            {t.workspace.terminalPaste}
          </button>
          <button type="button" className={menuItemClass} onClick={() => menuAction('selectAll')}>
            {t.workspace.terminalSelectAll}
          </button>
        </div>
      )}
      {sel && (
        <SelectionToolbar
          rect={sel.rect}
          editing={editing}
          onEditingChange={setEditing}
          onAdd={() => commitSelection()}
          onComment={(c) => commitSelection(c)}
          onDismiss={() => {
            setSel(null);
            setEditing(false);
          }}
          enableKeyboard={false}
        />
      )}
    </div>
  );
}
