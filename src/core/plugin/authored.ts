/**
 * Two derived questions the plugins page asks about an install, kept out of
 * the UI so both answers have one definition and one set of tests.
 *
 *   - "Is this mine?" — decides whether a plugin belongs under 「我的」.
 *   - "Is this orphaned?" — its marketplace is gone, so it can no longer be
 *     updated or re-installed from where it came. Only user-added markets can
 *     go missing this way; the built-in and enterprise markets are exempt
 *     because the user cannot remove either.
 *
 * Both are pure predicates over the install record; neither touches disk.
 */

import { BUILTIN_MARKET_NAME } from './builtinMarket';
import { isEnterpriseInstall } from './enterpriseMarket';
import type { InstalledPlugin } from './installedStore';

/** Structural stand-in for `MarketplaceRef` — `core/` does not import stores. */
interface NamedMarketplace {
  name: string;
}

/**
 * Whether the user authored this plugin themselves.
 *
 * "Mine" means: it came from a market the user runs, and the package itself
 * lives on their disk rather than having been fetched from someone else's
 * repo. Abu's own bundled market and org-managed installs are excluded — the
 * user did not write those, even though the packages are local.
 *
 * Records written before `sourceKind` existed fall back to `sha`: every remote
 * install pins a verified sha, and a relative one never has one, so "no sha"
 * is a sound reading of "installed from a local directory" for legacy data.
 *
 * Order matters: `sourceKind` records how the bytes were copied in, not where
 * they came from. Enterprise installs stage a verified artifact on disk and so
 * record `'relative'` like a hand-written plugin does, which is why the
 * enterprise check runs before `sourceKind` is consulted at all.
 */
export function isSelfAuthoredPlugin(
  p: Pick<InstalledPlugin, 'marketplace' | 'sourceKind' | 'sha'>,
): boolean {
  if (p.marketplace === BUILTIN_MARKET_NAME) return false;
  if (isEnterpriseInstall(p)) return false;
  return p.sourceKind ? p.sourceKind === 'relative' : p.sha == null;
}

/**
 * Installs whose marketplace is no longer in `marketplaces`.
 *
 * The package still works — it was copied into the plugin dir at install time
 * — but nothing can update or reinstall it, so the UI needs to say so rather
 * than silently showing it as healthy.
 *
 * The enterprise and built-in markets are exempt: neither can be removed by
 * the user, so neither can produce a genuine orphan. Enterprise's catalog is
 * managed elsewhere and deliberately absent from the user's market list. The
 * built-in market is absent for a different reason — it is stripped by the
 * store's `partialize` and re-injected asynchronously after hydration, so
 * measuring against the list would flag every built-in install on cold start.
 *
 * Beyond those two, this is only as accurate as the list it is handed: it
 * cannot tell "the user has no markets" from "markets have not loaded yet",
 * so the caller must ask only once the marketplace list has hydrated.
 */
export function orphanedInstalls(
  installed: InstalledPlugin[],
  marketplaces: NamedMarketplace[],
): InstalledPlugin[] {
  const known = new Set(marketplaces.map((m) => m.name));
  return installed.filter(
    (p) =>
      !isEnterpriseInstall(p) &&
      p.marketplace !== BUILTIN_MARKET_NAME &&
      !known.has(p.marketplace),
  );
}
