import { getLabsExperiment } from './registry';

/**
 * Pure (store-free) half of Labs flag resolution, split out of `resolve.ts` so
 * the sidecar shim (`sidecar/src/shims/labsResolveRun.ts`) can reuse the exact
 * fail-safe semantics without dragging `@/stores/settingsStore` into the
 * sidecar bundle. The store-coupled readers (`isLabsFlagOn`, `useLabsFlag`)
 * stay in `resolve.ts`.
 *
 * Effective value of a Labs flag: stored user override first, else the
 * registry default, else `false`. An `id` with no registry entry (an orphan
 * left behind by a graduated/removed experiment) resolves to `false`.
 */
export function resolveLabsFlag(id: string, stored: Record<string, boolean> | undefined): boolean {
  const exp = getLabsExperiment(id);
  // No registry entry → not a real (or no-longer-a) experiment. Fail safe to
  // off, ignoring any stale stored value a graduated experiment left behind.
  if (!exp) return false;
  // A missing stored map (a settings snapshot or sidecar mirror seeded before
  // `labs` existed) resolves to the registry default rather than throwing.
  if (stored && Object.prototype.hasOwnProperty.call(stored, id)) return stored[id] === true;
  return exp.defaultEnabled;
}
