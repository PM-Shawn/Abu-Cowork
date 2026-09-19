import { useAccountStore } from '@/core/account/accountStore';

let initialization: Promise<void> | null = null;
let listenersInstalled = false;
let lastRevalidationStartedAt = Number.NEGATIVE_INFINITY;
export const ACCOUNT_REVALIDATION_MIN_INTERVAL_MS = 60_000;

function revalidateSignedInAccount(force: boolean): void {
  const account = useAccountStore.getState();
  if (account.status !== 'signed_in' || account.account?.kind !== 'personal') return;
  const now = Date.now();
  const elapsed = now - lastRevalidationStartedAt;
  if (!force && elapsed >= 0 && elapsed < ACCOUNT_REVALIDATION_MIN_INTERVAL_MS) return;
  lastRevalidationStartedAt = now;
  void account.hydrate();
}

function onAccountWindowFocus(): void {
  revalidateSignedInAccount(false);
}

function onAccountVisibilityChange(): void {
  if (document.visibilityState === 'visible') revalidateSignedInAccount(false);
}

function onAccountOnline(): void {
  revalidateSignedInAccount(true);
}

function installAccountRevalidationListeners(): void {
  if (listenersInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
  listenersInstalled = true;
  window.addEventListener('focus', onAccountWindowFocus);
  window.addEventListener('online', onAccountOnline);
  document.addEventListener('visibilitychange', onAccountVisibilityChange);
}

/** Restore the non-secret account summary from safeStorage at app startup. */
export function initializeAccountProtocol(): Promise<void> {
  installAccountRevalidationListeners();
  if (initialization) return initialization;
  lastRevalidationStartedAt = Date.now();
  initialization = useAccountStore.getState().hydrate();
  return initialization;
}

export function __resetAccountRuntimeForTest(): void {
  if (listenersInstalled && typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.removeEventListener('focus', onAccountWindowFocus);
    window.removeEventListener('online', onAccountOnline);
    document.removeEventListener('visibilitychange', onAccountVisibilityChange);
  }
  listenersInstalled = false;
  initialization = null;
  lastRevalidationStartedAt = Number.NEGATIVE_INFINITY;
}
