/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalTab from './TerminalTab';
import { initLanguage } from '@/i18n';

interface FakeTerminalInstance {
  options: Record<string, unknown>;
  cols: number;
  rows: number;
}

const terminalInstances: FakeTerminalInstance[] = [];

vi.mock('@xterm/xterm', () => {
  class FakeTerminal implements FakeTerminalInstance {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
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

// Two distinct fake palettes so a light/dark toggle produces a visible diff.
const LIGHT_VARS: Record<string, string> = {
  '--abu-bg-base': '#fdfcf9',
  '--abu-text-primary': '#141413',
  '--abu-clay': '#d97757',
};
const DARK_VARS: Record<string, string> = {
  '--abu-bg-base': '#1f1d1b',
  '--abu-text-primary': '#f0ede8',
  '--abu-clay': '#d97757',
};

describe('TerminalTab theming', () => {
  beforeEach(() => {
    initLanguage('en-US');
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    listen.mockReset();
    listen.mockResolvedValue(() => {});
    terminalInstances.length = 0;
    document.documentElement.classList.remove('dark');

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

  it('builds the terminal with theme colors read from the app\'s --abu-* tokens, not a hardcoded palette', async () => {
    render(<TerminalTab tabId="terminal-theme-initial" />);

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(1);
    });
    expect(terminalInstances[0].options.theme).toEqual({
      background: LIGHT_VARS['--abu-bg-base'],
      foreground: LIGHT_VARS['--abu-text-primary'],
      cursor: LIGHT_VARS['--abu-clay'],
    });
  });

  it('repaints the existing terminal on a light/dark toggle without killing the pty session', async () => {
    render(<TerminalTab tabId="terminal-theme-toggle" />);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('pty_spawn', expect.objectContaining({ id: 'terminal-theme-toggle' }));
    });
    const spawnCallsBefore = invoke.mock.calls.filter(([cmd]) => cmd === 'pty_spawn').length;
    const killCallsBefore = invoke.mock.calls.filter(([cmd]) => cmd === 'pty_kill').length;

    act(() => {
      document.documentElement.classList.add('dark');
    });

    // The MutationObserver callback (useEffectiveThemeIsDark) fires off a
    // microtask checkpoint, not synchronously — under CI resource contention
    // (observed on Windows runners) it can take a couple of seconds, so this
    // needs real headroom. Vitest's per-test timeout defaults to 5s and is
    // deliberately not raised project-wide (vitest.config.ts), so a waitFor
    // timeout anywhere near that just loses the race against the *outer*
    // test timeout before it ever gets to report its own diff — hence the
    // explicit, larger `it(...)` timeout below alongside this one.
    await waitFor(() => {
      expect(terminalInstances[0].options.theme).toEqual({
        background: DARK_VARS['--abu-bg-base'],
        foreground: DARK_VARS['--abu-text-primary'],
        cursor: DARK_VARS['--abu-clay'],
      });
    }, { timeout: 12000 });

    // Still the same single terminal instance — no dispose/recreate cycle.
    expect(terminalInstances).toHaveLength(1);
    const spawnCallsAfter = invoke.mock.calls.filter(([cmd]) => cmd === 'pty_spawn').length;
    const killCallsAfter = invoke.mock.calls.filter(([cmd]) => cmd === 'pty_kill').length;
    expect(spawnCallsAfter).toBe(spawnCallsBefore);
    expect(killCallsAfter).toBe(killCallsBefore);
  }, 15000);
});
