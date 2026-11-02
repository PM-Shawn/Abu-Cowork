/**
 * Sidecar-local replacement for `src/core/labs/resolve.ts` — the real module
 * statically imports `@/stores/settingsStore` (forbidden in the sidecar
 * bundle) for its React hook. This shim swaps the settings source only:
 * `isLabsFlagOn` reads the same `labs` map from the sidecar-GLOBAL settings
 * mirror (`settingsMirror.ts`), which every shell `state.settings` push keeps
 * fresh, so a toggle flipped in the renderer takes effect here without a
 * restart — the same freshness contract the real module documents for the
 * live store.
 *
 * `resolveLabsFlag`'s fail-safe semantics (unknown id → false, `=== true`
 * boolean invariant) are shared verbatim via `resolveCore.ts`; nothing is
 * duplicated here. `useLabsFlag` is a React hook with no sidecar consumer and
 * is intentionally not re-exported.
 *
 * No throw: a read before the mirror is seeded surfaces the mirror's own
 * "seed before running a loop" error, the same contract every other settings
 * read in the sidecar runs under.
 */
import { resolveLabsFlag } from '@/core/labs/resolveCore';
import { getSettingsMirrorReader } from '../settingsMirror';

export { resolveLabsFlag } from '@/core/labs/resolveCore';

export function isLabsFlagOn(id: string): boolean {
  return resolveLabsFlag(id, getSettingsMirrorReader().getSnapshot().labs);
}
