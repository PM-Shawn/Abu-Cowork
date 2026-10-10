import { invoke } from '@tauri-apps/api/core';
import { joinPath, normalizeSeparators } from '@/utils/pathUtils';
import { usePluginStore, type MarketplaceRef } from '@/stores/pluginStore';

/**
 * Markets added by address (docs/app-spec.md, 「添加市场」). The main process
 * fetches the address into `~/.abu/markets/<name>/` (`electron/marketSourceHost.cjs`);
 * from then on the market is a folder like any other, and the plugin store
 * keeps it in the same list.
 */

/** Why adding a market failed, as far as the user can do something about it. */
export type MarketAddFailure = 'auth_required' | 'not_a_market' | 'name_taken';

/** An address (fetched by the main process) rather than a folder on this computer. */
export function isMarketAddress(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

/** The code the main process put in front of its message (`[auth_required] …`), if any. */
export function marketAddFailure(error: unknown): MarketAddFailure | undefined {
  const match = /\[(auth_required|not_a_market|name_taken)\]/.exec(error instanceof Error ? error.message : String(error));
  return match ? (match[1] as MarketAddFailure) : undefined;
}

export function marketsRoot(home: string): string {
  return joinPath(home, '.abu', 'markets');
}

/** Was this market added by address (its copy lives under `~/.abu/markets/`)? */
export function isFetchedMarket(market: MarketplaceRef, home: string): boolean {
  const root = `${normalizeSeparators(marketsRoot(home))}/`;
  return normalizeSeparators(market.dir).startsWith(root);
}

/** Fetch `address` and return the market it provides. */
export async function fetchMarket(address: string): Promise<{ name: string; dir: string }> {
  return invoke<{ name: string; dir: string }>('market_source_add', { address: address.trim() });
}

/**
 * Fetch every market added by address again when its copy is an hour old.
 * A market that cannot be reached keeps showing its last copy; the failure is
 * written to the log.
 */
export async function refreshFetchedMarkets(home: string): Promise<void> {
  for (const market of usePluginStore.getState().marketplaces) {
    if (market.builtin || !isFetchedMarket(market, home)) continue;
    await invoke('market_source_refresh', { name: market.name }).catch((error: unknown) => {
      console.warn(`[market] ${market.name} could not be fetched again; its last copy stays in use.`, error);
    });
  }
}

/** Remove a market from the list, and its fetched copy when it was added by address. */
export async function removeMarket(name: string, home: string): Promise<void> {
  const market = usePluginStore.getState().marketplaces.find((item) => item.name === name);
  usePluginStore.getState().removeMarketplace(name);
  if (market && isFetchedMarket(market, home)) await invoke('market_source_remove', { name });
}
