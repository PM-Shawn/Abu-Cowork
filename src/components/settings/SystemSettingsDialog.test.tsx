// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import SystemSettingsDialog from './SystemSettingsDialog';

const platformMock = vi.hoisted(() => ({ mac: false }));
vi.mock('@/utils/platform', () => ({
  isMacOS: () => platformMock.mac,
  isWindows: () => !platformMock.mac,
}));

vi.mock('@/components/settings/SystemSettingsModal', async () => {
  const { Button } = await import('@/components/ds/button');
  const { Select } = await import('@/components/ds/select');
  return {
    default: () => (
      <div>
        <nav>
          <Button>Another page</Button>
          <Button aria-current="page">Page in view</Button>
        </nav>
        <Button>First control</Button>
        <Select
          label="Sample choice"
          value="one"
          onValueChange={() => undefined}
          options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }]}
        />
      </div>
    ),
  };
});

// A command approval the tests can raise; the rest of the bridge is the real one.
const commandApproval = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { pending: null as { conversationId: string } | null };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get: () => state.pending,
    set: (next: { conversationId: string } | null) => {
      state.pending = next;
      for (const listener of listeners) listener();
    },
  };
});
vi.mock('@/core/agent/permissionBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/agent/permissionBridge')>()),
  subscribeToCommandConfirmation: commandApproval.subscribe,
  getPendingCommandConfirmation: commandApproval.get,
}));

function renderDialog() {
  return render(<SystemSettingsDialog />, { wrapper: DesignSystemProvider });
}

// The window opened from a button on the page, the way the account menu opens it.
function renderWithOpener() {
  return render(
    <>
      <Button onClick={() => useSettingsStore.getState().openSystemSettings()}>Open settings</Button>
      <SystemSettingsDialog />
    </>,
    { wrapper: DesignSystemProvider },
  );
}

// Radix hands focus back from a timer once the dialog has gone.
async function flushClose() {
  await act(() => vi.runOnlyPendingTimersAsync());
}

const settingsWindow = () => document.querySelector('[data-abu-settings-dialog]');
const isOpen = () => useSettingsStore.getState().systemSettingsOpen;

describe('SystemSettingsDialog', () => {
  beforeAll(() => {
    // happy-dom lacks the pointer-capture and scroll calls Radix Select makes while opening.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => undefined;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
  });

  beforeEach(() => {
    initLanguage('zh-CN');
    platformMock.mac = false;
    usePreviewStore.setState({ appModalOpen: false });
    useSettingsStore.setState({ systemSettingsOpen: true });
  });

  afterEach(() => {
    cleanup();
    usePreviewStore.setState({ appModalOpen: false });
    useSettingsStore.setState({ systemSettingsOpen: false });
  });

  // macOS paints its window buttons over the top 44px of the window
  // (`trafficLightPosition` in `electron/windowChrome.cjs`), so the settings window starts
  // 48px down there and 24px down elsewhere.
  it('starts below the window buttons on macOS and keeps the settings-window box', () => {
    platformMock.mac = true;
    renderDialog();
    expect(settingsWindow()).toHaveClass('top-12');
    expect(settingsWindow()).toHaveClass('m-auto');
    expect(settingsWindow()).toHaveClass('max-h-[840px]');
  });

  it('starts nearer the top on other platforms', () => {
    renderDialog();
    expect(settingsWindow()).toHaveClass('top-6');
    expect(settingsWindow()).not.toHaveClass('top-12');
  });

  it('is a dialog named after the settings title, and it and its scrim stay out of the window drag lanes', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: getI18n().settings.title });
    expect(dialog).toBe(settingsWindow());
    expect(dialog).toHaveAttribute('data-electron-no-drag');
    const scrim = document.querySelector('.bg-scrim');
    expect(scrim).not.toBeNull();
    expect(scrim).toHaveAttribute('data-electron-no-drag');
  });

  it('closes from the close button', async () => {
    const user = userEvent.setup();
    renderDialog();
    const close = document.querySelector<HTMLElement>('[data-abu-settings-close]');
    expect(close).toHaveAccessibleName(getI18n().common.close);
    await user.click(close!);
    expect(isOpen()).toBe(false);
    expect(settingsWindow()).toBeNull();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.keyboard('{Escape}');
    expect(isOpen()).toBe(false);
  });

  it('closes one layer per Escape: an open select first, then the settings window', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('combobox', { name: 'Sample choice' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(isOpen()).toBe(true);
    expect(settingsWindow()).not.toBeNull();

    await user.keyboard('{Escape}');
    expect(isOpen()).toBe(false);
  });

  it('closes itself when the close-window question appears', () => {
    renderDialog();
    expect(settingsWindow()).not.toBeNull();
    act(() => usePreviewStore.setState({ appModalOpen: true }));
    expect(isOpen()).toBe(false);
    expect(settingsWindow()).toBeNull();
  });

  it('does not open over the close-window question', () => {
    useSettingsStore.setState({ systemSettingsOpen: false });
    usePreviewStore.setState({ appModalOpen: true });
    renderDialog();
    act(() => useSettingsStore.getState().openSystemSettings());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(isOpen()).toBe(false);
  });

  describe('approvals of the conversation in view', () => {
    beforeEach(() => {
      useChatStore.setState({ activeConversationId: 'conversation-in-view' });
      useSettingsStore.setState({ viewMode: 'chat' });
    });

    afterEach(() => {
      commandApproval.set(null);
      useChatStore.setState({ activeConversationId: null });
      useSettingsStore.setState({ viewMode: 'chat' });
    });

    it('closes itself when a command approval appears in the chat view', () => {
      renderDialog();
      expect(settingsWindow()).not.toBeNull();
      act(() => commandApproval.set({ conversationId: 'conversation-in-view' }));
      expect(isOpen()).toBe(false);
      expect(settingsWindow()).toBeNull();
    });

    // The approval is drawn by the chat view; in another view nothing is on screen to yield to.
    it('opens in another view while that approval is waiting', () => {
      useSettingsStore.setState({ systemSettingsOpen: false, viewMode: 'automation' });
      commandApproval.set({ conversationId: 'conversation-in-view' });
      renderDialog();
      act(() => useSettingsStore.getState().openSystemSettings());
      expect(isOpen()).toBe(true);
      expect(screen.getByRole('dialog', { name: getI18n().settings.title })).toBeInTheDocument();
    });
  });

  it('opens with focus on the navigation row of the page in view', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ systemSettingsOpen: false });
    renderWithOpener();
    await user.click(screen.getByRole('button', { name: 'Open settings' }));

    expect(screen.getByRole('button', { name: 'Page in view' })).toHaveFocus();
  });

  describe('focus when the window closes', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      useSettingsStore.setState({ systemSettingsOpen: false });
    });

    afterEach(() => { vi.useRealTimers(); });

    it('gives focus back to its opener when the user closes it', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderWithOpener();
      const opener = screen.getByRole('button', { name: 'Open settings' });
      await user.click(opener);
      expect(settingsWindow()).not.toBeNull();

      await user.keyboard('{Escape}');
      await flushClose();

      expect(settingsWindow()).toBeNull();
      expect(opener).toHaveFocus();
    });

    // A legacy prompt takes no focus: with focus on the opener underneath it, Enter would open
    // the opener's menu over the prompt and the Escape that closes the menu would answer the prompt.
    it('leaves focus off its opener when it yields to a blocking prompt', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderWithOpener();
      const opener = screen.getByRole('button', { name: 'Open settings' });
      await user.click(opener);
      expect(settingsWindow()).not.toBeNull();

      act(() => usePreviewStore.setState({ appModalOpen: true }));
      await flushClose();

      expect(settingsWindow()).toBeNull();
      expect(opener).not.toHaveFocus();
    });
  });

  it('draws no blurred scrim', () => {
    renderDialog();
    expect(settingsWindow()).not.toBeNull();
    expect(document.querySelector('[class*="backdrop-blur"]')).toBeNull();
  });
});
