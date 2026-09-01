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
import type { MarketplaceEntry } from './marketplace';

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
