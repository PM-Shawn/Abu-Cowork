// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalTab, { handleTerminalCopyPasteKeys } from './TerminalTab';
import type { Terminal } from '@xterm/xterm';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import { isMacOS } from '@/utils/platform';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation } from '@/types';

interface FakeTerminalInstance {
  options: Record<string, unknown>;
  cols: number;
  rows: number;
  selection: string;
  clearSelection: () => void;
  selectAll: () => void;
  paste: (text: string) => void;
  focus: () => void;
  dispose: () => void;
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
    dispose = vi.fn();
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

const contextMenu = vi.hoisted(() => ({ renders: 0 }));

// The real menu, with its renders counted: the terminal must not re-render the menu
// while a reply streams into the conversation.
vi.mock('@/components/ds/context-menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/context-menu')>();
  return {
    ContextMenu: (props: Parameters<typeof actual.ContextMenu>[0]) => {
      contextMenu.renders += 1;
      return <actual.ContextMenu {...props} />;
    },
  };
});

// One set of values per appearance, so every appearance change produces a visible diff.
const FONT_MONO = '"SF Mono", ui-monospace, monospace';
const LIGHT_VARS: Record<string, string> = {
  '--ds-surface': '#ffffff',
  '--ds-label': '#1d1d1f',
  '--ds-selection': 'rgba(0, 0, 0, 0.12)',
  '--ds-font-mono': FONT_MONO,
};
const DARK_VARS: Record<string, string> = {
  '--ds-surface': '#1c1c1e',
  '--ds-label': '#f5f5f7',
  '--ds-selection': 'rgba(255, 255, 255, 0.12)',
  '--ds-font-mono': FONT_MONO,
};
const LIGHT_CONTRAST_VARS: Record<string, string> = {
  '--ds-surface': '#ffffff',
  '--ds-label': '#000000',
  '--ds-selection': 'rgba(0, 0, 0, 0.18)',
  '--ds-font-mono': FONT_MONO,
};

function currentVars(): Record<string, string> {
  const root = document.documentElement;
  if (root.classList.contains('dark')) return DARK_VARS;
  return root.getAttribute('data-contrast') === 'more' ? LIGHT_CONTRAST_VARS : LIGHT_VARS;
}

function expectedTheme(vars: Record<string, string>) {
  return {
    background: vars['--ds-surface'],
    foreground: vars['--ds-label'],
    cursor: vars['--ds-label'],
    cursorAccent: vars['--ds-surface'],
    selectionBackground: vars['--ds-selection'],
  };
}

const CONVERSATION_ID = 'conv-terminal';

function conversation(): Conversation {
  return {
    id: CONVERSATION_ID,
    title: 'Terminal',
    messages: [
      { id: 'm1', role: 'user', content: 'Write a long answer', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'Once', timestamp: 2 },
    ],
    createdAt: 1,
    updatedAt: 1,
    status: 'running',
    workspacePath: '/workspace/terminal',
  };
}

function appendToLastMessage(text: string) {
  const { conversations } = useChatStore.getState();
  const current = conversations[CONVERSATION_ID];
  const last = current.messages[current.messages.length - 1];
  useChatStore.setState({
    conversations: {
      ...conversations,
      [CONVERSATION_ID]: {
        ...current,
        messages: [...current.messages.slice(0, -1), { ...last, content: `${last.content}${text}` }],
      },
    },
  });
}

function renderTerminal(tabId: string) {
  return render(
    <DesignSystemProvider>
      <TerminalTab tabId={tabId} />
    </DesignSystemProvider>,
  );
}

// A dialog opened by code, the way an approval request arrives while the user works.
function HostWithDialog({ tabId }: { tabId: string }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <DesignSystemProvider>
      <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
      <Dialog title="Approval" open={dialogOpen} onOpenChange={setDialogOpen}>Dialog body</Dialog>
      <TerminalTab tabId={tabId} />
    </DesignSystemProvider>
  );
}

function terminalHost(container: HTMLElement): HTMLDivElement {
  const host = container.querySelector<HTMLDivElement>('div.overflow-hidden');
  if (!host) throw new Error('the terminal host is not mounted');
  return host;
}

function ptyCalls(command: string): number {
  return invoke.mock.calls.filter(([cmd]) => cmd === command).length;
}

// The MutationObserver callback (useTokenRevision) is delivered on the task queue and
// the repaint runs in a React effect — one awaited turn of the fake clock inside act()
// covers both, however slow the runner is.
async function changeAppearance(mutate: () => void): Promise<void> {
  vi.useFakeTimers();
  try {
    await act(async () => {
      mutate();
      await vi.advanceTimersByTimeAsync(0);
    });
  } finally {
    vi.useRealTimers();
  }
}

const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
const clipboardReadText = vi.fn().mockResolvedValue('');
const realGetComputedStyle = window.getComputedStyle.bind(window);

function installClipboardMock() {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: clipboardWriteText, readText: clipboardReadText },
    configurable: true,
  });
}

beforeAll(() => {
  // happy-dom has no pointer capture; Radix menus call it.
  HTMLElement.prototype.setPointerCapture ??= () => {};
  HTMLElement.prototype.releasePointerCapture ??= () => {};
  HTMLElement.prototype.hasPointerCapture ??= () => false;
  HTMLElement.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  initLanguage('en-US');
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  listen.mockReset();
  listen.mockResolvedValue(() => {});
  terminalInstances.length = 0;
  contextMenu.renders = 0;
  document.documentElement.classList.remove('dark');
  document.documentElement.removeAttribute('data-contrast');
  document.documentElement.removeAttribute('data-transparency');
  vi.mocked(isMacOS).mockReturnValue(true);
  clipboardWriteText.mockClear();
  clipboardReadText.mockClear();
  clipboardReadText.mockResolvedValue('');
  installClipboardMock();
  useChatStore.setState({ pendingReferences: [], conversations: {}, activeConversationId: null });

  // The design tokens come from tokens.css, which the test page does not load: answer
  // for the variables on <html> and leave every other style lookup to happy-dom.
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const real = realGetComputedStyle(element, pseudo);
    if (element !== document.documentElement) return real;
    return new Proxy(real, {
      get(target, property) {
        if (property === 'getPropertyValue') {
          return (name: string) => currentVars()[name] ?? target.getPropertyValue(name);
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
});

afterEach(() => {
  document.documentElement.classList.remove('dark');
  document.documentElement.removeAttribute('data-contrast');
  document.documentElement.removeAttribute('data-transparency');
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TerminalTab theming', () => {
  it('builds the terminal with colors read from the design tokens', async () => {
    renderTerminal('terminal-theme-initial');

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(1);
    });
    expect(terminalInstances[0].options.theme).toEqual(expectedTheme(LIGHT_VARS));
    expect(terminalInstances[0].options.fontFamily).toBe(FONT_MONO);
    expect(terminalInstances[0].options.fontSize).toBe(13);
  });

  it('sets an explicit selectionBackground — xterm\'s white default is invisible on the light theme', async () => {
    renderTerminal('terminal-theme-selection');

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(1);
    });
    const theme = terminalInstances[0].options.theme as { selectionBackground?: string };
    expect(theme.selectionBackground).toBe(LIGHT_VARS['--ds-selection']);
  });

  it('asks xterm to keep program output readable on the terminal background', async () => {
    renderTerminal('terminal-theme-min-contrast');

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(1);
    });
    expect(terminalInstances[0].options.minimumContrastRatio).toBe(4.5);
  });

  it('keeps the character under the block cursor readable: it takes the terminal background', async () => {
    renderTerminal('terminal-theme-cursor');

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(1);
    });
    const theme = terminalInstances[0].options.theme as { cursor?: string; cursorAccent?: string };
    expect(theme.cursor).toBe(LIGHT_VARS['--ds-label']);
    expect(theme.cursorAccent).toBe(LIGHT_VARS['--ds-surface']);
  });

  it('repaints the existing terminal on a light/dark toggle without killing the pty session', async () => {
    renderTerminal('terminal-theme-toggle');

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('pty_spawn', expect.objectContaining({ id: 'terminal-theme-toggle' }));
    });
    const spawnCallsBefore = ptyCalls('pty_spawn');
    const killCallsBefore = ptyCalls('pty_kill');

    await changeAppearance(() => document.documentElement.classList.add('dark'));
    expect(terminalInstances[0].options.theme).toEqual(expectedTheme(DARK_VARS));
    expect(terminalInstances[0].options.minimumContrastRatio).toBe(4.5);

    // Still the same single terminal instance — no dispose/recreate cycle.
    expect(terminalInstances).toHaveLength(1);
    expect(terminalInstances[0].dispose).not.toHaveBeenCalled();
    expect(ptyCalls('pty_spawn')).toBe(spawnCallsBefore);
    expect(ptyCalls('pty_kill')).toBe(killCallsBefore);
  });

  it('repaints the existing terminal when increased contrast turns on', async () => {
    renderTerminal('terminal-theme-contrast');

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('pty_spawn', expect.objectContaining({ id: 'terminal-theme-contrast' }));
    });
    expect(terminalInstances[0].options.theme).toEqual(expectedTheme(LIGHT_VARS));

    await changeAppearance(() => document.documentElement.setAttribute('data-contrast', 'more'));
    expect(terminalInstances[0].options.theme).toEqual(expectedTheme(LIGHT_CONTRAST_VARS));
    expect(terminalInstances[0].options.minimumContrastRatio).toBe(4.5);

    expect(terminalInstances).toHaveLength(1);
    expect(terminalInstances[0].dispose).not.toHaveBeenCalled();
    expect(ptyCalls('pty_spawn')).toBe(1);
    expect(ptyCalls('pty_kill')).toBe(0);
  });
});

describe('TerminalTab working directory', () => {
  it('starts the shell in the workspace of the active conversation', async () => {
    useChatStore.setState({
      conversations: { [CONVERSATION_ID]: conversation() },
      activeConversationId: CONVERSATION_ID,
    });
    renderTerminal('terminal-cwd');

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('pty_spawn', expect.objectContaining({
        id: 'terminal-cwd',
        cwd: '/workspace/terminal',
      }));
    });
  });

  it('leaves the directory to the shell when no conversation is active', async () => {
    renderTerminal('terminal-cwd-none');

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('pty_spawn', expect.objectContaining({ id: 'terminal-cwd-none' }));
    });
    const spawn = invoke.mock.calls.find(([cmd]) => cmd === 'pty_spawn');
    expect((spawn?.[1] as { cwd?: string }).cwd).toBeUndefined();
  });
});

describe('TerminalTab render count', () => {
  it('keeps the menu still while the last message streams in', async () => {
    useChatStore.setState({
      conversations: { [CONVERSATION_ID]: conversation() },
      activeConversationId: CONVERSATION_ID,
    });
    renderTerminal('terminal-render-count');
    await waitFor(() => expect(terminalInstances).toHaveLength(1));
    await act(async () => {});
    const before = contextMenu.renders;
    expect(before).toBeGreaterThan(0);

    for (const chunk of [' upon', ' a', ' time']) {
      act(() => appendToLastMessage(chunk));
    }

    const messages = useChatStore.getState().conversations[CONVERSATION_ID].messages;
    expect(messages[messages.length - 1].content).toBe('Once upon a time');
    expect(contextMenu.renders).toBe(before);
    expect(terminalInstances).toHaveLength(1);
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
  // Radix returns focus on a timer once the menu has gone; the fake clock moves on
  // with the test, so nothing here waits on the real one.
  function setupUser() {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // userEvent.setup() installs its own clipboard; the terminal must reach the mock.
    installClipboardMock();
    return user;
  }

  async function mountTerminal(tabId: string) {
    const { container } = renderTerminal(tabId);
    await waitFor(() => expect(terminalInstances).toHaveLength(1));
    return { term: terminalInstances[0], host: terminalHost(container) };
  }

  it('right-click opens a copy/paste/select-all menu; copy is disabled without a selection', async () => {
    const { host } = await mountTerminal('terminal-menu-empty');

    fireEvent.contextMenu(host, { clientX: 40, clientY: 40 });

    const t = getI18n();
    const copy = await screen.findByRole('menuitem', { name: t.workspace.terminalCopy });
    expect(copy).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: t.workspace.terminalPaste })).not.toHaveAttribute('aria-disabled');
    expect(screen.getByRole('menuitem', { name: t.workspace.terminalSelectAll })).not.toHaveAttribute('aria-disabled');
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
  });

  it('copy writes the terminal selection to the clipboard once the menu has gone, and typing continues in the terminal', async () => {
    const user = setupUser();
    const { term, host } = await mountTerminal('terminal-menu-copy');
    const t = getI18n();

    term.selection = 'copied-output';
    fireEvent.contextMenu(host, { clientX: 40, clientY: 40 });
    const copy = await screen.findByRole('menuitem', { name: t.workspace.terminalCopy });
    expect(copy).not.toHaveAttribute('aria-disabled');
    await user.click(copy);

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith('copied-output');
    });
    expect(screen.queryByRole('menuitem', { name: t.workspace.terminalCopy })).toBeNull();
    expect(term.focus).toHaveBeenCalledTimes(1);
  });

  it('paste feeds the clipboard text into the terminal', async () => {
    clipboardReadText.mockResolvedValue('pasted-text');
    const user = setupUser();
    const { term, host } = await mountTerminal('terminal-menu-paste');
    const t = getI18n();

    fireEvent.contextMenu(host, { clientX: 40, clientY: 40 });
    await user.click(await screen.findByRole('menuitem', { name: t.workspace.terminalPaste }));

    await waitFor(() => {
      expect(term.paste).toHaveBeenCalledWith('pasted-text');
    });
    expect(term.focus).toHaveBeenCalledTimes(1);
  });

  it('select all selects the whole buffer', async () => {
    const user = setupUser();
    const { term, host } = await mountTerminal('terminal-menu-select-all');
    const t = getI18n();

    fireEvent.contextMenu(host, { clientX: 40, clientY: 40 });
    await user.click(await screen.findByRole('menuitem', { name: t.workspace.terminalSelectAll }));

    await waitFor(() => {
      expect(term.selectAll).toHaveBeenCalledTimes(1);
    });
    expect(term.focus).toHaveBeenCalledTimes(1);
  });

  it('moving through the menu with the arrow keys does nothing until Enter', async () => {
    clipboardReadText.mockResolvedValue('pasted-text');
    const user = setupUser();
    const { term, host } = await mountTerminal('terminal-menu-keyboard');
    const t = getI18n();

    fireEvent.contextMenu(host, { clientX: 40, clientY: 40 });
    await screen.findByRole('menuitem', { name: t.workspace.terminalPaste });
    await user.keyboard('{ArrowDown}{ArrowDown}');

    expect(clipboardReadText).not.toHaveBeenCalled();
    expect(term.paste).not.toHaveBeenCalled();
    expect(term.selectAll).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: t.workspace.terminalPaste })).toBeInTheDocument();
  });

  it('Escape closes the menu without an action and hands the keyboard back to the terminal', async () => {
    const user = setupUser();
    const { term, host } = await mountTerminal('terminal-menu-escape');
    const t = getI18n();

    term.selection = 'copied-output';
    fireEvent.contextMenu(host, { clientX: 40, clientY: 40 });
    await screen.findByRole('menuitem', { name: t.workspace.terminalCopy });
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(term.focus).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('menuitem', { name: t.workspace.terminalCopy })).toBeNull();
    expect(clipboardWriteText).not.toHaveBeenCalled();
    expect(term.paste).not.toHaveBeenCalled();
    expect(term.selectAll).not.toHaveBeenCalled();
  });

  it('runs a chosen action once: reopening and dismissing the menu does not repeat it', async () => {
    const user = setupUser();
    const { term, host } = await mountTerminal('terminal-menu-once');
    const t = getI18n();

    term.selection = 'copied-output';
    fireEvent.contextMenu(host, { clientX: 40, clientY: 40 });
    await user.click(await screen.findByRole('menuitem', { name: t.workspace.terminalCopy }));
    await waitFor(() => {
      expect(term.focus).toHaveBeenCalledTimes(1);
    });
    expect(clipboardWriteText).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(host, { clientX: 40, clientY: 40 });
    await screen.findByRole('menuitem', { name: t.workspace.terminalCopy });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(term.focus).toHaveBeenCalledTimes(2);
    });

    expect(clipboardWriteText).toHaveBeenCalledTimes(1);
  });

  it('leaves the keyboard with a dialog that takes the place of the menu', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = render(<HostWithDialog tabId="terminal-menu-dialog" />);
    await waitFor(() => expect(terminalInstances).toHaveLength(1));
    const term = terminalInstances[0];
    const t = getI18n();

    fireEvent.contextMenu(terminalHost(container), { clientX: 40, clientY: 40 });
    await screen.findByRole('menuitem', { name: t.workspace.terminalPaste });
    fireEvent.click(screen.getByRole('button', { name: 'Open dialog', hidden: true }));

    await screen.findByRole('dialog', { name: 'Approval' });
    await waitFor(() => {
      expect(screen.queryByRole('menuitem', { name: t.workspace.terminalPaste })).toBeNull();
    });
    // Past the timer Radix returns focus on.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(term.focus).not.toHaveBeenCalled();
  });
});

describe('TerminalTab selection → add to chat', () => {
  it('shows the selection toolbar on mouseup over a selection, and "Add to chat" pushes a terminal reference', async () => {
    const { container } = renderTerminal('terminal-selection-ref');
    await waitFor(() => expect(terminalInstances).toHaveLength(1));
    const term = terminalInstances[0];
    const host = terminalHost(container);

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
    const { container } = renderTerminal('terminal-selection-ws');
    await waitFor(() => expect(terminalInstances).toHaveLength(1));
    terminalInstances[0].selection = '   \n  ';
    const host = terminalHost(container);

    vi.useFakeTimers();
    try {
      fireEvent.mouseUp(host, { button: 0, clientX: 50, clientY: 50 });

      // Advance exactly through the component's 120 ms debounce without making
      // the suite depend on runner speed or wall-clock scheduling.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120);
      });
      const t = getI18n();
      expect(screen.queryByRole('button', { name: new RegExp(t.reference.addToChat) })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
