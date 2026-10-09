// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
/**
 * The 「最大轮次」 row only (the rest of the page is in GeneralSection.test.tsx):
 * the control saves finite and unlimited choices, and the row lines up with
 * the other controls in the column.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
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

function renderSection() {
  return render(<GeneralSection />, { wrapper: DesignSystemProvider });
}

/** The row's select, named after the row. */
function trigger() {
  return screen.getByRole('combobox', { name: getI18n().settings.agentMaxTurns });
}

/** The open list's options. */
function menuItems() {
  return screen.getAllByRole('option');
}

describe('GeneralSection · 最大轮次', () => {
  beforeAll(() => {
    // happy-dom lacks the pointer-capture and scroll calls Radix Select makes while opening.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => undefined;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
  });

  beforeEach(() => {
    initLanguage('zh-CN');
    vi.clearAllMocks();
    settingsState.agentMaxTurns = undefined;
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the built-in default when nothing has been set', () => {
    renderSection();

    expect(trigger()).toHaveTextContent('200 轮');
  });

  it('shows the saved value once one exists', () => {
    settingsState.agentMaxTurns = 500;
    renderSection();

    expect(trigger()).toHaveTextContent('500 轮');
  });

  it('saves the picked value', async () => {
    renderSection();

    await userEvent.click(trigger());
    await userEvent.click(menuItems().find((b) => b.textContent === '500 轮')!);

    expect(mockSetAgentMaxTurns).toHaveBeenCalledWith(500);
  });

  it('offers unlimited after the finite presets', async () => {
    renderSection();

    await userEvent.click(trigger());
    const offered = menuItems().map((o) => o.textContent);

    expect(offered).toEqual(['50 轮', '100 轮', '200 轮', '500 轮', '1000 轮', '不限制']);
    await userEvent.click(menuItems().find((b) => b.textContent === '不限制')!);
    expect(mockSetAgentMaxTurns).toHaveBeenCalledWith(0);
  });

  it('shows the saved unlimited choice', async () => {
    settingsState.agentMaxTurns = 0;
    renderSection();

    expect(trigger()).toHaveTextContent('不限制');
  });

  it('lines the control up with the other rows in the column', () => {
    renderSection();

    // Every select on the page shares one wrapper width, so the column of controls is
    // flush (each select fills its wrapper). Appearance is a segmented control, not a select.
    expect(document.querySelectorAll('.w-40').length).toBe(4);
  });
});
