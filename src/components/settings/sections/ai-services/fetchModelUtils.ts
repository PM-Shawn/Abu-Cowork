import type { ModelInfo } from '@/types/provider';

/**
 * B6 fetch-models convergence — pure, testable helpers for AddProviderModal's
 * "Fetch models" flow. Kept dependency-free (no React, no store) so they can
 * be unit tested directly; `isKnown` is injected rather than imported so
 * callers can stub it in tests without touching the real capability table.
 *
 * Background: a raw GET /v1/models call against an aggregator/gateway
 * endpoint can return hundreds of unrelated chat models. Pre-checking every
 * one of them (the old behavior) buries the user's intended model in noise
 * and silently blows away any curated preset already in `selectedModels`.
 * These helpers implement "default collapse, no hard filter": every fetched
 * model still appears in the list (never dropped), but only recognized ids
 * get pre-checked once the list is large.
 */

/** Below this count, a fetched list is assumed to be a normal direct-provider
 *  catalog (not an aggregator dump) — pre-checking everything is not noisy. */
export const SMALL_LIST_MAX = 25;

/**
 * Sort fetched models with "known" ids first, preserving the original
 * (server-returned) order within each group — a stable partition, not a
 * full re-sort, so unknown ids don't get shuffled relative to each other.
 */
export function sortKnownFirst(
  models: ModelInfo[],
  isKnown: (id: string) => boolean,
): ModelInfo[] {
  const known: ModelInfo[] = [];
  const unknown: ModelInfo[] = [];
  for (const m of models) {
    (isKnown(m.id) ? known : unknown).push(m);
  }
  return [...known, ...unknown];
}

/**
 * Decide which fetched model ids should be pre-checked (added to
 * `selectedModels`) right after a fetch completes.
 *
 * - Small list (<= SMALL_LIST_MAX): pre-check ALL — a normal direct provider
 *   endpoint returning its own small catalog is not noise, so the old
 *   "select everything" behavior is still the right default here.
 * - Large list (> SMALL_LIST_MAX): pre-check ONLY ids `isKnown` recognizes
 *   (the aggregator-convergence case). If none are known, pre-check nothing
 *   — the user searches/picks manually rather than saving hundreds of models.
 * - Always UNION with `existingSelected` so a provider's curated preset
 *   (already selected before the fetch, e.g. a multi-endpoint plan's default
 *   models) is preserved rather than clobbered by a whole-set replace.
 */
export function computeFetchPreselection(
  models: ModelInfo[],
  isKnown: (id: string) => boolean,
  existingSelected: Set<string>,
): Set<string> {
  const preselect = models.length <= SMALL_LIST_MAX
    ? models.map((m) => m.id)
    : models.filter((m) => isKnown(m.id)).map((m) => m.id);

  return new Set([...existingSelected, ...preselect]);
}
