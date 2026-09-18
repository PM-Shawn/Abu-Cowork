/**
 * Refresh hooks for managed providers.
 *
 * A managed provider's model list belongs to the external system that
 * registered it, so only that system knows how to pull a fresh one. It leaves
 * a refresher here; the settings card and the model picker call it without
 * knowing what is behind it.
 */
type Refresher = () => Promise<void>;

const refreshers = new Map<string, Refresher>();

export function setManagedProviderRefresher(providerId: string, refresher: Refresher | null): void {
  if (refresher) refreshers.set(providerId, refresher);
  else refreshers.delete(providerId);
}

/** Resolves once the owning system has finished its refresh. No-op for ids nobody registered. */
export async function refreshManagedProvider(providerId: string): Promise<void> {
  await refreshers.get(providerId)?.();
}
