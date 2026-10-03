// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import GeneralSection from './GeneralSection';

const mocks = vi.hoisted(() => ({
  setTheme: vi.fn(),
  setLanguage: vi.fn(),
  setAgentMaxTurns: vi.fn(),
  setCloseAction: vi.fn(),
  setComposerEnterBehavior: vi.fn(),
  setBehaviorSensorEnabled: vi.fn(),
  setPreventSleep: vi.fn(),
  addToast: vi.fn(),
  invoke: vi.fn(),
  clearBehaviorData: vi.fn(),
  testWindowPermission: vi.fn(),
}));

const settingsState: Record<string, unknown> = {
  closeAction: 'ask',
  setCloseAction: mocks.setCloseAction,
  language: 'zh-CN',
  setLanguage: mocks.setLanguage,
  behaviorSensorEnabled: false,
  setBehaviorSensorEnabled: mocks.setBehaviorSensorEnabled,
  preventSleep: false,
  setPreventSleep: mocks.setPreventSleep,
  composerEnterBehavior: 'enter',
  setComposerEnterBehavior: mocks.setComposerEnterBehavior,
  theme: 'system',
  setTheme: mocks.setTheme,
  agentMaxTurns: undefined,
  setAgentMaxTurns: mocks.setAgentMaxTurns,
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
  useToastStore: { getState: () => ({ addToast: mocks.addToast }) },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

vi.mock('@/core/agent/behaviorSensor', () => ({
  clearBehaviorData: mocks.clearBehaviorData,
  testWindowPermission: mocks.testWindowPermission,
}));

function renderSection() {
  return render(<GeneralSection />, { wrapper: DesignSystemProvider });
}

describe('GeneralSection', () => {
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
    mocks.invoke.mockResolvedValue(undefined);
    mocks.clearBehaviorData.mockResolvedValue(undefined);
    mocks.testWindowPermission.mockResolvedValue(true);
    settingsState.theme = 'system';
    settingsState.agentMaxTurns = undefined;
    settingsState.behaviorSensorEnabled = false;
    settingsState.preventSleep = false;
  });

  afterEach(cleanup);

  describe('appearance', () => {
    const appearance = () => screen.getByRole('group', { name: getI18n().settings.appearance });

    it('offers system, light and dark in that order and marks the current one', () => {
      const t = getI18n().settings;
      settingsState.theme = 'light';
      renderSection();
      const options = within(appearance()).getAllByRole('radio');
      expect(options.map((option) => option.textContent)).toEqual([t.appearanceSystem, t.appearanceLight, t.appearanceDark]);
      expect(options.map((option) => option.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    });

    it('moves only the focus with the arrow keys and applies on Space', async () => {
      const t = getI18n().settings;
      const user = userEvent.setup();
      renderSection();
      const current = within(appearance()).getByRole('radio', { name: t.appearanceSystem });
      current.focus();

      await user.keyboard('{ArrowRight}');
      expect(within(appearance()).getByRole('radio', { name: t.appearanceLight })).toHaveFocus();
      expect(mocks.setTheme).not.toHaveBeenCalled();

      await user.keyboard(' ');
      expect(mocks.setTheme).toHaveBeenCalledOnce();
      expect(mocks.setTheme).toHaveBeenCalledWith('light');
    });

    it('applies the option that is clicked', async () => {
      const user = userEvent.setup();
      renderSection();
      await user.click(within(appearance()).getByRole('radio', { name: getI18n().settings.appearanceDark }));
      expect(mocks.setTheme).toHaveBeenCalledOnce();
      expect(mocks.setTheme).toHaveBeenCalledWith('dark');
    });
  });

  describe('selects', () => {
    it('names each select after its row and gives the four of them one width', () => {
      const t = getI18n().settings;
      renderSection();
      const names = [t.language, t.agentMaxTurns, t.closeWindowBehavior, t.composerEnterBehavior];
      expect(screen.getAllByRole('combobox').map((select) => select.getAttribute('aria-label'))).toEqual(names);
      for (const name of names) {
        expect(screen.getByRole('combobox', { name }).parentElement).toHaveClass('w-40');
      }
    });

    it('saves the choice of each select', async () => {
      const t = getI18n().settings;
      const user = userEvent.setup();
      renderSection();

      await user.click(screen.getByRole('combobox', { name: t.language }));
      await user.click(screen.getByRole('option', { name: 'English' }));
      expect(mocks.setLanguage).toHaveBeenCalledWith('en-US');

      await user.click(screen.getByRole('combobox', { name: t.closeWindowBehavior }));
      await user.click(screen.getByRole('option', { name: t.closeWindowQuit }));
      expect(mocks.setCloseAction).toHaveBeenCalledWith('quit');

      await user.click(screen.getByRole('combobox', { name: t.composerEnterBehavior }));
      await user.click(screen.getAllByRole('option')[1]);
      expect(mocks.setComposerEnterBehavior).toHaveBeenCalledWith('newline');
    });

    it('does not change the turn limit from a key typed on the closed select', async () => {
      const user = userEvent.setup();
      renderSection();
      screen.getByRole('combobox', { name: getI18n().settings.agentMaxTurns }).focus();
      await user.keyboard('5');
      expect(mocks.setAgentMaxTurns).not.toHaveBeenCalled();
    });
  });

  describe('behavior sensing', () => {
    const sensor = () => screen.getByRole('switch', { name: getI18n().settings.behaviorSensor });

    it('stays off and explains why when the system permission is missing', async () => {
      const t = getI18n().settings;
      mocks.testWindowPermission.mockResolvedValue(false);
      const user = userEvent.setup();
      renderSection();

      await user.click(sensor());

      await waitFor(() => expect(mocks.addToast).toHaveBeenCalledOnce());
      expect(mocks.addToast).toHaveBeenCalledWith({
        type: 'error',
        title: t.behaviorSensorPermissionDenied,
        message: t.behaviorSensorPermissionGuide,
      });
      expect(mocks.setBehaviorSensorEnabled).not.toHaveBeenCalled();
    });

    it('turns on once the system permission is there', async () => {
      const user = userEvent.setup();
      renderSection();

      await user.click(sensor());

      await waitFor(() => expect(mocks.setBehaviorSensorEnabled).toHaveBeenCalledWith(true));
      expect(mocks.addToast).not.toHaveBeenCalled();
    });

    it('turns off without asking the system', async () => {
      settingsState.behaviorSensorEnabled = true;
      const user = userEvent.setup();
      renderSection();

      await user.click(sensor());

      expect(mocks.setBehaviorSensorEnabled).toHaveBeenCalledWith(false);
      expect(mocks.testWindowPermission).not.toHaveBeenCalled();
    });

    it('offers to clear the collected data only while it is on', async () => {
      const t = getI18n().settings;
      renderSection();
      expect(screen.queryByRole('button', { name: t.behaviorSensorClearData })).toBeNull();
      cleanup();

      settingsState.behaviorSensorEnabled = true;
      const user = userEvent.setup();
      renderSection();
      await user.click(screen.getByRole('button', { name: t.behaviorSensorClearData }));

      await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith({ type: 'success', title: t.behaviorSensorCleared }));
      expect(mocks.clearBehaviorData).toHaveBeenCalledOnce();
    });
  });

  describe('prevent sleep', () => {
    it('tells the system first, then saves the choice', async () => {
      const user = userEvent.setup();
      renderSection();

      await user.click(screen.getByRole('switch', { name: getI18n().settings.preventSleep }));

      await waitFor(() => expect(mocks.setPreventSleep).toHaveBeenCalledWith(true));
      expect(mocks.invoke).toHaveBeenCalledWith('set_prevent_sleep', { enabled: true });
      expect(mocks.invoke.mock.invocationCallOrder[0]).toBeLessThan(mocks.setPreventSleep.mock.invocationCallOrder[0]);
    });
  });
});
