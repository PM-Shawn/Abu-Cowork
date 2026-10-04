// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_REVALIDATION_MIN_INTERVAL_MS,
  __resetAccountRuntimeForTest,
  initializeAccountProtocol,
} from '@/core/account/runtime';

const accountState = {
  status: 'signed_out' as 'signed_out' | 'awaiting_browser' | 'exchanging' | 'signed_in' | 'expired',
  account: null as null | { kind: 'personal' | 'enterprise' },
  hydrate: vi.fn<() => Promise<void>>(),
};

vi.mock('@/core/account/accountStore', () => ({
  useAccountStore: {
    getState: () => accountState,
  },
}));

describe('account runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T00:00:00Z'));
    accountState.status = 'signed_out';
    accountState.account = null;
    accountState.hydrate.mockReset();
    accountState.hydrate.mockResolvedValue(undefined);
    __resetAccountRuntimeForTest();
  });

  afterEach(() => {
    __resetAccountRuntimeForTest();
    vi.useRealTimers();
  });

  it('initializes once and installs only one set of foreground listeners', async () => {
    const first = initializeAccountProtocol();
    const second = initializeAccountProtocol();
    expect(second).toBe(first);
    await first;
    expect(accountState.hydrate).toHaveBeenCalledOnce();

    accountState.status = 'signed_in';
    accountState.account = { kind: 'personal' };
    vi.setSystemTime(new Date('2026-09-14T00:01:00Z'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    expect(accountState.hydrate).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(ACCOUNT_REVALIDATION_MIN_INTERVAL_MS);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(accountState.hydrate).toHaveBeenCalledTimes(3);

    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    window.dispatchEvent(new Event('focus'));
    expect(accountState.hydrate).toHaveBeenCalledTimes(4);
  });

  it('revalidates immediately when connectivity returns but ignores signed-out events', async () => {
    await initializeAccountProtocol();
    accountState.status = 'signed_in';
    accountState.account = { kind: 'personal' };
    window.dispatchEvent(new Event('online'));
    expect(accountState.hydrate).toHaveBeenCalledTimes(2);

    for (const status of ['signed_out', 'awaiting_browser', 'exchanging', 'expired'] as const) {
      accountState.status = status;
      vi.advanceTimersByTime(ACCOUNT_REVALIDATION_MIN_INTERVAL_MS);
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
    }
    accountState.status = 'signed_in';
    accountState.account = { kind: 'enterprise' };
    window.dispatchEvent(new Event('online'));
    expect(accountState.hydrate).toHaveBeenCalledTimes(2);
  });
});
