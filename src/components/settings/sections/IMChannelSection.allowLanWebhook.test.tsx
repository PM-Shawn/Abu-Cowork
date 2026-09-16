// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
/**
 * The 「允许局域网回调」 row only.
 *
 * It is the only way a user can reopen the callback listener after the upgrade
 * closes it, so what is pinned here is that the switch writes the setting, and
 * that the "you have a plugin that needs this" caption appears exactly when it
 * is true — a plugin that needs the LAN listener is installed AND the switch is
 * off. Showing that caption at any other time would push the user toward
 * opening the endpoint for no reason.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import IMChannelSection from './IMChannelSection';

const mockSetIMAllowLanWebhook = vi.fn();
const settingsState: Record<string, unknown> = {
  imChannel: { allowLanWebhook: false },
  setIMAllowLanWebhook: mockSetIMAllowLanWebhook,
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

const imChannelState = {
  channels: {} as Record<string, unknown>,
  sessions: {} as Record<string, unknown>,
  addChannel: vi.fn(),
  updateChannel: vi.fn(),
  removeChannel: vi.fn(),
};
vi.mock('@/stores/imChannelStore', () => ({
  useIMChannelStore: (selector: (state: typeof imChannelState) => unknown) => selector(imChannelState),
}));

vi.mock('@/core/trigger/triggerEngine', () => ({
  triggerEngine: { getServerPort: () => 18080 },
}));

let heartbeatInstalled = false;
vi.mock('@/core/im/pluginRegistry', () => ({
  hasHeartbeatPlugin: () => heartbeatInstalled,
}));

vi.mock('./WeChatQRPanel', () => ({ default: () => null }));

/** The section renders no other switch while the channel list is empty. */
function theSwitch(): HTMLElement {
  return screen.getByRole('switch');
}

describe('IMChannelSection — LAN callback opt-in', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    heartbeatInstalled = false;
    settingsState.imChannel = { allowLanWebhook: false };
    mockSetIMAllowLanWebhook.mockClear();
  });
  afterEach(cleanup);

  it('shows the row off by default and writes the opt-in when switched on', async () => {
    render(<IMChannelSection />);
    expect(screen.getByText('允许局域网回调')).toBeInTheDocument();
    expect(theSwitch()).toHaveAttribute('aria-checked', 'false');

    await userEvent.click(theSwitch());
    expect(mockSetIMAllowLanWebhook).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('writes false again when switched back off', async () => {
    settingsState.imChannel = { allowLanWebhook: true };
    render(<IMChannelSection />);
    expect(theSwitch()).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(theSwitch());
    expect(mockSetIMAllowLanWebhook).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('mentions the plugin only when one needs the LAN listener and the switch is off', () => {
    heartbeatInstalled = true;
    render(<IMChannelSection />);
    expect(screen.getByText(/需要局域网回调的插件/)).toBeInTheDocument();
  });

  it('says nothing about a plugin when none is installed', () => {
    render(<IMChannelSection />);
    expect(screen.queryByText(/需要局域网回调的插件/)).not.toBeInTheDocument();
  });

  it('says nothing about a plugin once the switch is already on', () => {
    heartbeatInstalled = true;
    settingsState.imChannel = { allowLanWebhook: true };
    render(<IMChannelSection />);
    expect(screen.queryByText(/需要局域网回调的插件/)).not.toBeInTheDocument();
  });

  it('holds back the restart note until the value is actually changed', async () => {
    render(<IMChannelSection />);
    expect(screen.queryByText(/完全退出并重新打开阿布/)).not.toBeInTheDocument();

    await userEvent.click(theSwitch());
    expect(screen.getByText(/完全退出并重新打开阿布/)).toBeInTheDocument();
  });
});
