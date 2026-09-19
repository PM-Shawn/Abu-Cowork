import { openUrl } from '@tauri-apps/plugin-opener';
import { create } from 'zustand';
import {
  AccountClientError,
  buildAuthorizeUrl,
  exchangeCode,
  fetchAccountProfile,
  logout,
  normalizeAccountServerUrl,
  PERSONAL_ACCOUNT_SERVER_URL,
  refresh,
  userIdFromAccessToken,
} from '@/core/account/client';
import { clearAccountCredentials, loadAccountCredentials, saveAccountCredentials } from '@/core/account/credentials';
import type { AccountCredentials, AccountKind } from '@/core/account/credentials';
import {
  getAccountProtocolRegistrationStatus,
  isAccountAuthDeepLink,
  parseAccountAuthCallback,
} from '@/core/account/deepLink';
import {
  __resetAccountDeepLinkListenerForTest,
  ensureAccountDeepLinkListener,
} from '@/core/account/deepLinkListener';
import { createPkcePair } from '@/core/account/pkce';
import type { PkcePair } from '@/core/account/pkce';
import {
  activateExclusiveAccountSession,
  registerAccountSessionDeactivator,
} from '@/core/account/sessionCoordinator';

export type AccountStatus = 'signed_out' | 'awaiting_browser' | 'exchanging' | 'signed_in' | 'expired';

export interface AccountSummary {
  serverUrl: string;
  userId: string;
  kind: AccountKind;
  name: string | null;
  email: string | null;
}

export type AccountProfileStatus = 'idle' | 'loading' | 'ready' | 'error';

interface AccountState {
  status: AccountStatus;
  account: AccountSummary | null;
  profileStatus: AccountProfileStatus;
  error: string | null;
}

interface AccountActions {
  hydrate: () => Promise<void>;
  startPersonalLogin: (serverUrl?: string) => Promise<string | null>;
  handleDeepLink: (url: string) => Promise<boolean>;
  cancel: () => void;
  signOut: () => Promise<void>;
}

export type AccountStore = AccountState & AccountActions;

interface PendingAuthorization {
  id: number;
  serverUrl: string;
  pkce: PkcePair;
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout> | null;
}

interface ActiveProfileRequest {
  id: number;
  controller: AbortController;
}

let operationId = 0;
let loginStartOperationId: number | null = null;
let pendingAuthorization: PendingAuthorization | null = null;
let activeProfileRequest: ActiveProfileRequest | null = null;
let credentialMutationQueue: Promise<void> = Promise.resolve();
let credentialEpoch = 0;
let hydrateFlight: Promise<void> | null = null;
let refreshMemo: {
  source: AccountCredentials;
  result: Promise<RefreshResult>;
} | null = null;
const LOGOUT_TIMEOUT_MS = 10_000;
export const ACCOUNT_PROFILE_TIMEOUT_MS = 10_000;
export const ACCOUNT_REFRESH_TIMEOUT_MS = 10_000;
export const ACCOUNT_BROWSER_TIMEOUT_MS = 10 * 60 * 1000;

type RefreshResult =
  | { kind: 'refreshed'; credentials: AccountCredentials }
  | { kind: 'rejected' }
  | { kind: 'storage_unavailable' }
  | { kind: 'unavailable' }
  | { kind: 'superseded' };

function nextOperationId(): number {
  if (activeProfileRequest) {
    activeProfileRequest.controller.abort();
    activeProfileRequest = null;
  }
  operationId += 1;
  loginStartOperationId = null;
  return operationId;
}

function discardPendingAuthorization(): void {
  const pending = pendingAuthorization;
  pendingAuthorization = null;
  if (!pending) return;
  if (pending.timeout !== null) clearTimeout(pending.timeout);
  pending.controller.abort();
}

function enqueueCredentialMutation<T>(task: () => Promise<T>): Promise<T> {
  const result = credentialMutationQueue.then(task, task);
  credentialMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function summaryOf(credentials: AccountCredentials): AccountSummary {
  return {
    serverUrl: credentials.serverUrl,
    userId: credentials.userId,
    kind: credentials.kind,
    name: null,
    email: null,
  };
}

function summaryForHydration(
  credentials: AccountCredentials,
  current: AccountSummary | null,
): AccountSummary {
  if (
    current &&
    current.serverUrl === credentials.serverUrl &&
    current.userId === credentials.userId &&
    current.kind === credentials.kind
  ) return current;
  return summaryOf(credentials);
}

function credentialsEqual(
  left: AccountCredentials | null,
  right: AccountCredentials,
): boolean {
  return left !== null &&
    left.serverUrl === right.serverUrl &&
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.userId === right.userId &&
    left.kind === right.kind;
}

function refreshAccountCredentials(source: AccountCredentials): Promise<RefreshResult> {
  if (source.kind !== 'personal') return Promise.resolve({ kind: 'rejected' });
  if (refreshMemo && credentialsEqual(refreshMemo.source, source)) return refreshMemo.result;

  const epoch = credentialEpoch;
  const result = (async (): Promise<RefreshResult> => {
    let stored: AccountCredentials | null;
    try {
      stored = await enqueueCredentialMutation(loadAccountCredentials);
    } catch {
      return { kind: 'storage_unavailable' };
    }
    if (epoch !== credentialEpoch || !credentialsEqual(stored, source)) {
      return { kind: 'superseded' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ACCOUNT_REFRESH_TIMEOUT_MS);
    try {
      const pair = await refresh(source.serverUrl, source.refreshToken, controller.signal);
      const userId = userIdFromAccessToken(pair.access_token);
      if (userId !== source.userId) return { kind: 'unavailable' };
      const credentials: AccountCredentials = {
        serverUrl: source.serverUrl,
        accessToken: pair.access_token,
        refreshToken: pair.refresh_token,
        userId,
        kind: source.kind,
      };
      const persistence = await enqueueCredentialMutation(async () => {
        if (epoch !== credentialEpoch) return 'superseded' as const;
        let current: AccountCredentials | null;
        try {
          current = await loadAccountCredentials();
        } catch {
          return 'storage_unavailable' as const;
        }
        if (epoch !== credentialEpoch || !credentialsEqual(current, source)) {
          return 'superseded' as const;
        }
        try {
          await saveAccountCredentials(credentials);
          return 'saved' as const;
        } catch {
          return 'storage_unavailable' as const;
        }
      });
      if (persistence !== 'saved') {
        await bestEffortRemoteLogout(credentials);
        return { kind: persistence };
      }
      return { kind: 'refreshed', credentials };
    } catch (error) {
      return error instanceof AccountClientError && error.status === 401
        ? { kind: 'rejected' }
        : { kind: 'unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  })();
  refreshMemo = { source, result };
  return result;
}

async function fetchProfileWithDeadline(
  credentials: AccountCredentials,
  operationSignal: AbortSignal,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (operationSignal.aborted) controller.abort();
  else operationSignal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, ACCOUNT_PROFILE_TIMEOUT_MS);
  try {
    return await fetchAccountProfile(
      credentials.serverUrl,
      credentials.accessToken,
      controller.signal,
    );
  } finally {
    clearTimeout(timeout);
    operationSignal.removeEventListener('abort', abort);
  }
}

async function loadProfileIntoSummary(
  credentials: AccountCredentials,
  id: number,
  set: (state: Partial<AccountState>) => void,
  get: () => AccountStore,
): Promise<void> {
  const request = { id, controller: new AbortController() };
  activeProfileRequest = request;
  try {
    let activeCredentials = credentials;
    let profile;
    try {
      profile = await fetchProfileWithDeadline(activeCredentials, request.controller.signal);
    } catch (error) {
      if (
        !(error instanceof AccountClientError) ||
        error.status !== 401 ||
        activeCredentials.kind !== 'personal' ||
        id !== operationId ||
        activeProfileRequest !== request
      ) throw error;

      const refreshed = await refreshAccountCredentials(activeCredentials);
      if (id !== operationId || activeProfileRequest !== request) return;
      if (refreshed.kind === 'rejected') {
        set({
          status: 'expired',
          account: summaryOf(activeCredentials),
          profileStatus: 'error',
          error: 'session_expired',
        });
        return;
      }
      if (refreshed.kind === 'storage_unavailable') {
        set({
          status: 'signed_out',
          account: null,
          profileStatus: 'idle',
          error: 'credential_storage_unavailable',
        });
        return;
      }
      if (refreshed.kind !== 'refreshed') {
        set({
          account: summaryForHydration(activeCredentials, get().account),
          profileStatus: 'error',
        });
        return;
      }

      activeCredentials = refreshed.credentials;
      profile = await fetchProfileWithDeadline(activeCredentials, request.controller.signal);
    }
    if (id !== operationId || activeProfileRequest !== request) return;
    if (profile.id !== activeCredentials.userId) {
      set({
        account: summaryForHydration(activeCredentials, get().account),
        profileStatus: 'error',
      });
      return;
    }
    set({
      account: { ...summaryOf(activeCredentials), name: profile.name, email: profile.email },
      profileStatus: 'ready',
    });
  } catch (error) {
    if (id === operationId && activeProfileRequest === request) {
      if (error instanceof AccountClientError && error.status === 401) {
        set({
          status: 'expired',
          account: summaryOf(credentials),
          profileStatus: 'error',
          error: 'session_expired',
        });
      } else {
        set({
          account: summaryForHydration(credentials, get().account),
          profileStatus: 'error',
        });
      }
    }
  } finally {
    if (activeProfileRequest === request) activeProfileRequest = null;
  }
}

async function bestEffortRemoteLogout(credentials: AccountCredentials): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOGOUT_TIMEOUT_MS);
  try {
    await logout(
      credentials.serverUrl,
      credentials.accessToken,
      credentials.refreshToken,
      controller.signal,
    );
  } catch {
    // Local logout is authoritative for this device. Remote revocation retries
    // require a server-side protocol that does not exist in this batch.
  } finally {
    clearTimeout(timeout);
  }
}

interface DeactivatedPersonalSession {
  credentials: AccountCredentials | null;
  id: number;
  epoch: number;
}

function isCurrentPersonalSession(session: DeactivatedPersonalSession): boolean {
  return session.id === operationId && session.epoch === credentialEpoch;
}

async function deactivatePersonalSession(): Promise<DeactivatedPersonalSession> {
  const id = nextOperationId();
  credentialEpoch += 1;
  const epoch = credentialEpoch;
  discardPendingAuthorization();
  useAccountStore.setState({ status: 'signed_out', account: null, profileStatus: 'idle', error: null });
  try {
    return await enqueueCredentialMutation(async () => {
      const stored = await loadAccountCredentials();
      await clearAccountCredentials();
      return { credentials: stored, id, epoch };
    });
  } catch (error) {
    if (id === operationId) {
      useAccountStore.setState({
        status: 'expired',
        account: null,
        profileStatus: 'idle',
        error: 'credential_storage_unavailable',
      });
    }
    throw error;
  }
}

async function restorePersonalSession(session: DeactivatedPersonalSession): Promise<void> {
  const { credentials, id } = session;
  if (!credentials || !isCurrentPersonalSession(session)) return;
  await enqueueCredentialMutation(async () => {
    if (isCurrentPersonalSession(session)) await saveAccountCredentials(credentials);
  });
  if (!isCurrentPersonalSession(session)) return;
  useAccountStore.setState({
    status: 'signed_in',
    account: summaryOf(credentials),
    profileStatus: 'loading',
    error: null,
  });
  await loadProfileIntoSummary(credentials, id, useAccountStore.setState, useAccountStore.getState);
}

// Only the account summary and transition state live in Zustand. Credentials
// stay exclusively in Electron safeStorage through credentials.ts.
export const useAccountStore = create<AccountStore>()((set, get) => ({
  status: 'signed_out',
  account: null,
  profileStatus: 'idle',
  error: null,

  hydrate: () => {
    if (hydrateFlight) return hydrateFlight;
    const flight = (async () => {
      const id = nextOperationId();
      discardPendingAuthorization();
      try {
        const credentials = await enqueueCredentialMutation(loadAccountCredentials);
        if (id !== operationId) return;
        if (!credentials) {
          set({ status: 'signed_out', account: null, profileStatus: 'idle', error: null });
          return;
        }
        set({
          status: 'signed_in',
          account: summaryForHydration(credentials, get().account),
          profileStatus: 'loading',
          error: null,
        });
        await loadProfileIntoSummary(credentials, id, set, get);
      } catch {
        if (id === operationId) {
          set({
            status: 'signed_out',
            account: null,
            profileStatus: 'idle',
            error: 'credential_storage_unavailable',
          });
        }
      }
    })();
    hydrateFlight = flight;
    void flight.finally(() => {
      if (hydrateFlight === flight) hydrateFlight = null;
    });
    return flight;
  },

  startPersonalLogin: async (serverUrl = PERSONAL_ACCOUNT_SERVER_URL) => {
    if (get().status === 'signed_in') return null;
    const id = nextOperationId();
    loginStartOperationId = id;
    discardPendingAuthorization();
    set({ status: 'signed_out', account: null, profileStatus: 'idle', error: null });
    try {
      const normalizedServerUrl = normalizeAccountServerUrl(serverUrl);
      const registration = await getAccountProtocolRegistrationStatus();
      if (registration !== 'registered') {
        throw new AccountClientError(
          registration === 'not_registered' ? 'protocol_not_registered' : 'protocol_status_unknown',
        );
      }
      const pkce = await createPkcePair();
      if (id !== operationId) return null;
      const authorizeUrl = buildAuthorizeUrl(normalizedServerUrl, pkce);
      const pending: PendingAuthorization = {
        id,
        serverUrl: normalizedServerUrl,
        pkce,
        controller: new AbortController(),
        timeout: null,
      };
      pendingAuthorization = pending;
      loginStartOperationId = null;
      set({ status: 'awaiting_browser', account: null, profileStatus: 'idle', error: null });
      pending.timeout = setTimeout(() => {
        if (
          pendingAuthorization === pending &&
          pending.id === operationId &&
          get().status === 'awaiting_browser'
        ) {
          nextOperationId();
          discardPendingAuthorization();
          set({ status: 'expired', account: null, profileStatus: 'idle', error: 'timeout' });
        }
      }, ACCOUNT_BROWSER_TIMEOUT_MS);
      await ensureAccountDeepLinkListener((url) => get().handleDeepLink(url));
      if (id !== operationId) return null;
      await openUrl(authorizeUrl);
      if (id !== operationId) return null;
      return authorizeUrl;
    } catch (error) {
      if (id === operationId) {
        loginStartOperationId = null;
        discardPendingAuthorization();
        const code = error instanceof AccountClientError ? error.code : 'protocol_unavailable';
        set({ status: 'signed_out', account: null, profileStatus: 'idle', error: code });
      }
      return null;
    }
  },

  handleDeepLink: async (rawUrl) => {
    const callback = parseAccountAuthCallback(rawUrl);
    if (!callback) {
      if (isAccountAuthDeepLink(rawUrl) && pendingAuthorization && get().status === 'awaiting_browser') {
        set({ error: 'state_mismatch' });
        return true;
      }
      return false;
    }
    const pending = pendingAuthorization;
    if (!pending || get().status !== 'awaiting_browser') return true;
    if (callback.state !== pending.pkce.state) {
      // `abu://auth` is shared by personal and enterprise OAuth. A valid
      // callback with another state belongs to the other pending flow; leave
      // this request untouched so its own callback can still complete.
      return false;
    }

    if (pending.timeout !== null) {
      clearTimeout(pending.timeout);
      pending.timeout = null;
    }
    set({ status: 'exchanging', error: null });
    try {
      const pair = await exchangeCode(
        pending.serverUrl,
        callback.code,
        pending.pkce.verifier,
        pending.controller.signal,
      );
      if (pending.id !== operationId || pending.controller.signal.aborted) return true;
      const userId = userIdFromAccessToken(pair.access_token);
      if (!userId) throw new Error('invalid_response');
      const credentials: AccountCredentials = {
        serverUrl: pending.serverUrl,
        accessToken: pair.access_token,
        refreshToken: pair.refresh_token,
        userId,
        kind: 'personal',
      };
      const saved = await activateExclusiveAccountSession(
        'personal',
        async () => {
          await enqueueCredentialMutation(() => saveAccountCredentials(credentials));
          return () => enqueueCredentialMutation(clearAccountCredentials);
        },
        () => pending.id === operationId && !pending.controller.signal.aborted,
      );
      if (!saved || pending.id !== operationId) return true;
      pendingAuthorization = null;
      set({
        status: 'signed_in',
        account: summaryOf(credentials),
        profileStatus: 'loading',
        error: null,
      });
      await loadProfileIntoSummary(credentials, pending.id, set, get);
    } catch (error) {
      if (pending.id === operationId) {
        discardPendingAuthorization();
        const code = error instanceof AccountClientError
          ? error.code
          : error instanceof Error && error.message === 'invalid_response'
            ? 'invalid_response'
            : 'credential_storage_unavailable';
        set({ status: 'signed_out', account: null, profileStatus: 'idle', error: code });
      }
    }
    return true;
  },

  cancel: () => {
    const status = get().status;
    // Cancellation belongs to the browser-login attempt. A profile restore has
    // no cancel affordance, and treating an unrelated call as sign-out could
    // leave a completed token rotation persisted behind signed-out UI.
    if (
      status !== 'awaiting_browser' &&
      status !== 'exchanging' &&
      loginStartOperationId !== operationId
    ) return;
    const wasExchanging = status === 'exchanging';
    const cancelId = nextOperationId();
    if (wasExchanging) credentialEpoch += 1;
    discardPendingAuthorization();
    set({ status: 'signed_out', account: null, profileStatus: 'idle', error: 'cancelled' });
    if (wasExchanging) {
      void enqueueCredentialMutation(clearAccountCredentials).catch(() => {
        if (cancelId === operationId) {
          set({
            status: 'expired',
            account: null,
            profileStatus: 'idle',
            error: 'credential_storage_unavailable',
          });
        }
      });
    }
  },

  signOut: async () => {
    let credentials: AccountCredentials | null;
    try {
      ({ credentials } = await deactivatePersonalSession());
    } catch {
      return;
    }
    if (credentials) await bestEffortRemoteLogout(credentials);
  },
}));

registerAccountSessionDeactivator('personal', async () => {
  const id = operationId;
  // 等待刷新保存最终凭据，供企业登录失败时恢复；主动退出仍立即清理。
  if (refreshMemo) await refreshMemo.result;
  if (id !== operationId) throw new Error('account_session_transition_cancelled');
  const session = await deactivatePersonalSession();
  if (!isCurrentPersonalSession(session)) throw new Error('account_session_transition_cancelled');
  const { credentials } = session;
  if (!credentials) return;
  return {
    rollback: () => restorePersonalSession(session),
    commit: () => { void bestEffortRemoteLogout(credentials); },
  };
});

export function __resetAccountStoreForTest(): void {
  operationId = 0;
  loginStartOperationId = null;
  discardPendingAuthorization();
  credentialMutationQueue = Promise.resolve();
  credentialEpoch = 0;
  hydrateFlight = null;
  refreshMemo = null;
  __resetAccountDeepLinkListenerForTest();
  useAccountStore.setState({ status: 'signed_out', account: null, profileStatus: 'idle', error: null });
}
