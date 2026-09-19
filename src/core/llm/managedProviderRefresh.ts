/**
 * Hooks a managed provider's owner leaves for the host.
 *
 * A managed provider's model list belongs to the external system that
 * registered it, so only that system knows how to pull a fresh one, and only
 * it knows which of the user's own models was in use before it took over the
 * default. It leaves both here; the settings card, the model picker and the
 * composer call them without knowing what is behind them.
 */
type Refresher = () => Promise<void>;
type ModelRef = { providerId: string; modelId: string };
type PersonalFallbackReader = () => ModelRef | null;

const refreshers = new Map<string, Refresher>();
const personalFallbacks = new Map<string, PersonalFallbackReader>();

export function setManagedProviderRefresher(providerId: string, refresher: Refresher | null): void {
  if (refresher) refreshers.set(providerId, refresher);
  else refreshers.delete(providerId);
}

/** Resolves once the owning system has finished its refresh. No-op for ids nobody registered. */
export async function refreshManagedProvider(providerId: string): Promise<void> {
  await refreshers.get(providerId)?.();
}

export function setManagedProviderPersonalFallback(providerId: string, reader: PersonalFallbackReader | null): void {
  if (reader) personalFallbacks.set(providerId, reader);
  else personalFallbacks.delete(providerId);
}

/** The user's own model that was the default before this provider took over, if its owner recorded one. */
export function readManagedProviderPersonalFallback(providerId: string): ModelRef | null {
  return personalFallbacks.get(providerId)?.() ?? null;
}
