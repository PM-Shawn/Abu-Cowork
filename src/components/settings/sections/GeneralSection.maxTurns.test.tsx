// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
/**
 * The 「最大轮次」 row only. The rest of the General section has no test file,
 * and this deliberately doesn't grow into one — what is worth pinning here is
 * that the control cannot produce a cap that isn't a cap, and that the row
 * lines up with the other controls in the column.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import GeneralSection from './GeneralSection';

const mockSetAgentMaxTurns = vi.fn();

const settingsState: Record<string, unknown> = {
  closeAction: 'ask',
  setCloseAction: vi.fn(),
  language: 'zh-CN',
  setLanguage: vi.fn(),
  behaviorSensorEnabled: false,
  setBehaviorSensorEnabled: vi.fn(),
  preventSleep: false,
  setPreventSleep: vi.fn(),
  composerEnterBehavior: 'enter',
  setComposerEnterBehavior: vi.fn(),
  theme: 'system',
  setTheme: vi.fn(),
  agentMaxTurns: undefined,
  setAgentMaxTurns: mockSetAgentMaxTurns,
};

vi.mock('@/stores/settingsStore', () => {
  const useSettingsStore = ((selector?: (state: typeof settingsState) => unknown) =>
    selector ? selector(settingsState) : settingsState) as {
    (selector?: (state: typeof settingsState) => unknown): unknown;
    getState: () => typeof settingsState;
  };
  useSettingsStore.getState = () => settingsState;
  return { useSettingsStore };
});

vi.mock('@/stores/toastStore', () => ({
  useToastStore: (selector: (state: { addToast: () => void }) => unknown) =>
    selector({ addToast: vi.fn() }),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

vi.mock('@/core/agent/behaviorSensor', () => ({
  clearBehaviorData: vi.fn(),
  testWindowPermission: vi.fn().mockResolvedValue(true),
}));

/**
 * The row's trigger — the only control on the page showing a 「N 轮」 value.
 * While the menu is open its items are buttons too (Select renders plain
 * buttons, not `option` roles), and the portaled menu comes after the trigger
 * in DOM order — so the trigger is always the first match.
 */
function capButtons() {
  return screen.getAllByRole('button')
    .filter((b) => /轮$|不限制/.test(b.textContent ?? ''));
}

function trigger() {
  return capButtons()[0];
}

/** The open menu's items, i.e. everything after the trigger. */
function menuItems() {
  return capButtons().slice(1);
}

describe('GeneralSection · 最大轮次', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    vi.clearAllMocks();
    settingsState.agentMaxTurns = undefined;
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the built-in default when nothing has been set', () => {
    render(<GeneralSection />);

    expect(trigger()).toHaveTextContent('200 轮');
  });

  it('shows the saved value once one exists', () => {
    settingsState.agentMaxTurns = 500;
    render(<GeneralSection />);

    expect(trigger()).toHaveTextContent('500 轮');
  });

  it('saves the picked value', async () => {
    render(<GeneralSection />);

    await userEvent.click(trigger());
    await userEvent.click(menuItems().find((b) => b.textContent === '500 轮')!);

    expect(mockSetAgentMaxTurns).toHaveBeenCalledWith(500);
  });

  it('offers no way to pick "no cap" or an unbounded number', async () => {
    render(<GeneralSection />);

    await userEvent.click(trigger());
    const offered = menuItems().map((o) => o.textContent);

    expect(offered).toEqual(['50 轮', '100 轮', '200 轮', '500 轮', '1000 轮']);
    expect(offered).not.toContain('不限制');
  });

  it('surfaces an out-of-band "no cap" rather than misreporting it as 200', async () => {
    // Only reachable by hand-editing config, but the row must not claim a cap
    // is in force when the loop is running without one.
    settingsState.agentMaxTurns = 0;
    render(<GeneralSection />);

    expect(trigger()).toHaveTextContent('不限制');
  });

  it('lines the control up with the other rows in the column', () => {
    render(<GeneralSection />);

    // Every settings row's control shares one wrapper width, so the column of
    // controls is flush rather than ragged (each Select is `w-full` inside it).
    const wrappers = document.querySelectorAll('.w-40.shrink-0');
    expect(wrappers.length).toBe(5);
  });
});
