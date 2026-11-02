import { useSettingsStore } from '@/stores/settingsStore';
import { getSettingsReader } from '@/core/agent/ports/settingsReader';
import { resolveLabsFlag } from './resolveCore';

export { resolveLabsFlag } from './resolveCore';

/**
 * Imperative read for non-React callers (tool-list assembly, agent loop).
 * Reads the live store, so callers that run per-request pick up toggles
 * without a restart.
 */
export function isLabsFlagOn(id: string): boolean {
  return resolveLabsFlag(id, getSettingsReader().getSnapshot().labs);
}

/**
 * React selector hook. Subscribes to the `labs` slice so consumers re-render
 * (and tabs/buttons appear/disappear) the instant a flag is toggled.
 */
export function useLabsFlag(id: string): boolean {
  const stored = useSettingsStore((s) => s.labs);
  return resolveLabsFlag(id, stored);
}
