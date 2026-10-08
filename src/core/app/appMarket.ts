import type { ParsedAppFile } from '@/types/app';
import type { AppMarketEntry } from '@/core/plugin/marketplace';
import type { MarketplaceRef } from '@/stores/pluginStore';
import { loadMarketplaceFromDir } from '@/core/plugin/loadMarketplace';
import { resolveSourceDir } from '@/core/plugin/installer';
import { APP_VERSION } from '@/utils/version';
import { joinPath } from '@/utils/pathUtils';
import { appRuns, splitRunTarget } from '../../../electron/shared/appSpec.mjs';
import { checkMinAbuVersion } from '../../../electron/shared/pluginSpec.mjs';
import { addedAppId, readAppFile } from './appRecords';
import { resolveTarget, targetDisplayName, type RefCatalog } from './appRefs';

/**
 * What the app market lists (docs/app-spec.md): every app of every market
 * the user has, the official one included. An app whose files sit in the
 * market directory is read from its own `app.json` (name, description,
 * version, images, who it hands work to); a remote one shows what its market
 * entry states, and is read in full only when the user adds it.
 */
export interface AppListing {
  market: MarketplaceRef;
  entry: AppMarketEntry;
  /** The id it has once added from this market. */
  appId: string;
  name: string;
  description?: string;
  version?: string;
  minAbuVersion?: string;
  logo?: string;
  logoDark?: string;
  /** Names of the teams, experts and skills the app hands work to. */
  uses: string[];
  /** This Abu is older than the app needs. */
  needsUpgrade: boolean;
  /** The app's own files do not read; the listing says so instead of offering 「使用」. */
  invalid?: string;
}

export interface AppMarketListing {
  listings: AppListing[];
  /** Markets whose `marketplace.json` could not be read, with the reason. */
  failures: Array<{ market: MarketplaceRef; message: string }>;
}

/** The names an app hands work to, as the user knows them. */
export function appUses(file: ParsedAppFile, market: string | undefined, catalog: RefCatalog): string[] {
  const names = new Set<string>();
  const app = { appId: '', name: file.name, config: file.config, version: file.version, origin: market ? { kind: 'market' as const, market } : null, plugins: file.plugins };
  for (const { run } of appRuns(file.config)) {
    for (const kind of ['team', 'expert', 'skill'] as const) {
      const value = (run as Record<string, string | undefined>)[kind];
      if (value === undefined) continue;
      const target = resolveTarget(app, kind, value, catalog);
      names.add(target.status === 'ok' ? targetDisplayName(target) : splitRunTarget(kind, value)?.id ?? value);
    }
  }
  return [...names];
}

/** A `minAbuVersion` this Abu does not meet (the market parser already refused one that is not a version). */
function needsUpgrade(minAbuVersion: string | undefined): boolean {
  return minAbuVersion !== undefined && !checkMinAbuVersion({ minAbuVersion }, APP_VERSION).ok;
}

async function listing(market: MarketplaceRef, entry: AppMarketEntry, catalog: RefCatalog): Promise<AppListing> {
  const appId = addedAppId(entry.name, { kind: 'market', market: market.name });
  const base: AppListing = {
    market, entry, appId, name: entry.name, description: entry.description, version: entry.version,
    minAbuVersion: entry.minAbuVersion, uses: [], needsUpgrade: needsUpgrade(entry.minAbuVersion),
  };
  if (entry.source.kind !== 'relative') return base;
  const dir = resolveSourceDir(entry.source, market.dir);
  let file: ParsedAppFile;
  try {
    file = await readAppFile(dir, 'package');
  } catch (error) {
    return { ...base, invalid: error instanceof Error ? error.message : String(error) };
  }
  const asset = (path: string | undefined) => (path ? joinPath(dir, path) : undefined);
  return {
    ...base,
    name: file.interface.displayName,
    description: file.interface.shortDescription,
    version: file.version,
    minAbuVersion: file.minAbuVersion,
    logo: asset(file.interface.logo),
    logoDark: asset(file.interface.logoDark),
    uses: appUses(file, market.name, catalog),
    needsUpgrade: needsUpgrade(file.minAbuVersion),
  };
}

/** Every app of every market in `markets`, in market order. One unreadable market does not hide the others. */
export async function loadAppListings(markets: MarketplaceRef[], catalog: RefCatalog): Promise<AppMarketListing> {
  const listings: AppListing[] = [];
  const failures: AppMarketListing['failures'] = [];
  for (const market of markets) {
    let entries: AppMarketEntry[];
    try {
      entries = (await loadMarketplaceFromDir(market.dir)).apps;
    } catch (error) {
      failures.push({ market, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const entry of entries) listings.push(await listing(market, entry, catalog));
  }
  return { listings, failures };
}
