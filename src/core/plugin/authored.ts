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
 * InstalledPlugin records are produced by marketplace installation. Neither a
 * relative package path nor a missing commit SHA is evidence of local authorship.
 * There is currently no authoring record in this model, so none of these records
 * belongs in the authored group. A future authoring flow must supply its own
 * explicit provenance rather than infer it from the download mechanism.
 */
export function isSelfAuthoredPlugin(
  _plugin: Pick<InstalledPlugin, 'marketplace' | 'sourceKind' | 'sha'>,
): boolean {
  return false;
}

/** Authored installs live under a marketplace named for their author record. */
export const AUTHORED_MARKET_PREFIX = 'author-';

/**
 * "The user made this here." Unlike `isSelfAuthoredPlugin` above — which
 * predates the authoring flow and is no longer wired to anything — this reads
 * provenance the installer wrote onto the record, so it stays true even when
 * the author store cannot be read. Anything deriving ownership must use this
 * one; deriving it from a join against the author list makes a transient read
 * failure look like a change of provenance.
 */
export function isAuthoredInstall(
  plugin: Pick<InstalledPlugin, 'marketplace' | 'authoringId'>,
): boolean {
  return plugin.authoringId !== undefined || plugin.marketplace.startsWith(AUTHORED_MARKET_PREFIX);
}

/**
 * Installs whose marketplace is no longer in `marketplaces`.
 *
 * The package still works — it was copied into the plugin dir at install time
 * — but nothing can update or reinstall it, so the UI needs to say so rather
 * than silently showing it as healthy.
 *
 * The enterprise, built-in and authoring markets are exempt: none can be
 * removed by the user, so none can produce a genuine orphan. An authored
 * plugin's marketplace is synthesised from its author record and never appears
 * in the user's market list, so measuring it against that list would report
 * every locally created plugin as coming from a market that is gone. Enterprise's catalog is
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
      !isAuthoredInstall(p) &&
      p.marketplace !== BUILTIN_MARKET_NAME &&
      !known.has(p.marketplace),
  );
}
