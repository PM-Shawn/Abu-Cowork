/**
 * Current persisted `version` of each zustand store, DERIVED from the store
 * source at test time instead of copied into a literal.
 *
 * ## Why derive
 *
 * A spec that seeds `localStorage` must stamp the store's CURRENT version.
 * Stamp a lower one and zustand replays the migration chain over the state the
 * spec just injected on the next reload — so a future store bump whose migrate
 * branch rewrites one of those injected fields would silently clobber the
 * setup, and the spec would fail for a reason nobody would go looking for.
 * `tests/e2e/electronHelpers.ts` carried a hardcoded `version: 42` for four
 * bumps' worth of exactly that latent trap.
 *
 * Hardcoding the *right* number only moves the trap to the next bump: nothing
 * in `src/stores/` knows this file exists, so nothing fails when it drifts.
 * Reading the number out of the store source removes the copy entirely.
 *
 * ## When you do NOT need this
 *
 * Prefer leaving the version alone. A helper that MERGES into an entry the app
 * already wrote (`JSON.parse` → mutate `state` → write back the whole object)
 * carries the app's own version for free and can never drift — that is the
 * idiom in `dismissFirstRunOverlays` and every other `abu-settings` seed here.
 * This module is for the seeds that write an entry from scratch (`abu-schedule`,
 * `abu-triggers`), which have no version to preserve.
 *
 * ## Failure mode
 *
 * Fail-loud by construction: if the `persist` options in a store stop matching
 * the expected shape, `persistedStoreVersion` throws with the file it read
 * rather than guessing a number. Extend the regex here; never fall back to a
 * literal.
 */
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './electronHelpers';

/** localStorage key → the store module that owns its `persist` options. */
const STORE_SOURCES = {
  'abu-schedule': 'scheduleStore.ts',
  'abu-triggers': 'triggerStore.ts',
} as const;

export type PersistedStoreKey = keyof typeof STORE_SOURCES;

const cache = new Map<PersistedStoreKey, number>();

/**
 * The `version` a `localStorage` seed for `key` must be stamped with.
 *
 * Matches the `name: '<key>', version: N` pair inside the store's `persist`
 * options (comments between the two lines are tolerated). Node-side only —
 * call it in the spec and pass the number into `page.evaluate`.
 */
export function persistedStoreVersion(key: PersistedStoreKey): number {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const source = path.join(REPO_ROOT, 'src', 'stores', STORE_SOURCES[key]);
  const contents = fs.readFileSync(source, 'utf8');
  // `(?:\s|//…\n|/*…*/)*` so a comment landing between the two lines does not
  // turn a readable bump into an unexplained E2E failure.
  const pattern = new RegExp(
    `name:\\s*(['"\`])${key}\\1\\s*,(?:\\s|//[^\\n]*\\n|/\\*[\\s\\S]*?\\*/)*version:\\s*(\\d+)\\s*,`,
  );
  const match = pattern.exec(contents);
  if (!match) {
    throw new Error(
      `Could not read the persisted version of "${key}" from ${source}. The persist `
      + 'options no longer match `name: \'<key>\', version: N` — update the pattern in '
      + 'tests/e2e/storeVersions.ts. Do NOT hardcode the number in a spec.',
    );
  }
  const version = Number(match[2]);
  cache.set(key, version);
  return version;
}
