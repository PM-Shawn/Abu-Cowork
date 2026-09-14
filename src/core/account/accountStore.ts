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
let pendingAuthorization: PendingAuthorization | null = null;
let activeProfileRequest: ActiveProfileRequest | null = null;
let credentialMutationQueue: Promise<void> = Promise.resolve();
const LOGOUT_TIMEOUT_MS = 10_000;
export const ACCOUNT_BROWSER_TIMEOUT_MS = 10 * 60 * 1000;

function nextOperationId(): number {
  if (activeProfileRequest) {
    activeProfileRequest.controller.abort();
    activeProfileRequest = null;
  }
  operationId += 1;
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

async function loadProfileIntoSummary(
  credentials: AccountCredentials,
  id: number,
  set: (state: Partial<AccountState>) => void,
): Promise<void> {
  const request = { id, controller: new AbortController() };
  activeProfileRequest = request;
  try {
    const profile = await fetchAccountProfile(
      credentials.serverUrl,
      credentials.accessToken,
      request.controller.signal,
    );
    if (id !== operationId || activeProfileRequest !== request) return;
    if (profile.id !== credentials.userId) {
      set({ account: summaryOf(credentials), profileStatus: 'error' });
      return;
    }
    set({
      account: { ...summaryOf(credentials), name: profile.name, email: profile.email },
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
        set({ account: summaryOf(credentials), profileStatus: 'error' });
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

// Only the account summary and transition state live in Zustand. Credentials
// stay exclusively in Electron safeStorage through credentials.ts.
export const useAccountStore = create<AccountStore>()((set, get) => ({
  status: 'signed_out',
  account: null,
  profileStatus: 'idle',
  error: null,

  hydrate: async () => {
    const id = nextOperationId();
    discardPendingAuthorization();
    try {
      const credentials = await loadAccountCredentials();
      if (id !== operationId) return;
      if (!credentials) {
        set({ status: 'signed_out', account: null, profileStatus: 'idle', error: null });
        return;
      }
      set({
        status: 'signed_in',
        account: summaryOf(credentials),
        profileStatus: 'loading',
        error: null,
      });
      await loadProfileIntoSummary(credentials, id, set);
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
  },

  startPersonalLogin: async (serverUrl = PERSONAL_ACCOUNT_SERVER_URL) => {
    if (get().status === 'signed_in') return null;
    const id = nextOperationId();
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
      const saved = await enqueueCredentialMutation(async () => {
        if (pending.id !== operationId) return false;
        await saveAccountCredentials(credentials);
        return pending.id === operationId;
      });
      if (!saved || pending.id !== operationId) return true;
      pendingAuthorization = null;
      set({
        status: 'signed_in',
        account: summaryOf(credentials),
        profileStatus: 'loading',
        error: null,
      });
      await loadProfileIntoSummary(credentials, pending.id, set);
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
    const wasExchanging = get().status === 'exchanging';
    const cancelId = nextOperationId();
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
    const id = nextOperationId();
    discardPendingAuthorization();
    set({ status: 'signed_out', account: null, profileStatus: 'idle', error: null });
    let credentials: AccountCredentials | null;
    try {
      credentials = await enqueueCredentialMutation(async () => {
        const stored = await loadAccountCredentials();
        await clearAccountCredentials();
        return stored;
      });
    } catch {
      if (id === operationId) {
        set({
          status: 'expired',
          account: null,
          profileStatus: 'idle',
          error: 'credential_storage_unavailable',
        });
      }
      return;
    }
    if (credentials) await bestEffortRemoteLogout(credentials);
  },
}));

export function __resetAccountStoreForTest(): void {
  operationId = 0;
  discardPendingAuthorization();
  credentialMutationQueue = Promise.resolve();
  __resetAccountDeepLinkListenerForTest();
  useAccountStore.setState({ status: 'signed_out', account: null, profileStatus: 'idle', error: null });
}
