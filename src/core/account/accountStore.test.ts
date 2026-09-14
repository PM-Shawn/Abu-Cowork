import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  AccountClientError,
  exchangeCode,
  fetchAccountProfile,
  logout,
  userIdFromAccessToken,
} from '@/core/account/client';
import { clearAccountCredentials, loadAccountCredentials, saveAccountCredentials } from '@/core/account/credentials';
import { createPkcePair } from '@/core/account/pkce';
import { useSettingsStore } from '@/stores/settingsStore';
import { registerAccountSessionDeactivator } from '@/core/account/sessionCoordinator';
import {
  ACCOUNT_BROWSER_TIMEOUT_MS,
  __resetAccountStoreForTest,
  useAccountStore,
} from '@/core/account/accountStore';

vi.mock('@/core/account/pkce', () => ({ createPkcePair: vi.fn() }));
vi.mock('@/core/account/client', async () => {
  const actual = await vi.importActual<typeof import('@/core/account/client')>('@/core/account/client');
  return {
    ...actual,
    exchangeCode: vi.fn(),
    fetchAccountProfile: vi.fn(),
    logout: vi.fn(),
    userIdFromAccessToken: vi.fn(),
  };
});
vi.mock('@/core/account/credentials', () => ({
  clearAccountCredentials: vi.fn(),
  loadAccountCredentials: vi.fn(),
  saveAccountCredentials: vi.fn(),
}));

const PKCE = { verifier: 'verifier', challenge: 'challenge', state: 'expected-state' };
const PAIR = {
  access_token: 'access-secret',
  token_type: 'Bearer',
  expires_in: 900,
  refresh_token: 'refresh-secret',
  refresh_idle_expires_at: '2026-09-28T00:00:00Z',
  refresh_absolute_expires_at: '2026-12-13T00:00:00Z',
  family_id: 'family-1',
} as const;

describe('account store', () => {
  beforeEach(() => {
    __resetAccountStoreForTest();
    vi.mocked(openUrl).mockReset();
    vi.mocked(openUrl).mockResolvedValue(undefined);
    vi.mocked(onOpenUrl).mockReset();
    vi.mocked(onOpenUrl).mockResolvedValue(() => {});
    vi.mocked(createPkcePair).mockReset();
    vi.mocked(createPkcePair).mockResolvedValue(PKCE);
    vi.mocked(exchangeCode).mockReset();
    vi.mocked(exchangeCode).mockResolvedValue(PAIR);
    vi.mocked(fetchAccountProfile).mockReset();
    vi.mocked(fetchAccountProfile).mockResolvedValue({
      id: 'user-1', name: 'Ada', email: 'ada@example.com',
    });
    vi.mocked(logout).mockReset();
    vi.mocked(logout).mockResolvedValue(undefined);
    vi.mocked(userIdFromAccessToken).mockReset();
    vi.mocked(userIdFromAccessToken).mockReturnValue('user-1');
    vi.mocked(loadAccountCredentials).mockReset();
    vi.mocked(loadAccountCredentials).mockResolvedValue(null);
    vi.mocked(saveAccountCredentials).mockReset();
    vi.mocked(saveAccountCredentials).mockResolvedValue(undefined);
    vi.mocked(clearAccountCredentials).mockReset();
    vi.mocked(clearAccountCredentials).mockResolvedValue(undefined);
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command) => (
      command === 'plugin:deep-link|is_registered' ? true : undefined
    ));
  });

  async function start(): Promise<void> {
    await useAccountStore.getState().startPersonalLogin('https://accounts.example.com');
    expect(useAccountStore.getState().status).toBe('awaiting_browser');
  }

  it('opens the browser and waits without persisting the PKCE verifier', async () => {
    await start();
    expect(onOpenUrl).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining('/client-login?'));
    expect(JSON.stringify(useAccountStore.getState())).not.toContain('verifier');
  });

  it.each([
    [false, 'protocol_not_registered'],
    [undefined, 'protocol_status_unknown'],
  ] as const)('does not open a login the current shell cannot receive (%s)', async (reply, code) => {
    vi.mocked(invoke).mockResolvedValue(reply);
    await expect(useAccountStore.getState().startPersonalLogin(
      'https://accounts.example.com',
    )).resolves.toBeNull();
    expect(createPkcePair).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_out', profileStatus: 'idle', error: code,
    });
  });

  it('keeps a registration query exception distinct from not registered', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('registry unavailable'));
    await useAccountStore.getState().startPersonalLogin('https://accounts.example.com');
    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_out', profileStatus: 'idle', error: 'protocol_status_unknown',
    });
  });

  it('ignores a valid auth callback owned by another pending account flow', async () => {
    await start();
    await expect(useAccountStore.getState().handleDeepLink(
      'abu://auth?code=one-time-code&state=attacker-state',
    )).resolves.toBe(false);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(useAccountStore.getState()).toMatchObject({ status: 'awaiting_browser', error: null });
  });

  it('discards a callback with missing state', async () => {
    await start();
    await expect(useAccountStore.getState().handleDeepLink('abu://auth?code=one-time-code')).resolves.toBe(true);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(useAccountStore.getState()).toMatchObject({ status: 'awaiting_browser', error: 'state_mismatch' });
  });

  it('expires an unanswered browser login after ten minutes', async () => {
    vi.useFakeTimers();
    try {
      await start();
      await vi.advanceTimersByTimeAsync(ACCOUNT_BROWSER_TIMEOUT_MS);
      expect(useAccountStore.getState()).toMatchObject({
        status: 'expired', account: null, error: 'timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a cancelled login timeout expire its retry', async () => {
    vi.useFakeTimers();
    try {
      await start();
      await vi.advanceTimersByTimeAsync(ACCOUNT_BROWSER_TIMEOUT_MS - 60_000);
      useAccountStore.getState().cancel();
      await start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(useAccountStore.getState()).toMatchObject({
        status: 'awaiting_browser', account: null, error: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('becomes signed in only after the exchanged credentials are confirmed', async () => {
    await start();
    await useAccountStore.getState().handleDeepLink(
      'abu://auth?code=one-time-code&state=expected-state',
    );
    expect(exchangeCode).toHaveBeenCalledWith(
      'https://accounts.example.com', 'one-time-code', 'verifier', expect.any(AbortSignal),
    );
    expect(saveAccountCredentials).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'access-secret', refreshToken: 'refresh-secret', userId: 'user-1', kind: 'personal',
    }));
    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_in',
      account: {
        userId: 'user-1', kind: 'personal', name: 'Ada', email: 'ada@example.com',
      },
      profileStatus: 'ready',
      error: null,
    });
  });

  it('clears an enterprise session before saving a successful personal login', async () => {
    const order: string[] = [];
    const unregister = registerAccountSessionDeactivator('enterprise', async () => {
      order.push('clear-enterprise');
    });
    vi.mocked(saveAccountCredentials).mockImplementation(async () => {
      order.push('save-personal');
    });

    try {
      await start();
      await useAccountStore.getState().handleDeepLink(
        'abu://auth?code=one-time-code&state=expected-state',
      );
      expect(order).toEqual(['clear-enterprise', 'save-personal']);
    } finally {
      unregister();
    }
  });

  it('restores the enterprise session when personal credential persistence fails', async () => {
    const restoreEnterprise = vi.fn().mockResolvedValue(undefined);
    const unregister = registerAccountSessionDeactivator('enterprise', async () => ({
      rollback: restoreEnterprise,
    }));
    vi.mocked(saveAccountCredentials).mockRejectedValue(new Error('safeStorage unavailable'));

    try {
      await start();
      await useAccountStore.getState().handleDeepLink(
        'abu://auth?code=one-time-code&state=expected-state',
      );
      expect(restoreEnterprise).toHaveBeenCalledOnce();
      expect(useAccountStore.getState()).toMatchObject({
        status: 'signed_out',
        account: null,
        error: 'credential_storage_unavailable',
      });
    } finally {
      unregister();
    }
  });

  it('restores the enterprise session when personal login is cancelled during cleanup', async () => {
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { markCleanupStarted = resolve; });
    let releaseCleanup!: () => void;
    const cleanupBlocked = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const restoreEnterprise = vi.fn().mockResolvedValue(undefined);
    const unregister = registerAccountSessionDeactivator('enterprise', async () => {
      markCleanupStarted();
      await cleanupBlocked;
      return { rollback: restoreEnterprise };
    });

    try {
      await start();
      const handling = useAccountStore.getState().handleDeepLink(
        'abu://auth?code=one-time-code&state=expected-state',
      );
      await cleanupStarted;
      useAccountStore.getState().cancel();
      releaseCleanup();
      await handling;

      expect(saveAccountCredentials).not.toHaveBeenCalled();
      expect(restoreEnterprise).toHaveBeenCalledOnce();
      expect(useAccountStore.getState()).toMatchObject({ status: 'signed_out', error: 'cancelled' });
    } finally {
      unregister();
    }
  });

  it('hydrates a stored login and loads its authenticated profile', async () => {
    vi.mocked(loadAccountCredentials).mockResolvedValue({
      serverUrl: 'https://accounts.example.com',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      userId: 'user-1',
      kind: 'personal',
    });

    await useAccountStore.getState().hydrate();

    expect(fetchAccountProfile).toHaveBeenCalledWith(
      'https://accounts.example.com', 'access-secret', expect.any(AbortSignal),
    );
    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_in',
      account: { userId: 'user-1', name: 'Ada', email: 'ada@example.com' },
      profileStatus: 'ready',
    });
  });

  it('does not trust profile fields when the authenticated id differs', async () => {
    vi.mocked(fetchAccountProfile).mockResolvedValue({
      id: 'another-user', name: 'Mallory', email: 'mallory@example.com',
    });
    await start();
    await useAccountStore.getState().handleDeepLink(
      'abu://auth?code=one-time-code&state=expected-state',
    );

    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_in',
      account: { userId: 'user-1', name: null, email: null },
      profileStatus: 'error',
    });
  });

  it('keeps the confirmed session without inventing profile fields when profile loading fails', async () => {
    vi.mocked(fetchAccountProfile).mockRejectedValue(new Error('offline'));
    await start();
    await useAccountStore.getState().handleDeepLink(
      'abu://auth?code=one-time-code&state=expected-state',
    );

    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_in',
      account: { userId: 'user-1', name: null, email: null },
      profileStatus: 'error',
      error: null,
    });
  });

  it('marks a session expired when profile authentication is rejected', async () => {
    vi.mocked(fetchAccountProfile).mockRejectedValue(new AccountClientError('unauthorized', 401));
    vi.mocked(loadAccountCredentials).mockResolvedValue({
      serverUrl: 'https://accounts.example.com',
      accessToken: 'expired-access-secret',
      refreshToken: 'refresh-secret',
      userId: 'user-1',
      kind: 'personal',
    });

    await useAccountStore.getState().hydrate();

    expect(useAccountStore.getState()).toMatchObject({
      status: 'expired',
      account: { userId: 'user-1', name: null, email: null },
      profileStatus: 'error',
      error: 'session_expired',
    });
  });

  it('does not let a late old profile overwrite a signed-out retry', async () => {
    let resolveOldProfile!: (value: { id: string; name: string; email: string | null }) => void;
    vi.mocked(fetchAccountProfile)
      .mockReturnValueOnce(new Promise((resolve) => { resolveOldProfile = resolve; }))
      .mockResolvedValueOnce({ id: 'user-1', name: 'New User', email: null });

    await start();
    const oldHandling = useAccountStore.getState().handleDeepLink(
      'abu://auth?code=old-code&state=expected-state',
    );
    await vi.waitFor(() => expect(useAccountStore.getState().profileStatus).toBe('loading'));

    await useAccountStore.getState().signOut();
    await start();
    await useAccountStore.getState().handleDeepLink(
      'abu://auth?code=new-code&state=expected-state',
    );
    resolveOldProfile({ id: 'user-1', name: 'Old User', email: 'old@example.com' });
    await oldHandling;

    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_in',
      account: { userId: 'user-1', name: 'New User', email: null },
      profileStatus: 'ready',
    });
  });

  it('fails closed when safeStorage cannot confirm the credential', async () => {
    vi.mocked(saveAccountCredentials).mockRejectedValue(new Error('safeStorage unavailable'));
    await start();
    await useAccountStore.getState().handleDeepLink(
      'abu://auth?code=one-time-code&state=expected-state',
    );
    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_out', account: null, error: 'credential_storage_unavailable',
    });
  });

  it('does not restore a session when safeStorage cannot be read', async () => {
    vi.mocked(loadAccountCredentials).mockRejectedValue(new Error('safeStorage unavailable'));
    await useAccountStore.getState().hydrate();
    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_out', account: null, error: 'credential_storage_unavailable',
    });
  });

  it('does not let a cancelled exchange resurrect the account', async () => {
    let resolveExchange!: (value: typeof PAIR) => void;
    vi.mocked(exchangeCode).mockReturnValue(new Promise((resolve) => { resolveExchange = resolve; }));
    await start();
    const handling = useAccountStore.getState().handleDeepLink(
      'abu://auth?code=one-time-code&state=expected-state',
    );
    expect(useAccountStore.getState().status).toBe('exchanging');
    useAccountStore.getState().cancel();
    resolveExchange(PAIR);
    await handling;
    expect(saveAccountCredentials).not.toHaveBeenCalled();
    expect(useAccountStore.getState()).toMatchObject({ status: 'signed_out', account: null, error: 'cancelled' });
  });

  it('lets a pending exchange finish when the user clears saved API keys', async () => {
    let resolveExchange!: (value: typeof PAIR) => void;
    vi.mocked(exchangeCode).mockReturnValue(new Promise((resolve) => { resolveExchange = resolve; }));
    await start();
    const handling = useAccountStore.getState().handleDeepLink(
      'abu://auth?code=one-time-code&state=expected-state',
    );

    await useSettingsStore.getState().clearAllStoredKeys();
    resolveExchange(PAIR);
    await handling;

    const secretCalls = vi.mocked(invoke).mock.calls.filter(([cmd]) => String(cmd).startsWith('secret_'));
    expect(secretCalls.some(([cmd]) => cmd === 'secret_clear_all')).toBe(false);
    expect(secretCalls.some(([, args]) => (
      args as { key?: string } | undefined
    )?.key === 'account:credentials:v1')).toBe(false);
    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_in', account: { userId: 'user-1' }, error: null,
    });
  });

  it('ignores the first result after cancel and keeps a retried login', async () => {
    let resolveFirst!: (value: typeof PAIR) => void;
    const first = new Promise<typeof PAIR>((resolve) => { resolveFirst = resolve; });
    vi.mocked(exchangeCode)
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(PAIR);
    await start();
    const oldHandling = useAccountStore.getState().handleDeepLink(
      'abu://auth?code=old-code&state=expected-state',
    );
    useAccountStore.getState().cancel();
    await start();
    await useAccountStore.getState().handleDeepLink(
      'abu://auth?code=new-code&state=expected-state',
    );
    resolveFirst(PAIR);
    await oldHandling;
    expect(saveAccountCredentials).toHaveBeenCalledTimes(1);
    expect(useAccountStore.getState()).toMatchObject({ status: 'signed_in', account: { userId: 'user-1' } });
  });

  it('does not let a failed cancellation cleanup override a completed retry', async () => {
    let resolveFirstSave!: () => void;
    const firstSave = new Promise<void>((resolve) => { resolveFirstSave = resolve; });
    vi.mocked(saveAccountCredentials)
      .mockReturnValueOnce(firstSave)
      .mockResolvedValueOnce(undefined);
    vi.mocked(clearAccountCredentials).mockRejectedValueOnce(new Error('safeStorage unavailable'));

    await start();
    const oldHandling = useAccountStore.getState().handleDeepLink(
      'abu://auth?code=old-code&state=expected-state',
    );
    await vi.waitFor(() => expect(saveAccountCredentials).toHaveBeenCalledTimes(1));
    useAccountStore.getState().cancel();
    await start();
    const retryHandling = useAccountStore.getState().handleDeepLink(
      'abu://auth?code=new-code&state=expected-state',
    );
    resolveFirstSave();
    await Promise.all([oldHandling, retryHandling]);

    expect(saveAccountCredentials).toHaveBeenCalledTimes(2);
    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_in', account: { userId: 'user-1' }, error: null,
    });
  });

  it('clears local credentials before waiting for remote logout', async () => {
    let resolveLogout!: () => void;
    vi.mocked(loadAccountCredentials).mockResolvedValue({
      serverUrl: 'https://accounts.example.com',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      userId: 'user-1',
      kind: 'personal',
    });
    vi.mocked(logout).mockReturnValue(new Promise<void>((resolve) => { resolveLogout = resolve; }));
    useAccountStore.setState({
      status: 'signed_in',
      account: {
        serverUrl: 'https://accounts.example.com',
        userId: 'user-1',
        kind: 'personal',
        name: 'Ada',
        email: 'ada@example.com',
      },
      profileStatus: 'ready',
      error: null,
    });

    const signingOut = useAccountStore.getState().signOut();
    expect(useAccountStore.getState()).toMatchObject({ status: 'signed_out', account: null });
    await vi.waitFor(() => expect(logout).toHaveBeenCalledOnce());
    expect(clearAccountCredentials).toHaveBeenCalledBefore(vi.mocked(logout));
    resolveLogout();
    await signingOut;
  });

  it('orders an in-flight old save, sign-out clear, and new login save', async () => {
    const order: string[] = [];
    let resolveOldSave!: () => void;
    const oldSave = new Promise<void>((resolve) => { resolveOldSave = resolve; });
    vi.mocked(saveAccountCredentials)
      .mockImplementationOnce(async () => {
        order.push('old-save-start');
        await oldSave;
        order.push('old-save-end');
      })
      .mockImplementationOnce(async () => { order.push('new-save'); });
    vi.mocked(loadAccountCredentials).mockImplementation(async () => {
      order.push('load-old');
      return {
        serverUrl: 'https://accounts.example.com',
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        userId: 'user-1',
        kind: 'personal',
      };
    });
    vi.mocked(clearAccountCredentials).mockImplementation(async () => { order.push('clear-old'); });

    await start();
    const oldHandling = useAccountStore.getState().handleDeepLink(
      'abu://auth?code=old-code&state=expected-state',
    );
    await vi.waitFor(() => expect(order).toContain('old-save-start'));
    const signingOut = useAccountStore.getState().signOut();
    await start();
    const retryHandling = useAccountStore.getState().handleDeepLink(
      'abu://auth?code=new-code&state=expected-state',
    );
    resolveOldSave();
    await Promise.all([oldHandling, signingOut, retryHandling]);

    expect(order).toEqual([
      'old-save-start',
      'old-save-end',
      'load-old',
      'clear-old',
      'clear-old',
      'new-save',
    ]);
    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_in', account: { userId: 'user-1' }, error: null,
    });
  });
});
