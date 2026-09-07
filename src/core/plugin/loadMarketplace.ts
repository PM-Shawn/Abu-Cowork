/**
 * Read a marketplace manifest off disk.
 *
 * Split from `marketplace.ts` on purpose: that module is a pure parser with no
 * filesystem dependency (which is what makes it cheap to test), so the "where
 * does the JSON come from" half lives here. It used to sit next to the browser
 * UI; it moved into `core/` once `pluginStore.recomputeUpdates` needed to scan
 * every added market for the update badge — a store must not import from
 * `components/`, and both callers have to read markets the same way for the
 * badge count and the market rows to agree.
 *
 * Candidate order matches the installer's manifest lookup: Abu's own
 * `.abu-plugin` wins over the `.claude-plugin` and `.agents/plugins`
 * (Codex) directories we stay compatible with, so a marketplace that ships
 * more than one can express an Abu-specific listing.
 */

import { readTextFile, exists } from '@tauri-apps/plugin-fs';
import { joinPath } from '@/utils/pathUtils';
import { parseMarketplace, type Marketplace } from '@/core/plugin/marketplace';

export const MARKETPLACE_MANIFEST_CANDIDATES = [
  '.abu-plugin/marketplace.json',
  '.claude-plugin/marketplace.json',
  '.agents/plugins/marketplace.json',
] as const;

/** Expand a leading `~` so a hand-typed path resolves like it does in a shell. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return joinPath(home, path.slice(2));
  return path;
}

/**
 * Load and parse the marketplace manifest in `dir`.
 *
 * Throws with a path-bearing message when nothing is there or the JSON is
 * malformed — the caller surfaces it verbatim, since "which file did you
 * expect" is the only actionable part of this failure.
 */
export async function loadMarketplaceFromDir(dir: string): Promise<Marketplace> {
  for (const candidate of MARKETPLACE_MANIFEST_CANDIDATES) {
    const path = joinPath(dir, candidate);
    if (!(await exists(path))) continue;

    const raw = await readTextFile(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Marketplace manifest is not valid JSON: ${path}`);
    }
    return parseMarketplace(parsed);
  }

  throw new Error(
    `No marketplace manifest in ${dir} (looked for ${MARKETPLACE_MANIFEST_CANDIDATES.join(', ')})`,
  );
}
