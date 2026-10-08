import type { AddedAppOrigin, AppDefinition, ParsedAppFile } from '@/types/app';
import type { AppMarketEntry, MarketplaceEntry, PluginSource } from '@/core/plugin/marketplace';
import { loadMarketplaceFromDir } from '@/core/plugin/loadMarketplace';
import { planInstall, releasePreparedInstall, resolveSourceDir, type InstallDisclosure } from '@/core/plugin/installer';
import { fetchRemotePluginSource } from '@/core/plugin/remoteFetch';
import { pluginConfigFields, savePluginConfiguration } from '@/core/plugin/configuration';
import { BUILTIN_MARKET_NAME } from '@/core/plugin/builtinMarket';
import { pluginRoot } from '@/core/plugin/paths';
import { cleanupPluginConfiguration, usePluginStore, type MarketplaceRef } from '@/stores/pluginStore';
import { useAppStore } from '@/stores/appStore';
import { APP_VERSION } from '@/utils/version';
import { joinPath } from '@/utils/pathUtils';
import { format, getI18n } from '@/i18n';
import { appRuns, splitRunTarget } from '../../../electron/shared/appSpec.mjs';
import { PluginManifestError } from '../../../electron/shared/pluginManifestError.mjs';
import { checkMinAbuVersion } from '../../../electron/shared/pluginSpec.mjs';
import { addedAppId, readAppFile, saveAddedApp } from './appRecords';
import { liveRefCatalog, resolveAppRefs, type RefCatalog } from './appRefs';
import { refreshAddedApps } from './appSync';

/**
 * Adding and updating an app (docs/app-spec.md, 「使用」 and 「更新」 in the app
 * market, 「从文件夹添加」).
 *
 * `planAddApp` reads the app, checks it, and works out which plugins have to
 * come with it: the ones its references need that are not installed, and the
 * installed ones whose version does not bring what it references. Each of
 * those is planned with the plugin installer's own disclosure, so the
 * confirmation page shows exactly what the plugin install dialog would. Nothing
 * is written until `confirmAddApp`.
 */

/** Where the app comes from. */
export type AppAddSource =
  | { kind: 'market'; market: MarketplaceRef; entry: AppMarketEntry }
  | { kind: 'folder'; dir: string };

/** One plugin that has to be installed or updated for the app to work. */
export interface AppPluginStep {
  kind: 'install' | 'update';
  marketplace: MarketplaceRef;
  entry: MarketplaceEntry;
  disclosure: InstallDisclosure;
  /** The installed key an update replaces. */
  existingKey?: string;
}

export interface AppAddPlan {
  appId: string;
  origin: AddedAppOrigin;
  /** The app's own files, as read (a market directory, a fetched copy, or the folder). */
  sourceDir: string;
  file: ParsedAppFile;
  /** The app as the switcher and the home would show it once added. */
  app: AppDefinition;
  steps: AppPluginStep[];
  /** Web sites the app opens inside Abu (its `allowedOrigins`). */
  sites: string[];
  /** An app with this id is already added: confirming replaces it. */
  replacing: boolean;
}

/** A refusal the user reads as it is: the add stops and nothing is written. */
export class AppAddError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppAddError';
  }
}

function i18n() {
  return getI18n().appMarket;
}

/** Where a remote app is fetched before the user confirms: inside the plugin root, which is the only root the fetcher writes to. */
function remoteAppStagingDir(home: string, market: string, name: string, sha: string): string {
  return joinPath(pluginRoot(home), market, `app-${name}`, '_remote', sha);
}

async function appDirFor(source: AppAddSource, home: string): Promise<string> {
  if (source.kind === 'folder') return source.dir;
  const entrySource: PluginSource = source.entry.source;
  if (entrySource.kind === 'relative') return resolveSourceDir(entrySource, source.market.dir);
  if (!entrySource.sha) throw new AppAddError(format(i18n().remoteNeedsSha, { name: source.entry.name }));
  const fetched = await fetchRemotePluginSource(entrySource, remoteAppStagingDir(home, source.market.name, source.entry.name, entrySource.sha));
  return fetched.destDir;
}

/** The app as it will appear once added, with its images read from `dir`. */
function definitionFor(file: ParsedAppFile, appId: string, origin: AddedAppOrigin, dir: string): AppDefinition {
  const asset = (path: string | undefined) => (path ? joinPath(dir, path) : undefined);
  return {
    appId,
    name: file.interface.displayName,
    description: file.interface.shortDescription,
    logo: asset(file.interface.logo),
    logoDark: asset(file.interface.logoDark),
    config: file.config,
    version: file.version,
    origin,
    plugins: file.plugins,
  };
}

/**
 * The markets to look a plugin up in, in order: the app's own market, then the
 * official market, then every other market the user added.
 */
function marketOrder(ownMarket: string | undefined): MarketplaceRef[] {
  const markets = usePluginStore.getState().marketplaces;
  const rank = (market: MarketplaceRef) => (market.name === ownMarket ? 0 : market.name === BUILTIN_MARKET_NAME ? 1 : 2);
  return [...markets].sort((a, b) => rank(a) - rank(b));
}

async function findPluginEntry(name: string, ownMarket: string | undefined): Promise<{ marketplace: MarketplaceRef; entry: MarketplaceEntry } | undefined> {
  for (const marketplace of marketOrder(ownMarket)) {
    const listed = await loadMarketplaceFromDir(marketplace.dir);
    const entry = listed.plugins.find((item) => item.name === name);
    if (entry) return { marketplace, entry };
  }
  return undefined;
}

/**
 * After planning, check that each planned plugin really brings what the app
 * names from it — a market can list a version that still lacks it.
 */
function assertStepsCover(app: AppDefinition, steps: AppPluginStep[]): void {
  for (const { field, run } of appRuns(app.config)) {
    for (const kind of ['team', 'expert', 'skill'] as const) {
      const value = (run as Record<string, string | undefined>)[kind];
      if (value === undefined) continue;
      const target = splitRunTarget(kind, value);
      if (target?.origin !== 'plugin') continue;
      const step = steps.find((item) => item.entry.name === target.plugin);
      if (!step) continue;
      const d = step.disclosure;
      const brings = kind === 'team' ? (d.teams ?? []).some((team) => team.id === target.id)
        : kind === 'expert' ? d.agents.some((agent) => agent.name === target.id && !agent.conflict)
        : d.skills.includes(target.id);
      if (!brings) throw new PluginManifestError(`${field}.${kind}: ${format(i18n().pluginLacksReference, { plugin: target.plugin, name: target.id })}`, `${field}.${kind}`, 'unknown-reference');
    }
  }
}

/** Read, check and plan one app. Prepared plugin snapshots are released by `cancelAddApp` or `confirmAddApp`. */
export async function planAddApp(source: AppAddSource, home: string, catalog: RefCatalog = liveRefCatalog()): Promise<AppAddPlan> {
  const sourceDir = await appDirFor(source, home);
  const file = await readAppFile(sourceDir, 'package');
  if (source.kind === 'market') {
    if (file.name !== source.entry.name) throw new AppAddError(format(i18n().nameMismatch, { listed: source.entry.name, actual: file.name }));
    for (const key of ['version', 'minAbuVersion'] as const) {
      const listed = source.entry[key];
      if (listed !== undefined && listed !== file[key]) throw new AppAddError(format(i18n().entryMismatch, { name: file.name }));
    }
  }
  if (!checkMinAbuVersion(file, APP_VERSION).ok) throw new AppAddError(format(i18n().needsNewerAbu, { version: file.minAbuVersion }));

  const origin: AddedAppOrigin = source.kind === 'market' ? { kind: 'market', market: source.market.name } : { kind: 'folder', dir: source.dir };
  const appId = addedAppId(file.name, origin);
  const app = definitionFor(file, appId, origin, sourceDir);
  const steps = await planPluginSteps(app, home, catalog);
  return {
    appId,
    origin,
    sourceDir,
    file,
    app,
    steps,
    sites: file.config.allowedOrigins ?? [],
    replacing: useAppStore.getState().addedApps.some((item) => item.appId === appId),
  };
}

/**
 * The plugins `app` needs installed or updated for its references to resolve,
 * each planned with the plugin installer's own disclosure. Used when adding
 * an app, and when a scene is started after one of its plugins was removed.
 */
export async function planPluginSteps(app: AppDefinition, home: string, catalog: RefCatalog = liveRefCatalog()): Promise<AppPluginStep[]> {
  const report = resolveAppRefs(app, catalog);
  const ownMarket = app.origin?.kind === 'market' ? app.origin.market : undefined;
  const steps: AppPluginStep[] = [];
  try {
    for (const name of [...report.missingPlugins, ...report.outdatedPlugins]) {
      const found = await findPluginEntry(name, ownMarket);
      if (!found) throw new AppAddError(format(i18n().pluginNotFound, { plugin: name }));
      const updating = report.outdatedPlugins.includes(name);
      // An update replaces the copy installed from the market that lists the
      // newer version; a market listing the version already installed has
      // nothing newer to offer.
      const existing = updating ? usePluginStore.getState().installed.find((plugin) => plugin.name === name && plugin.marketplace === found.marketplace.name) : undefined;
      if (updating && (!existing || existing.version === found.entry.version)) throw new AppAddError(format(i18n().pluginTooOld, { plugin: name }));
      const disclosure = await planInstall({
        prepareSnapshot: true,
        marketplaceName: found.marketplace.name,
        marketplaceDir: found.marketplace.dir,
        entry: found.entry,
        home,
        fetchRemote: fetchRemotePluginSource,
      });
      steps.push({ kind: updating ? 'update' : 'install', marketplace: found.marketplace, entry: found.entry, disclosure, existingKey: existing?.key });
    }
    assertStepsCover(app, steps);
  } catch (error) {
    await releaseSteps(steps);
    throw error;
  }
  return steps;
}

async function releaseSteps(steps: AppPluginStep[]): Promise<void> {
  for (const step of steps) {
    if (step.disclosure.preparedToken) await releasePreparedInstall(step.disclosure.preparedToken);
  }
}

/** Does the plan need the user to look at anything before it runs? */
export function needsConfirmation(plan: AppAddPlan): boolean {
  return plan.steps.length > 0 || plan.sites.length > 0;
}

/** The user cancelled: nothing was written, and the prepared plugin snapshots go. */
export async function cancelPluginSteps(steps: AppPluginStep[]): Promise<void> {
  await releaseSteps(steps);
}

/**
 * Install or update the planned plugins in order. When one fails, the ones
 * this run installed are uninstalled again, so the result is what 「取消」
 * would have left; plugins it already updated keep their new version.
 * `configuration` holds the values each plugin's connectors asked for, by
 * plugin key.
 */
export async function runPluginSteps(steps: AppPluginStep[], home: string, configuration: Record<string, Record<string, string>>): Promise<void> {
  const installedNow: string[] = [];
  const store = usePluginStore.getState();
  try {
    for (const step of steps) {
      const { disclosure, marketplace, entry } = step;
      let pluginConfiguration: string | undefined;
      try {
        pluginConfiguration = await savePluginConfiguration(disclosure.key, pluginConfigFields(disclosure.manifest.mcpServers), configuration[disclosure.key] ?? {});
        const request = { preparedToken: disclosure.preparedToken, pluginConfiguration, enableMcp: true, home, marketplaceName: marketplace.name, marketplaceDir: marketplace.dir, entry };
        if (step.kind === 'update' && step.existingKey) await store.update({ ...request, key: step.existingKey });
        else {
          await store.install(request);
          installedNow.push(disclosure.key);
        }
      } finally {
        await cleanupPluginConfiguration(pluginConfiguration);
      }
    }
  } catch (error) {
    for (const key of installedNow.reverse()) await store.uninstall(home, key);
    throw error;
  } finally {
    await releaseSteps(steps);
  }
}

/**
 * Bring in the planned plugins, then add the app and enter it (an update
 * keeps the user where they are). A plugin that fails stops everything before
 * the app is recorded.
 */
export async function confirmAddApp(plan: AppAddPlan, home: string, configuration: Record<string, Record<string, string>>): Promise<void> {
  await runPluginSteps(plan.steps, home, configuration);
  await saveAddedApp(home, plan.sourceDir, {
    appId: plan.appId,
    name: plan.file.name,
    version: plan.file.version,
    origin: plan.origin,
    addedAt: new Date().toISOString(),
  });
  await refreshAddedApps();
  if (!plan.replacing) useAppStore.getState().enterAppWhenAvailable(plan.appId);
}
