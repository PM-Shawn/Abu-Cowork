import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useChatStore } from '@/stores/chatStore';
import { useI18n, format, getI18n } from '@/i18n';
import { createLogger } from '@/core/logging/logger';
import { useTokenRevision } from '@/hooks/useTokenRevision';
import { isMacOS } from '@/utils/platform';
import { ContextMenu } from '@/components/ds/context-menu';
import { MenuItem } from '@/components/ds/menu';
import { SelectionToolbar } from '@/features/reference/SelectionToolbar';
import { createDocReference } from '@/types/chatReference';

const terminalLogger = createLogger('terminal');

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// xterm lifts any cell whose text falls under this contrast against its own background
// (the terminal background, a program-set background, or the selection).
const TERMINAL_MINIMUM_CONTRAST = 4.5;

/**
 * Terminal colors from the design tokens. xterm takes concrete color values only,
 * so the `--ds-*` variables are read here and read again whenever the appearance
 * changes (`useTokenRevision`). `--ds-surface` is the workspace panel card the
 * terminal sits on, so the terminal blends into it.
 *
 * `selectionBackground` MUST be set explicitly: xterm's built-in default is
 * `rgba(255,255,255,0.3)` (white), which is invisible on a white background —
 * users dragged to select and saw nothing, and concluded copying was broken.
 *
 * `cursorAccent` is the character under the block cursor. xterm's default is black,
 * which disappears into a cursor drawn in the label color; the terminal background
 * always contrasts with the label.
 *
 * The 16 ANSI colors stay xterm's defaults: they are the program's output. xterm keeps
 * each cell readable through `minimumContrastRatio` (see TERMINAL_MINIMUM_CONTRAST).
 */
function resolveTerminalTheme(): ITheme {
  return {
    background: readToken('--ds-surface'),
    foreground: readToken('--ds-label'),
    cursor: readToken('--ds-label'),
    cursorAccent: readToken('--ds-surface'),
    selectionBackground: readToken('--ds-selection'),
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

type TerminalMenuAction = 'copy' | 'paste' | 'selectAll';

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
  // Only the workspace path: the conversation object is replaced on every streamed
  // token, and subscribing to it would re-render the terminal and its menu each time.
  const workspacePath = useChatStore((s) => (
    s.activeConversationId ? s.conversations[s.activeConversationId]?.workspacePath : undefined
  ));
  const { t } = useI18n();
  const tokenRevision = useTokenRevision();
  // Whether Copy applies, read from xterm each time the menu opens.
  const [hasSelection, setHasSelection] = useState(false);
  // What the menu will do once it has closed (see handleMenuCloseAutoFocus).
  const pendingActionRef = useRef<TerminalMenuAction | null>(null);
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
  const cwdRef = useRef<string | undefined>(workspacePath ?? undefined);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      // 13px is the code size of the design system (`--text-mono`).
      fontSize: 13,
      fontFamily: readToken('--ds-font-mono'),
      cursorBlink: true,
      convertEol: false,
      minimumContrastRatio: TERMINAL_MINIMUM_CONTRAST,
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
    };
  // t is stable from the i18n singleton; cwdRef is a ref (identity-stable).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // Live-recolor when the appearance changes (light/dark, increased contrast),
  // without touching the pty session above: xterm supports swapping `options.theme`
  // on an existing instance, so the terminal repaints and keeps its buffer.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = resolveTerminalTheme();
  }, [tokenRevision]);

  const handleMenuOpenChange = useCallback((open: boolean) => {
    if (!open) return;
    pendingActionRef.current = null;
    setHasSelection(termRef.current?.hasSelection() ?? false);
  }, []);

  // The menu holds the keyboard while it is open. Its items only record what to do;
  // the action runs here, after the menu has gone, and the terminal takes the keyboard
  // back so typing continues.
  const handleMenuCloseAutoFocus = useCallback((event: Event) => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    // Another layer took the menu's place and holds the keyboard now.
    if (event.defaultPrevented) return;
    event.preventDefault();
    const term = termRef.current;
    if (!term) return;
    if (action === 'copy') copyTerminalSelection(term);
    else if (action === 'paste') void pasteClipboardIntoTerminal(term);
    else if (action === 'selectAll') term.selectAll();
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

  return (
    <div className="relative h-full w-full">
      <ContextMenu
        onOpenChange={handleMenuOpenChange}
        onCloseAutoFocus={handleMenuCloseAutoFocus}
        content={(
          <>
            <MenuItem disabled={!hasSelection} onSelect={() => { pendingActionRef.current = 'copy'; }}>
              {t.workspace.terminalCopy}
            </MenuItem>
            <MenuItem onSelect={() => { pendingActionRef.current = 'paste'; }}>
              {t.workspace.terminalPaste}
            </MenuItem>
            <MenuItem onSelect={() => { pendingActionRef.current = 'selectAll'; }}>
              {t.workspace.terminalSelectAll}
            </MenuItem>
          </>
        )}
      >
        <div ref={containerRef} className="h-full w-full overflow-hidden px-2 py-1" />
      </ContextMenu>
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
