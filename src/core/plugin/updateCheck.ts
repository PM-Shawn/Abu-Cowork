/**
 * Whether a marketplace entry is a newer version of what is installed.
 *
 * The detection identity is per source kind, matching how the ecosystem
 * actually versions (firsthand: Codex compares a git revision for git sources
 * and a bundle version for packaged ones — never a single semver comparison):
 *   - relative (local) source → compare the entry's declared `version`;
 *   - remote (url / git-subdir) source → compare the pinned `sha`.
 *
 * This is only possible because `installed.json` records `version` and `sha`.
 * Codex's remote-install record stores neither, which is exactly why it cannot
 * offer an "update available" signal — recording them is the one step that
 * lets Abu do what Codex can't.
 */

import type { InstalledPlugin } from './installedStore';
import { resolveRename, type MarketplaceEntry } from './marketplace';
import { pluginKey } from './paths';

export type UpdateStatus = 'not-installed' | 'up-to-date' | 'update-available';

export function entryUpdateStatus(
  entry: MarketplaceEntry,
  installed: InstalledPlugin | undefined,
): UpdateStatus {
  if (!installed) return 'not-installed';

  if (entry.source.kind === 'relative') {
    // No declared version means no basis to claim an update — treat as current
    // rather than nagging on every browse.
    if (!entry.version) return 'up-to-date';
    return entry.version === installed.version ? 'up-to-date' : 'update-available';
  }

  // Remote: the pinned sha is the identity. A legacy install with no recorded
  // sha can't be proven current, so surface it as updatable.
  const pinned = 'sha' in entry.source ? entry.source.sha : undefined;
  if (!pinned) return 'up-to-date';
  return pinned === installed.sha ? 'up-to-date' : 'update-available';
}

/**
 * The `pluginKey`s (keyed by `marketplaceName`, NOT any name the entry or its
 * manifest declares internally — see `MarketplaceBrowser`'s effect for why
 * that distinction matters) of every entry in `entries` that has an update
 * available against `installedByName`. Sorted, so callers get a stable,
 * order-independent list straight from the pure computation rather than
 * re-deriving that themselves.
 *
 * Pulled out of `MarketplaceBrowser`'s effect so the actual detection logic
 * — not just `setUpdateAvailableKeys`'s scope bookkeeping — has direct test
 * coverage.
 */
export function updateAvailableKeysFor(
  entries: MarketplaceEntry[],
  installedByName: ReadonlyMap<string, InstalledPlugin>,
  marketplaceName: string,
): string[] {
  return entries
    .filter((entry) => entryUpdateStatus(entry, installedByName.get(entry.name)) === 'update-available')
    .map((entry) => pluginKey(entry.name, marketplaceName))
    .sort();
}

/**
 * The installs that belong to `marketplaceName`, keyed by the entry name they
 * would appear under **today** — i.e. resolved through the marketplace's
 * rename table, so a plugin installed under its old name still matches its
 * renamed entry.
 *
 * Shared by the market rows and `pluginStore.recomputeUpdates` so the badge
 * count and the per-row 「更新」 button are computed from exactly the same map;
 * two independently-built maps were how the two could disagree.
 */
export function installedByEntryName(
  installed: readonly InstalledPlugin[],
  marketplaceName: string,
  renames: Record<string, string> | undefined,
): Map<string, InstalledPlugin> {
  const byName = new Map<string, InstalledPlugin>();
  for (const p of installed) {
    if (p.marketplace !== marketplaceName) continue;
    byName.set(resolveRename(p.name, renames), p);
  }
  return byName;
}
