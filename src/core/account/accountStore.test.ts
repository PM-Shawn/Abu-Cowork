import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  AccountClientError,
  exchangeCode,
  fetchAccountProfile,
  logout,
  refresh,
  userIdFromAccessToken,
} from '@/core/account/client';
import { clearAccountCredentials, loadAccountCredentials, saveAccountCredentials } from '@/core/account/credentials';
import { createPkcePair } from '@/core/account/pkce';
import { useSettingsStore } from '@/stores/settingsStore';
import { activateExclusiveAccountSession, registerAccountSessionDeactivator } from '@/core/account/sessionCoordinator';
import type { AccountCredentials } from '@/core/account/credentials';
import {
  ACCOUNT_BROWSER_TIMEOUT_MS,
  ACCOUNT_PROFILE_TIMEOUT_MS,
  ACCOUNT_REFRESH_TIMEOUT_MS,
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
    refresh: vi.fn(),
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
const ROTATED_PAIR = {
  ...PAIR,
  access_token: 'rotated-access-secret',
  refresh_token: 'rotated-refresh-secret',
} as const;
const STORED_CREDENTIALS = {
  serverUrl: 'https://accounts.example.com',
  accessToken: 'expired-access-secret',
  refreshToken: 'refresh-secret',
  userId: 'user-1',
  kind: 'personal',
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
    vi.mocked(refresh).mockReset();
    vi.mocked(refresh).mockResolvedValue(ROTATED_PAIR);
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

  function trackStoredCredentials() {
    let stored: AccountCredentials | null = STORED_CREDENTIALS;
    vi.mocked(loadAccountCredentials).mockImplementation(async () => stored);
    vi.mocked(saveAccountCredentials).mockImplementation(async (credentials) => { stored = credentials; });
    vi.mocked(clearAccountCredentials).mockImplementation(async () => { stored = null; });
    return () => stored;
  }

  it.each([true, false])('企业切换等待刷新完成并使用最终凭据（保存成功：%s）', async (succeeds) => {
    const stored = trackStoredCredentials();
    let resolveRefresh!: (value: typeof ROTATED_PAIR) => void;
    vi.mocked(refresh).mockReturnValue(new Promise((resolve) => { resolveRefresh = resolve; }));
    vi.mocked(fetchAccountProfile).mockRejectedValueOnce(new AccountClientError('unauthenticated', 401));
    const hydrating = useAccountStore.getState().hydrate();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const activate = vi.fn(async () => {
      if (!succeeds) throw new Error('enterprise_save_failed');
    });
    const switching = activateExclusiveAccountSession('enterprise', activate);
    const completed = succeeds
      ? expect(switching).resolves.toBe(true)
      : expect(switching).rejects.toThrow('enterprise_save_failed');
    await Promise.resolve();
    expect(clearAccountCredentials).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    resolveRefresh(ROTATED_PAIR);
    await Promise.all([hydrating, completed]);
    if (succeeds) {
      expect(stored()).toBeNull();
      expect(useAccountStore.getState().status).toBe('signed_out');
      expect(logout).toHaveBeenCalledExactlyOnceWith(
        STORED_CREDENTIALS.serverUrl, ROTATED_PAIR.access_token,
        ROTATED_PAIR.refresh_token, expect.any(AbortSignal),
      );
    } else {
      expect(stored()).toEqual({
        ...STORED_CREDENTIALS,
        accessToken: ROTATED_PAIR.access_token,
        refreshToken: ROTATED_PAIR.refresh_token,
      });
      expect(fetchAccountProfile).toHaveBeenLastCalledWith(
        STORED_CREDENTIALS.serverUrl, ROTATED_PAIR.access_token, expect.any(AbortSignal),
      );
      expect(useAccountStore.getState()).toMatchObject({ status: 'signed_in', profileStatus: 'ready' });
      expect(logout).not.toHaveBeenCalled();
    }
  });

  it('等待刷新期间主动退出会终止企业切换', async () => {
    const stored = trackStoredCredentials();
    let resolveRefresh!: (value: typeof ROTATED_PAIR) => void;
    vi.mocked(refresh).mockReturnValue(new Promise((resolve) => { resolveRefresh = resolve; }));
    vi.mocked(fetchAccountProfile).mockRejectedValueOnce(new AccountClientError('unauthenticated', 401));
    const hydrating = useAccountStore.getState().hydrate();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const activate = vi.fn(async () => {});
    const switching = expect(activateExclusiveAccountSession('enterprise', activate))
      .rejects.toThrow('account_session_transition_cancelled');
    await Promise.resolve();
    await useAccountStore.getState().signOut();
    expect(stored()).toBeNull();
    resolveRefresh(ROTATED_PAIR);
    await Promise.all([hydrating, switching]);
    expect(activate).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    expect(useAccountStore.getState().status).toBe('signed_out');
  });

  it.each(['signOut', 'hydrate'] as const)('企业保存失败后不会覆盖较新的 %s 操作', async (action) => {
    const stored = trackStoredCredentials();
    await useAccountStore.getState().hydrate();
    let rejectActivation!: (reason: Error) => void;
    const activate = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectActivation = reject; }));
    const switching = expect(activateExclusiveAccountSession('enterprise', activate))
      .rejects.toThrow('enterprise_save_failed');
    await vi.waitFor(() => expect(activate).toHaveBeenCalledOnce());
    await useAccountStore.getState()[action]();
    rejectActivation(new Error('enterprise_save_failed'));
    await switching;
    expect(saveAccountCredentials).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    expect(useAccountStore.getState().status).toBe('signed_out');
  });

  it('恢复保存期间主动退出最终清除凭据和登录状态', async () => {
    const stored = trackStoredCredentials();
    const save = vi.mocked(saveAccountCredentials).getMockImplementation()!;
    await useAccountStore.getState().hydrate();
    let finishSaving!: () => void;
    vi.mocked(saveAccountCredentials).mockImplementation(async (credentials) => {
      await new Promise<void>((resolve) => { finishSaving = resolve; });
      await save(credentials);
    });
    const switching = expect(activateExclusiveAccountSession('enterprise', async () => {
      throw new Error('enterprise_save_failed');
    })).rejects.toThrow('enterprise_save_failed');
    await vi.waitFor(() => expect(saveAccountCredentials).toHaveBeenCalledOnce());
    const signingOut = useAccountStore.getState().signOut();
    finishSaving();
    await Promise.all([switching, signingOut]);
    expect(clearAccountCredentials).toHaveBeenCalledTimes(2);
    expect(clearAccountCredentials).toHaveBeenLastCalledWith();
    expect(stored()).toBeNull();
    expect(fetchAccountProfile).toHaveBeenCalledOnce();
    expect(useAccountStore.getState().status).toBe('signed_out');
  });

  it('企业切换清理期间新会话读取会终止旧激活', async () => {
    const stored = trackStoredCredentials();
    await useAccountStore.getState().hydrate();
    let finishRead!: (value: AccountCredentials | null) => void;
    vi.mocked(loadAccountCredentials).mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const activate = vi.fn(async () => {});
    const switching = expect(activateExclusiveAccountSession('enterprise', activate))
      .rejects.toThrow('account_session_transition_cancelled');
    await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'));
    const hydrating = useAccountStore.getState().hydrate();
    finishRead(stored());
    await Promise.all([switching, hydrating]);
    expect(activate).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    expect(useAccountStore.getState().status).toBe('signed_out');
  });

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

  it('rotates a rejected access token, confirms it, then retries the profile once', async () => {
    vi.mocked(loadAccountCredentials).mockResolvedValue(STORED_CREDENTIALS);
    vi.mocked(fetchAccountProfile)
      .mockRejectedValueOnce(new AccountClientError('unauthenticated', 401))
      .mockResolvedValueOnce({ id: 'user-1', name: 'Ada', email: 'ada@example.com' });

    await useAccountStore.getState().hydrate();

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(
      STORED_CREDENTIALS.serverUrl,
      STORED_CREDENTIALS.refreshToken,
      expect.any(AbortSignal),
    );
    expect(saveAccountCredentials).toHaveBeenCalledWith({
      ...STORED_CREDENTIALS,
      accessToken: ROTATED_PAIR.access_token,
      refreshToken: ROTATED_PAIR.refresh_token,
    });
    expect(fetchAccountProfile).toHaveBeenNthCalledWith(
      2,
      STORED_CREDENTIALS.serverUrl,
      ROTATED_PAIR.access_token,
      expect.any(AbortSignal),
    );
    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_in',
      account: { userId: 'user-1', name: 'Ada', email: 'ada@example.com' },
      profileStatus: 'ready',
      error: null,
    });
  });

  it('does not use a rotated access token before safeStorage confirms it', async () => {
    let confirmSave!: () => void;
    vi.mocked(loadAccountCredentials).mockResolvedValue(STORED_CREDENTIALS);
    vi.mocked(fetchAccountProfile)
      .mockRejectedValueOnce(new AccountClientError('unauthenticated', 401))
      .mockResolvedValueOnce({ id: 'user-1', name: 'Ada', email: null });
    vi.mocked(saveAccountCredentials).mockReturnValue(new Promise((resolve) => {
      confirmSave = resolve;
    }));

    const hydrating = useAccountStore.getState().hydrate();
    await vi.waitFor(() => expect(saveAccountCredentials).toHaveBeenCalledOnce());
    expect(fetchAccountProfile).toHaveBeenCalledOnce();

    confirmSave();
    await hydrating;
    expect(fetchAccountProfile).toHaveBeenCalledTimes(2);
    expect(useAccountStore.getState().profileStatus).toBe('ready');
  });

  it('shares one hydrate and one rotation while startup callers overlap', async () => {
    vi.mocked(loadAccountCredentials).mockResolvedValue(STORED_CREDENTIALS);
    vi.mocked(fetchAccountProfile)
      .mockRejectedValueOnce(new AccountClientError('unauthenticated', 401))
      .mockResolvedValueOnce({ id: 'user-1', name: 'Ada', email: null });

    const first = useAccountStore.getState().hydrate();
    const second = useAccountStore.getState().hydrate();
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(loadAccountCredentials).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledOnce();
    expect(saveAccountCredentials).toHaveBeenCalledOnce();
  });

  it.each([
    ['transport failure', new AccountClientError('network_error')],
    ['server failure', new AccountClientError('server_error', 503)],
    ['malformed success response', new AccountClientError('invalid_response', 200)],
  ])('does not replay a refresh after an ambiguous %s', async (_label, failure) => {
    vi.mocked(loadAccountCredentials).mockResolvedValue(STORED_CREDENTIALS);
    vi.mocked(fetchAccountProfile).mockRejectedValue(
      new AccountClientError('unauthenticated', 401),
    );
    vi.mocked(refresh).mockRejectedValue(failure);

    await useAccountStore.getState().hydrate();
    await useAccountStore.getState().hydrate();

    expect(refresh).toHaveBeenCalledOnce();
    expect(saveAccountCredentials).not.toHaveBeenCalled();
    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_in',
      account: { userId: 'user-1' },
      profileStatus: 'error',
      error: null,
    });
  });

  it('releases a stalled profile load so the next hydration can retry', async () => {
    vi.useFakeTimers();
    try {
      let markProfileStarted!: () => void;
      const profileStarted = new Promise<void>((resolve) => {
        markProfileStarted = resolve;
      });
      vi.mocked(loadAccountCredentials).mockResolvedValue({
        ...STORED_CREDENTIALS,
        accessToken: 'access-secret',
      });
      vi.mocked(fetchAccountProfile)
        .mockImplementationOnce((_server, _token, signal) => {
          markProfileStarted();
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              reject(new AccountClientError('cancelled'));
            }, { once: true });
          });
        })
        .mockResolvedValueOnce({ id: 'user-1', name: 'Ada', email: null });

      const first = useAccountStore.getState().hydrate();
      await profileStarted;
      await vi.advanceTimersByTimeAsync(ACCOUNT_PROFILE_TIMEOUT_MS);
      await first;
      expect(useAccountStore.getState().profileStatus).toBe('error');

      await useAccountStore.getState().hydrate();
      expect(fetchAccountProfile).toHaveBeenCalledTimes(2);
      expect(useAccountStore.getState()).toMatchObject({
        status: 'signed_in', profileStatus: 'ready', account: { name: 'Ada' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a stalled refresh without retrying its one-time token', async () => {
    vi.useFakeTimers();
    try {
      let markRefreshStarted!: () => void;
      const refreshStarted = new Promise<void>((resolve) => {
        markRefreshStarted = resolve;
      });
      vi.mocked(loadAccountCredentials).mockResolvedValue(STORED_CREDENTIALS);
      vi.mocked(fetchAccountProfile).mockRejectedValue(
        new AccountClientError('unauthenticated', 401),
      );
      vi.mocked(refresh).mockImplementation((_server, _token, signal) => {
        markRefreshStarted();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new AccountClientError('cancelled'));
          }, { once: true });
        });
      });

      const hydrating = useAccountStore.getState().hydrate();
      await refreshStarted;
      await vi.advanceTimersByTimeAsync(ACCOUNT_REFRESH_TIMEOUT_MS);
      await hydrating;
      await useAccountStore.getState().hydrate();

      expect(refresh).toHaveBeenCalledOnce();
      expect(useAccountStore.getState()).toMatchObject({
        status: 'signed_in', profileStatus: 'error', error: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires only after the refresh endpoint definitively rejects the credential', async () => {
    vi.mocked(loadAccountCredentials).mockResolvedValue(STORED_CREDENTIALS);
    vi.mocked(fetchAccountProfile).mockRejectedValue(
      new AccountClientError('unauthenticated', 401),
    );
    vi.mocked(refresh).mockRejectedValue(
      new AccountClientError('token_reuse_detected', 401),
    );

    await useAccountStore.getState().hydrate();

    expect(fetchAccountProfile).toHaveBeenCalledOnce();
    expect(saveAccountCredentials).not.toHaveBeenCalled();
    expect(useAccountStore.getState()).toMatchObject({
      status: 'expired',
      account: { userId: 'user-1' },
      profileStatus: 'error',
      error: 'session_expired',
    });
  });

  it('fails closed when a rotated credential cannot be confirmed in safeStorage', async () => {
    vi.mocked(loadAccountCredentials).mockResolvedValue(STORED_CREDENTIALS);
    vi.mocked(fetchAccountProfile).mockRejectedValue(
      new AccountClientError('unauthenticated', 401),
    );
    vi.mocked(saveAccountCredentials).mockRejectedValue(
      new Error('account_credentials_not_confirmed'),
    );

    await useAccountStore.getState().hydrate();

    expect(fetchAccountProfile).toHaveBeenCalledOnce();
    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_out',
      account: null,
      profileStatus: 'idle',
      error: 'credential_storage_unavailable',
    });
  });

  it.each([
    ['another identity', 'another-user'],
    ['no readable identity', null],
  ] as const)('does not persist or use a rotated access token with %s', async (_label, userId) => {
    vi.mocked(loadAccountCredentials).mockResolvedValue(STORED_CREDENTIALS);
    vi.mocked(fetchAccountProfile).mockRejectedValue(
      new AccountClientError('unauthenticated', 401),
    );
    vi.mocked(userIdFromAccessToken).mockReturnValueOnce(userId);

    await useAccountStore.getState().hydrate();

    expect(saveAccountCredentials).not.toHaveBeenCalled();
    expect(fetchAccountProfile).toHaveBeenCalledOnce();
    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_in',
      account: { userId: 'user-1' },
      profileStatus: 'error',
    });
  });

  it('never sends an enterprise credential to the personal refresh endpoint', async () => {
    vi.mocked(loadAccountCredentials).mockResolvedValue({
      ...STORED_CREDENTIALS,
      kind: 'enterprise',
    });
    vi.mocked(fetchAccountProfile).mockRejectedValue(
      new AccountClientError('unauthenticated', 401),
    );

    await useAccountStore.getState().hydrate();

    expect(refresh).not.toHaveBeenCalled();
    expect(saveAccountCredentials).not.toHaveBeenCalled();
    expect(clearAccountCredentials).not.toHaveBeenCalled();
    expect(useAccountStore.getState()).toMatchObject({
      status: 'expired',
      account: { userId: 'user-1', kind: 'enterprise' },
      error: 'session_expired',
    });
  });

  it('keeps the visible identity while a foreground hydration reloads its profile', async () => {
    let resolveProfile!: (value: { id: string; name: string; email: string | null }) => void;
    vi.mocked(loadAccountCredentials).mockResolvedValue({
      ...STORED_CREDENTIALS,
      accessToken: 'access-secret',
    });
    vi.mocked(fetchAccountProfile).mockReturnValue(new Promise((resolve) => {
      resolveProfile = resolve;
    }));
    useAccountStore.setState({
      status: 'signed_in',
      account: {
        serverUrl: STORED_CREDENTIALS.serverUrl,
        userId: 'user-1',
        kind: 'personal',
        name: 'Ada',
        email: 'ada@example.com',
      },
      profileStatus: 'ready',
      error: null,
    });

    const hydrating = useAccountStore.getState().hydrate();
    await vi.waitFor(() => expect(useAccountStore.getState().profileStatus).toBe('loading'));
    expect(useAccountStore.getState().account).toMatchObject({
      name: 'Ada', email: 'ada@example.com',
    });
    resolveProfile({ id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com' });
    await hydrating;
    expect(useAccountStore.getState().account?.name).toBe('Ada Lovelace');
  });

  it('keeps a previously verified identity when foreground revalidation is offline', async () => {
    vi.mocked(loadAccountCredentials).mockResolvedValue({
      ...STORED_CREDENTIALS,
      accessToken: 'access-secret',
    });
    vi.mocked(fetchAccountProfile).mockRejectedValue(new AccountClientError('network_error'));
    useAccountStore.setState({
      status: 'signed_in',
      account: {
        serverUrl: STORED_CREDENTIALS.serverUrl,
        userId: 'user-1',
        kind: 'personal',
        name: 'Ada',
        email: 'ada@example.com',
      },
      profileStatus: 'ready',
      error: null,
    });

    await useAccountStore.getState().hydrate();

    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_in',
      account: { userId: 'user-1', name: 'Ada', email: 'ada@example.com' },
      profileStatus: 'error',
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

    expect(refresh).toHaveBeenCalledOnce();
    expect(fetchAccountProfile).toHaveBeenCalledTimes(2);
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

  it('lets sign-out clear and revoke the rotated pair without reviving the account', async () => {
    let resolveRefresh!: (value: typeof ROTATED_PAIR) => void;
    vi.mocked(loadAccountCredentials)
      .mockResolvedValueOnce(STORED_CREDENTIALS)
      .mockResolvedValueOnce(STORED_CREDENTIALS)
      .mockResolvedValueOnce(STORED_CREDENTIALS);
    vi.mocked(fetchAccountProfile).mockRejectedValue(
      new AccountClientError('unauthenticated', 401),
    );
    vi.mocked(refresh).mockReturnValue(new Promise((resolve) => {
      resolveRefresh = resolve;
    }));

    const hydrating = useAccountStore.getState().hydrate();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const signingOut = useAccountStore.getState().signOut();
    expect(useAccountStore.getState()).toMatchObject({ status: 'signed_out', account: null });
    await signingOut;
    expect(clearAccountCredentials).toHaveBeenCalledOnce();
    expect(saveAccountCredentials).not.toHaveBeenCalled();

    resolveRefresh(ROTATED_PAIR);
    await hydrating;

    expect(saveAccountCredentials).not.toHaveBeenCalled();
    expect(logout).toHaveBeenNthCalledWith(
      1,
      STORED_CREDENTIALS.serverUrl,
      STORED_CREDENTIALS.accessToken,
      STORED_CREDENTIALS.refreshToken,
      expect.any(AbortSignal),
    );
    expect(logout).toHaveBeenNthCalledWith(
      2,
      STORED_CREDENTIALS.serverUrl,
      ROTATED_PAIR.access_token,
      ROTATED_PAIR.refresh_token,
      expect.any(AbortSignal),
    );
    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_out', account: null, profileStatus: 'idle', error: null,
    });
  });

  it('rechecks the sign-out fence after a delayed persistence read', async () => {
    let markPersistenceReadStarted!: () => void;
    let resolvePersistenceRead!: (value: typeof STORED_CREDENTIALS) => void;
    const persistenceReadStarted = new Promise<void>((resolve) => {
      markPersistenceReadStarted = resolve;
    });
    vi.mocked(loadAccountCredentials)
      .mockResolvedValueOnce(STORED_CREDENTIALS)
      .mockResolvedValueOnce(STORED_CREDENTIALS)
      .mockImplementationOnce(() => {
        markPersistenceReadStarted();
        return new Promise((resolve) => {
          resolvePersistenceRead = resolve;
        });
      })
      .mockResolvedValueOnce(STORED_CREDENTIALS);
    vi.mocked(fetchAccountProfile).mockRejectedValue(
      new AccountClientError('unauthenticated', 401),
    );

    const hydrating = useAccountStore.getState().hydrate();
    await persistenceReadStarted;
    const signingOut = useAccountStore.getState().signOut();
    resolvePersistenceRead(STORED_CREDENTIALS);
    await Promise.all([hydrating, signingOut]);

    expect(saveAccountCredentials).not.toHaveBeenCalled();
    expect(clearAccountCredentials).toHaveBeenCalledOnce();
    expect(useAccountStore.getState()).toMatchObject({ status: 'signed_out', account: null });
  });

  it('does not let login-attempt cancellation turn an established refresh into a hidden session', async () => {
    let resolveRefresh!: (value: typeof ROTATED_PAIR) => void;
    vi.mocked(loadAccountCredentials).mockResolvedValue(STORED_CREDENTIALS);
    vi.mocked(fetchAccountProfile)
      .mockRejectedValueOnce(new AccountClientError('unauthenticated', 401))
      .mockResolvedValueOnce({ id: 'user-1', name: 'Ada', email: null });
    vi.mocked(refresh).mockReturnValue(new Promise((resolve) => {
      resolveRefresh = resolve;
    }));

    const hydrating = useAccountStore.getState().hydrate();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    useAccountStore.getState().cancel();
    expect(useAccountStore.getState().status).toBe('signed_in');

    resolveRefresh(ROTATED_PAIR);
    await hydrating;

    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_in', account: { userId: 'user-1', name: 'Ada' }, profileStatus: 'ready',
    });
  });

  it('orders rotation, sign-out, and a different new login without crossing identities', async () => {
    const newPair = {
      ...PAIR,
      access_token: 'new-user-access',
      refresh_token: 'new-user-refresh',
    } as const;
    let resolveRefresh!: (value: typeof ROTATED_PAIR) => void;
    vi.mocked(loadAccountCredentials)
      .mockResolvedValueOnce(STORED_CREDENTIALS)
      .mockResolvedValueOnce(STORED_CREDENTIALS)
      .mockResolvedValueOnce(STORED_CREDENTIALS);
    vi.mocked(fetchAccountProfile)
      .mockRejectedValueOnce(new AccountClientError('unauthenticated', 401))
      .mockResolvedValueOnce({ id: 'user-2', name: 'Grace', email: 'grace@example.com' });
    vi.mocked(refresh).mockReturnValue(new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    vi.mocked(exchangeCode).mockResolvedValue(newPair);
    vi.mocked(userIdFromAccessToken).mockImplementation((token) => (
      token === newPair.access_token ? 'user-2' : 'user-1'
    ));

    const hydrating = useAccountStore.getState().hydrate();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const signingOut = useAccountStore.getState().signOut();
    await start();
    const loggingIn = useAccountStore.getState().handleDeepLink(
      'abu://auth?code=new-code&state=expected-state',
    );

    resolveRefresh(ROTATED_PAIR);
    await Promise.all([hydrating, signingOut, loggingIn]);

    expect(saveAccountCredentials).toHaveBeenCalledOnce();
    expect(saveAccountCredentials).toHaveBeenCalledWith({
      serverUrl: STORED_CREDENTIALS.serverUrl,
      accessToken: newPair.access_token,
      refreshToken: newPair.refresh_token,
      userId: 'user-2',
      kind: 'personal',
    });
    expect(useAccountStore.getState()).toMatchObject({
      status: 'signed_in',
      account: { userId: 'user-2', name: 'Grace', email: 'grace@example.com' },
      profileStatus: 'ready',
    });
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
