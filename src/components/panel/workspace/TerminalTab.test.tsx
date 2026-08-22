// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalTab, { handleTerminalCopyPasteKeys } from './TerminalTab';
import type { Terminal } from '@xterm/xterm';
import { getI18n, initLanguage } from '@/i18n';
import { isMacOS } from '@/utils/platform';
import { useChatStore } from '@/stores/chatStore';

interface FakeTerminalInstance {
  options: Record<string, unknown>;
  cols: number;
  rows: number;
  selection: string;
  clearSelection: () => void;
  selectAll: () => void;
  paste: (text: string) => void;
  focus: () => void;
}

const terminalInstances: FakeTerminalInstance[] = [];

vi.mock('@xterm/xterm', () => {
  class FakeTerminal implements FakeTerminalInstance {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    /** Test hook: what getSelection()/hasSelection() report. */
    selection = '';
    constructor(opts: Record<string, unknown>) {
      // xterm's real `options` is a live object whose properties can be
      // reassigned post-construction to repaint — mirror that shape here.
      this.options = { ...opts };
      terminalInstances.push(this);
    }
    loadAddon() {}
    open() {}
    write() {}
    onData() {}
    onSelectionChange() {
      return { dispose: () => {} };
    }
    onScroll() {
      return { dispose: () => {} };
    }
    attachCustomKeyEventHandler() {}
    getSelection() {
      return this.selection;
    }
    hasSelection() {
      return this.selection.length > 0;
    }
    clearSelection = vi.fn(() => {
      this.selection = '';
    });
    selectAll = vi.fn();
    paste = vi.fn();
    focus = vi.fn();
    dispose() {}
  }
  return { Terminal: FakeTerminal };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

const invoke = vi.fn();
const listen = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listen(...args),
}));

vi.mock('@/utils/platform', () => ({
  isMacOS: vi.fn(() => true),
  isWindows: vi.fn(() => false),
}));

// Two distinct fake palettes so a light/dark toggle produces a visible diff.
const LIGHT_VARS: Record<string, string> = {
  '--abu-bg-base': '#fdfcf9',
  '--abu-text-primary': '#141413',
  '--abu-clay': '#d97757',
  '--abu-clay-20': 'rgba(217, 119, 87, 0.2)',
};
const DARK_VARS: Record<string, string> = {
  '--abu-bg-base': '#1f1d1b',
  '--abu-text-primary': '#f0ede8',
  '--abu-clay': '#d97757',
  '--abu-clay-20': 'rgba(217, 119, 87, 0.2)',
};

function expectedTheme(vars: Record<string, string>) {
  return {
    background: vars['--abu-bg-base'],
    foreground: vars['--abu-text-primary'],
    cursor: vars['--abu-clay'],
    selectionBackground: vars['--abu-clay-20'],
  };
}

const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
const clipboardReadText = vi.fn().mockResolvedValue('');

beforeEach(() => {
  initLanguage('en-US');
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  listen.mockReset();
  listen.mockResolvedValue(() => {});
  terminalInstances.length = 0;
  document.documentElement.classList.remove('dark');
  vi.mocked(isMacOS).mockReturnValue(true);
  clipboardWriteText.mockClear();
  clipboardReadText.mockClear();
  clipboardReadText.mockResolvedValue('');
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: clipboardWriteText, readText: clipboardReadText },
    configurable: true,
  });
  useChatStore.setState({ pendingReferences: [] });

  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
    const vars = document.documentElement.classList.contains('dark') ? DARK_VARS : LIGHT_VARS;
    return {
      getPropertyValue: (name: string) => vars[name] ?? '',
    } as CSSStyleDeclaration;
  });
});

afterEach(() => {
  document.documentElement.classList.remove('dark');
  cleanup();
  vi.restoreAllMocks();
});

describe('TerminalTab theming', () => {
  it('builds the terminal with theme colors read from the app\'s --abu-* tokens, not a hardcoded palette', async () => {
    render(<TerminalTab tabId="terminal-theme-initial" />);

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(1);
    });
    expect(terminalInstances[0].options.theme).toEqual(expectedTheme(LIGHT_VARS));
  });

  it('sets an explicit selectionBackground — xterm\'s white default is invisible on the light theme', async () => {
    render(<TerminalTab tabId="terminal-theme-selection" />);

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(1);
    });
    const theme = terminalInstances[0].options.theme as { selectionBackground?: string };
    expect(theme.selectionBackground).toBe(LIGHT_VARS['--abu-clay-20']);
  });

  it('repaints the existing terminal on a light/dark toggle without killing the pty session', async () => {
    render(<TerminalTab tabId="terminal-theme-toggle" />);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('pty_spawn', expect.objectContaining({ id: 'terminal-theme-toggle' }));
    });
    const spawnCallsBefore = invoke.mock.calls.filter(([cmd]) => cmd === 'pty_spawn').length;
    const killCallsBefore = invoke.mock.calls.filter(([cmd]) => cmd === 'pty_kill').length;

    // Deterministic, not clock-based: the MutationObserver callback
    // (useEffectiveThemeIsDark) is delivered on the task queue and the theme
    // repaint runs in a React effect — one awaited macrotask turn inside act()
    // covers both, regardless of how slow the runner is. The previous
    // real-time waitFor (even at 12s) still lost this race once on a
    // contended Windows runner; event ordering cannot.
    await act(async () => {
      document.documentElement.classList.add('dark');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(terminalInstances[0].options.theme).toEqual(expectedTheme(DARK_VARS));

    // Still the same single terminal instance — no dispose/recreate cycle.
    expect(terminalInstances).toHaveLength(1);
    const spawnCallsAfter = invoke.mock.calls.filter(([cmd]) => cmd === 'pty_spawn').length;
    const killCallsAfter = invoke.mock.calls.filter(([cmd]) => cmd === 'pty_kill').length;
    expect(spawnCallsAfter).toBe(spawnCallsBefore);
    expect(killCallsAfter).toBe(killCallsBefore);
  });
});

describe('handleTerminalCopyPasteKeys', () => {
  function fakeTerm(selection: string) {
    return {
      getSelection: () => selection,
      hasSelection: () => selection.length > 0,
      clearSelection: vi.fn(),
      paste: vi.fn(),
    } as unknown as Terminal;
  }
  const keydown = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

  it('Ctrl+Shift+C copies the selection and is not sent to the pty', () => {
    const term = fakeTerm('ls -la');
    const handled = handleTerminalCopyPasteKeys(term, keydown({ key: 'C', ctrlKey: true, shiftKey: true }));
    expect(handled).toBe(false);
    expect(clipboardWriteText).toHaveBeenCalledWith('ls -la');
  });

  it('Ctrl+Shift+V pastes from the clipboard and is not sent to the pty', async () => {
    clipboardReadText.mockResolvedValue('echo hi');
    const term = fakeTerm('');
    const handled = handleTerminalCopyPasteKeys(term, keydown({ key: 'V', ctrlKey: true, shiftKey: true }));
    expect(handled).toBe(false);
    await waitFor(() => {
      expect(term.paste).toHaveBeenCalledWith('echo hi');
    });
  });

  it('on Windows, Ctrl+C with an active selection copies and clears it instead of sending SIGINT', () => {
    vi.mocked(isMacOS).mockReturnValue(false);
    const term = fakeTerm('npm test');
    const handled = handleTerminalCopyPasteKeys(term, keydown({ key: 'c', ctrlKey: true }));
    expect(handled).toBe(false);
    expect(clipboardWriteText).toHaveBeenCalledWith('npm test');
    expect(term.clearSelection).toHaveBeenCalled();
  });

  it('on Windows, Ctrl+C without a selection stays SIGINT (passes through to the pty)', () => {
    vi.mocked(isMacOS).mockReturnValue(false);
    const term = fakeTerm('');
    expect(handleTerminalCopyPasteKeys(term, keydown({ key: 'c', ctrlKey: true }))).toBe(true);
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it('on macOS, Ctrl+C always passes through (⌘C handles copy via the app menu)', () => {
    const term = fakeTerm('selected');
    expect(handleTerminalCopyPasteKeys(term, keydown({ key: 'c', ctrlKey: true }))).toBe(true);
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });
});

describe('TerminalTab context menu', () => {
  it('right-click opens a copy/paste/select-all menu; copy is disabled without a selection', async () => {
    const { container } = render(<TerminalTab tabId="terminal-menu-empty" />);
    await waitFor(() => expect(terminalInstances).toHaveLength(1));
    const host = container.querySelector('div.overflow-hidden') as HTMLDivElement;

    fireEvent.contextMenu(host, { clientX: 40, clientY: 40 });

    const t = getI18n();
    const copyBtn = screen.getByRole('button', { name: t.workspace.terminalCopy });
    expect(copyBtn).toBeDisabled();
    expect(screen.getByRole('button', { name: t.workspace.terminalPaste })).toBeEnabled();
    expect(screen.getByRole('button', { name: t.workspace.terminalSelectAll })).toBeEnabled();
  });

  it('copy writes the terminal selection to the clipboard; paste feeds clipboard text into the terminal', async () => {
    clipboardReadText.mockResolvedValue('pasted-text');
    const { container } = render(<TerminalTab tabId="terminal-menu-actions" />);
    await waitFor(() => expect(terminalInstances).toHaveLength(1));
    const term = terminalInstances[0];
    const host = container.querySelector('div.overflow-hidden') as HTMLDivElement;
    const t = getI18n();

    term.selection = 'copied-output';
    fireEvent.contextMenu(host, { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole('button', { name: t.workspace.terminalCopy }));
    expect(clipboardWriteText).toHaveBeenCalledWith('copied-output');
    expect(term.focus).toHaveBeenCalled();

    fireEvent.contextMenu(host, { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole('button', { name: t.workspace.terminalPaste }));
    await waitFor(() => {
      expect(term.paste).toHaveBeenCalledWith('pasted-text');
    });
  });
});

describe('TerminalTab selection → add to chat', () => {
  it('shows the selection toolbar on mouseup over a selection, and "Add to chat" pushes a terminal reference', async () => {
    const { container } = render(<TerminalTab tabId="terminal-selection-ref" />);
    await waitFor(() => expect(terminalInstances).toHaveLength(1));
    const term = terminalInstances[0];
    const host = container.querySelector('div.overflow-hidden') as HTMLDivElement;

    term.selection = 'error: ENOENT no such file';
    fireEvent.mouseUp(host, { button: 0, clientX: 100, clientY: 100 });

    const t = getI18n();
    const addBtn = await screen.findByRole('button', { name: new RegExp(t.reference.addToChat) });
    fireEvent.click(addBtn);

    const refs = useChatStore.getState().pendingReferences;
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      kind: 'doc-selection',
      source: {
        path: 'terminal://terminal-selection-ref',
        name: t.workspace.terminalTitle,
        docType: 'text',
      },
      selection: { text: 'error: ENOENT no such file' },
    });
    // Committing clears the terminal selection and dismisses the toolbar.
    expect(term.clearSelection).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: new RegExp(t.reference.addToChat) })).toBeNull();
    });
  });

  it('does not show the toolbar when mouseup yields only whitespace selection', async () => {
    const { container } = render(<TerminalTab tabId="terminal-selection-ws" />);
    await waitFor(() => expect(terminalInstances).toHaveLength(1));
    terminalInstances[0].selection = '   \n  ';
    const host = container.querySelector('div.overflow-hidden') as HTMLDivElement;

    fireEvent.mouseUp(host, { button: 0, clientX: 50, clientY: 50 });

    // Debounce window (120 ms) must elapse before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const t = getI18n();
    expect(screen.queryByRole('button', { name: new RegExp(t.reference.addToChat) })).toBeNull();
  });
});
