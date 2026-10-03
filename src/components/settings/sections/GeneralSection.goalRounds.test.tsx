// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
/**
 * The 「目标模式默认轮数」 row only (goal mode). Pins that the row shows the
 * built-in default, saves the picked budget, and keeps a value set elsewhere
 * selectable instead of silently snapping it to a preset.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLanguageSetting, initLanguage } from '@/i18n';
import GeneralSection from './GeneralSection';

const mockSetAgentMaxTurns = vi.fn();
const mockSetGoalDefaultMaxRounds = vi.fn();

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
  goalDefaultMaxRounds: undefined,
  setGoalDefaultMaxRounds: mockSetGoalDefaultMaxRounds,
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

function row() {
  return screen.getByTestId('settings-goal-rounds');
}

function trigger() {
  return within(row()).getByRole('button');
}

/** The open menu is portaled; its items are the 「N 轮」 buttons outside every row. */
function menuItems() {
  return screen.getAllByRole('button')
    .filter((b) => !b.closest('[data-testid="settings-goal-rounds"]'))
    .filter((b) => /^\d+ 轮$/.test(b.textContent ?? ''))
    // The max-turns row's trigger comes first in DOM order.
    .slice(1);
}

describe('GeneralSection · 目标模式默认轮数', () => {
  let previousLanguage: ReturnType<typeof getLanguageSetting>;

  beforeEach(() => {
    previousLanguage = getLanguageSetting();
    initLanguage('zh-CN');
    vi.clearAllMocks();
    settingsState.goalDefaultMaxRounds = undefined;
  });

  afterEach(() => {
    cleanup();
    initLanguage(previousLanguage);
  });

  it('shows the built-in default when nothing has been set', () => {
    render(<GeneralSection />);
    expect(within(row()).getByText('目标模式默认轮数')).toBeInTheDocument();
    expect(trigger()).toHaveTextContent('256 轮');
  });

  it('saves the picked budget', async () => {
    render(<GeneralSection />);
    await userEvent.click(trigger());
    expect(menuItems().map((b) => b.textContent)).toEqual(['20 轮', '50 轮', '100 轮', '256 轮', '500 轮', '1000 轮']);
    await userEvent.click(menuItems().find((b) => b.textContent === '50 轮')!);
    expect(mockSetGoalDefaultMaxRounds).toHaveBeenCalledWith(50);
  });

  it('keeps a value set elsewhere selectable', async () => {
    settingsState.goalDefaultMaxRounds = 30;
    render(<GeneralSection />);
    expect(trigger()).toHaveTextContent('30 轮');
    await userEvent.click(trigger());
    expect(menuItems().map((b) => b.textContent)).toContain('30 轮');
  });
});
