import { useAccountStore } from '@/core/account/accountStore';

let initialization: Promise<void> | null = null;

/** Restore the non-secret account summary from safeStorage at app startup. */
export function initializeAccountProtocol(): Promise<void> {
  if (initialization) return initialization;
  initialization = useAccountStore.getState().hydrate();
  return initialization;
}
