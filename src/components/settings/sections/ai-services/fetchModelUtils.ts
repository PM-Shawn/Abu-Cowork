import type { ModelInfo } from '@/types/provider';

/**
 * Pure, testable helpers for AddProviderModal's model checklist. Kept
 * dependency-free (no React, no store) so they can be unit tested directly;
 * `isKnown` is injected rather than imported so callers can stub it in tests
 * without touching the real capability table.
 *
 * Background: a raw GET /v1/models call against an aggregator/gateway
 * endpoint can return hundreds of unrelated chat models. Pre-checking them
 * (whether all of them, or just the ids the local capability table happens to
 * recognize) means the user has to audit and uncheck a list they never chose.
 * The rule is now "fetch shows, the user picks": a cloud fetch never changes
 * the selection — it only populates the list, ordered known-first so the
 * familiar ids are the ones in reach, with a search box to narrow it down.
 * Locally pulled catalogs (Ollama) are the exception — see `unionSelectAll`.
 */

/** Show the checklist's search box once the list is long enough that scrolling
 *  to find one model is annoying. The list viewport shows ~5 rows, so a couple
 *  of screens' worth is the point where filtering starts to earn its space. */
export const MODEL_FILTER_MIN_ITEMS = 8;

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
 * Select every model in `models`, union'd with `existingSelected`.
 *
 * Only used for locally pulled catalogs (Ollama): those are models the user
 * already deliberately pulled onto this machine, and there are typically a
 * handful, so "check them all" is what they meant. The union preserves ids
 * that were already selected (a manually added id, or — in edit mode — the
 * provider's saved models) so re-checking Ollama can't silently drop them.
 *
 * Cloud fetches deliberately do NOT use this: see the module comment.
 */
export function unionSelectAll(
  models: ModelInfo[],
  existingSelected: Set<string>,
): Set<string> {
  return new Set([...existingSelected, ...models.map((m) => m.id)]);
}

/**
 * Filter the checklist by a free-text query, matching either the model id or
 * its display label (an Ollama label carries the parameter size, a curated
 * label can differ from the raw id) — case-insensitive, whitespace-trimmed.
 * An empty/whitespace query returns the list unchanged.
 */
export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter(
    (m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q),
  );
}
