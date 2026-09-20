import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import type { AppDefinition, AppLocale } from '@/types/app';
import { GENERAL_APP_ID } from '@/types/app';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import type { PluginActivations } from '@/core/plugin/activationPolicy';
import { MANIFEST_CANDIDATES, parsePluginManifest } from '@/core/plugin/manifest';
import { parseAppConfig, resolveLocalizedText } from '../../../electron/shared/pluginAppSpec.mjs';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import { joinPath } from '@/utils/pathUtils';
import zhCN from '@/i18n/locales/zh-CN';
import enUS from '@/i18n/locales/en-US';

/**
 * Where the switcher's apps come from.
 *
 * Installed apps are read from the plugin records the way plugin teams are:
 * only enabled plugins, only the manifest inside the installed package, and
 * the `app` field re-validated against the components the install record
 * credits the plugin with — so a package edited after approval cannot point
 * a scene at something the user never saw. An enterprise build can add a
 * second source (`registerAppSource`) for organization-managed apps.
 */
const dictionaries = { 'zh-CN': zhCN, 'en-US': enUS } as const;

/** The general shell as an app: first in every list, never persisted, no plugin behind it. */
export function generalApp(locale: AppLocale): AppDefinition {
  return {
    appId: GENERAL_APP_ID,
    name: dictionaries[locale].appSwitcher.general,
    description: dictionaries[locale].appSwitcher.generalDescription,
    config: DEFAULT_APP_CONFIG,
    pluginKey: null,
    pluginVersion: null,
  };
}

export interface PackageFiles {
  exists: (path: string) => Promise<boolean>;
  readText: (path: string) => Promise<string>;
}

/**
 * Connector names `requiredConnectors` may name: the ones the install record
 * credits the plugin with, plus the ones its manifest declares inline.
 *
 * The record is deliberately narrower — it lists only the servers the install
 * actually created, so uninstalling never deletes a server of the user's that
 * happened to share a name. A package whose connector was skipped for that
 * reason is still the package the user approved, and its app must still open;
 * the only thing `requiredConnectors` decides is the "connect this first" hint
 * on the home page, which is why the wider list is safe here while teams,
 * experts and skills — who actually run the conversation — stay pinned to the
 * record.
 */
function declaredConnectorNames(plugin: InstalledPlugin, manifest: { mcpServers?: unknown }): string[] {
  const declared = manifest.mcpServers;
  const inline = typeof declared === 'object' && declared !== null && !Array.isArray(declared) ? Object.keys(declared) : [];
  return [...new Set([...plugin.contributed.mcpServers, ...inline])];
}

const diskFiles: PackageFiles = { exists: (path) => exists(path), readText: (path) => readTextFile(path) };

export async function readInstalledApp(
  plugin: InstalledPlugin,
  root: string,
  files: PackageFiles = diskFiles,
): Promise<AppDefinition | null> {
  let raw: string | null = null;
  for (const candidate of MANIFEST_CANDIDATES) {
    const path = joinPath(root, candidate);
    if (!(await files.exists(path))) continue;
    raw = await files.readText(path);
    break;
  }
  if (raw === null) return null;
  const manifest = parsePluginManifest(JSON.parse(raw));
  if (manifest.app === undefined) return null;
  const config = parseAppConfig(manifest.app, {
    teamIds: plugin.contributed.teams,
    agentNames: plugin.contributed.agents,
    skillNames: plugin.contributed.skills,
    mcpServerNames: declaredConnectorNames(plugin, manifest),
  });
  const iface = manifest.interface ?? {};
  const asset = (path: string | undefined) => (path ? joinPath(root, path) : undefined);
  return {
    appId: plugin.key,
    name: iface.displayName ?? plugin.name,
    description: iface.shortDescription,
    logo: asset(iface.logo),
    logoDark: asset(iface.logoDark),
    config,
    pluginKey: plugin.key,
    pluginVersion: plugin.version,
  };
}

/**
 * Every enabled installed plugin whose manifest carries `app`, in
 * install-record order.
 *
 * One package's files decide one entry. A manifest that no longer validates —
 * edited on disk, or naming a component this installation does not have — keeps
 * its own app out of the switcher and leaves every other app where it was;
 * rejecting the whole read would empty the switcher for all of them, on every
 * refresh and every launch. The failure is reported rather than hidden.
 */
export async function loadInstalledApps(
  installed: InstalledPlugin[],
  activations: PluginActivations,
  files: PackageFiles = diskFiles,
): Promise<AppDefinition[]> {
  const apps: AppDefinition[] = [];
  for (const plugin of installed) {
    const activation = activations[plugin.key];
    if (!activation || !activation.enabled || activation.conflicted) continue;
    try {
      const app = await readInstalledApp(plugin, activation.root, files);
      if (app) apps.push(app);
    } catch (error) {
      console.error(`[app] ${plugin.key} is installed, but its app configuration could not be read; it stays out of the switcher.`, error);
    }
  }
  return apps;
}

type AppSource = () => AppDefinition[];
const extraSources: AppSource[] = [];

/** Enterprise mount point: apps the organization provides outside the plugin records. */
export function registerAppSource(source: AppSource): () => void {
  extraSources.push(source);
  return () => {
    const index = extraSources.indexOf(source);
    if (index >= 0) extraSources.splice(index, 1);
  };
}

/** The general shell, then installed apps, then whatever registered sources add. */
export function listApps(installedApps: AppDefinition[], locale: AppLocale): AppDefinition[] {
  return [generalApp(locale), ...installedApps, ...extraSources.flatMap((source) => source())];
}

export function getApp(apps: AppDefinition[], appId: string): AppDefinition | undefined {
  return apps.find((app) => app.appId === appId);
}

/** The app's display title for the home header: `home.header.title`, else its name. */
export function appHomeTitle(app: AppDefinition, locale: AppLocale): string {
  const title = app.config.home.header?.title;
  return title === undefined ? app.name : resolveLocalizedText(title, locale);
}
