import { useSettingsStore } from '@/stores/settingsStore';
import { getLabsExperiment } from './registry';

/**
 * Effective value of a Labs flag: stored user override first, else the
 * registry default, else `false`. An `id` with no registry entry (an orphan
 * left behind by a graduated/removed experiment) resolves to `false`.
 */
export function resolveLabsFlag(id: string, stored: Record<string, boolean>): boolean {
  const exp = getLabsExperiment(id);
  // No registry entry → not a real (or no-longer-a) experiment. Fail safe to
  // off, ignoring any stale stored value a graduated experiment left behind.
  if (!exp) return false;
  if (Object.prototype.hasOwnProperty.call(stored, id)) return stored[id];
  return exp.defaultEnabled;
}

/**
 * Imperative read for non-React callers (tool-list assembly, agent loop).
 * Reads the live store, so callers that run per-request pick up toggles
 * without a restart.
 */
export function isLabsFlagOn(id: string): boolean {
  return resolveLabsFlag(id, useSettingsStore.getState().labs);
}

/**
 * React selector hook. Subscribes to the `labs` slice so consumers re-render
 * (and tabs/buttons appear/disappear) the instant a flag is toggled.
 */
export function useLabsFlag(id: string): boolean {
  const stored = useSettingsStore((s) => s.labs);
  return resolveLabsFlag(id, stored);
}
