import { useEffect } from 'react';
import { refreshManagedProvider } from '@/core/llm/managedProviderRefresh';
import type { ProviderInstance } from '@/types/provider';

export const OFFLINE_RECHECK_MS = 30_000;

/**
 * Keeps a managed provider's status current while the composer runs on it:
 * pulls its model list whenever the composer settles on it and when a turn
 * ends (so an outage or a withdrawn model shows up right after the turn that
 * hit it), and while the last pull failed, again every OFFLINE_RECHECK_MS so
 * the offline notice clears itself once the service is back.
 */
export function useManagedProviderLiveness(
  provider: Pick<ProviderInstance, 'id' | 'source' | 'status'> | undefined,
  turnRunning: boolean,
): void {
  const managedId = provider?.source === 'managed' ? provider.id : null;
  const offline = managedId !== null && provider?.status === 'failed';

  useEffect(() => {
    if (!managedId || turnRunning) return;
    void refreshManagedProvider(managedId);
  }, [managedId, turnRunning]);

  useEffect(() => {
    if (!managedId || !offline) return;
    const timer = window.setInterval(() => { void refreshManagedProvider(managedId); }, OFFLINE_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [managedId, offline]);
}
