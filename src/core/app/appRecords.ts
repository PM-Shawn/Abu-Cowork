import { exists, readTextFile, remove, rename } from '@tauri-apps/plugin-fs';
import type { AddedAppOrigin, AppDefinition, ParsedAppFile } from '@/types/app';
import { APP_FILE_PATH, parseAppFile } from '../../../electron/shared/appSpec.mjs';
import { atomicWrite } from '@/utils/atomicFs';
import { joinPath } from '@/utils/pathUtils';
import { copyPluginDir } from '@/core/plugin/fsOps';

/**
 * Apps the user added on this computer (docs/app-spec.md): one record per app
 * in `~/.abu/apps/added.json`, and the app's own files — `.abu-app/app.json`
 * and its images — copied to `~/.abu/apps/<appId>/` when it was added. The
 * copy is what runs: the market or folder it came from can change or go away
 * without changing an app the user already has.
 *
 * Organization apps are not recorded here; they arrive with every sync and
 * live only in memory (`useAppStore.managedApps`).
 */
export interface AddedAppRecord {
  appId: string;
  name: string;
  version: string;
  origin: AddedAppOrigin;
  addedAt: string;
}

export function appsRoot(home: string): string {
  return joinPath(home, '.abu', 'apps');
}

export function addedAppsPath(home: string): string {
  return joinPath(appsRoot(home), 'added.json');
}

/**
 * An app's id, from its name and where it came from: `<name>@<market>` like a
 * plugin's key, `<name>@local` for a folder, `<name>@mine` for one made in
 * 「创建应用」. The same app added again from the same place gets the same id,
 * which is what makes adding it again a replacement.
 */
export function addedAppId(name: string, origin: AddedAppOrigin): string {
  if (origin.kind === 'market') return `${name}@${origin.market}`;
  return `${name}@${origin.kind === 'folder' ? 'local' : 'mine'}`;
}

/** The id doubles as a directory name, so it may not carry a separator, a control character or only dots. */
function assertSafeAppId(appId: string): string {
  // eslint-disable-next-line no-control-regex
  if (appId.length === 0 || /[/\\\u0000-\u001f\u007f-\u009f]/.test(appId) || /^\.+$/.test(appId) || appId.trim() !== appId) {
    throw new Error(`app id "${appId}" cannot name a directory`);
  }
  return appId;
}

export function appDir(home: string, appId: string): string {
  return joinPath(appsRoot(home), assertSafeAppId(appId));
}

function isOrigin(value: unknown): value is AddedAppOrigin {
  if (typeof value !== 'object' || value === null) return false;
  const origin = value as Record<string, unknown>;
  if (origin.kind === 'market') return typeof origin.market === 'string' && origin.market.length > 0;
  if (origin.kind === 'folder') return typeof origin.dir === 'string' && origin.dir.length > 0;
  if (origin.kind === 'created') return typeof origin.authoringId === 'string' && origin.authoringId.length > 0;
  return false;
}

function parseRecord(value: unknown, index: number): AddedAppRecord {
  const record = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null
    || typeof record.appId !== 'string' || typeof record.name !== 'string' || typeof record.version !== 'string'
    || typeof record.addedAt !== 'string' || !isOrigin(record.origin)
    || record.appId !== addedAppId(record.name, record.origin)) {
    throw new Error(`added.json: entry ${index} is not an app record`);
  }
  return { appId: record.appId, name: record.name, version: record.version, origin: record.origin, addedAt: record.addedAt };
}

/** Every added app, oldest first. A missing file is an empty list; a damaged one throws. */
export async function readAddedApps(home: string): Promise<AddedAppRecord[]> {
  const path = addedAppsPath(home);
  if (!(await exists(path))) return [];
  const parsed: unknown = JSON.parse(await readTextFile(path));
  if (!Array.isArray(parsed)) throw new Error('added.json is not a list');
  return parsed.map(parseRecord);
}

async function writeAddedApps(home: string, records: AddedAppRecord[]): Promise<void> {
  await atomicWrite(addedAppsPath(home), `${JSON.stringify(records, null, 2)}\n`);
}

/** Read and validate `.abu-app/app.json` inside `dir`. */
export async function readAppFile(dir: string, source: 'package' | 'created'): Promise<ParsedAppFile> {
  return parseAppFile(JSON.parse(await readTextFile(joinPath(dir, APP_FILE_PATH))), { source });
}

/**
 * Copy an app's files in and record it. The files land in a staging directory
 * first and replace the current copy by rename, so a failed copy leaves the
 * app the user already had untouched.
 */
export async function saveAddedApp(home: string, sourceDir: string, record: AddedAppRecord): Promise<void> {
  const target = appDir(home, record.appId);
  const staging = joinPath(appsRoot(home), '.staging', `${assertSafeAppId(record.appId)}-${Date.now().toString(36)}`);
  await copyPluginDir(sourceDir, staging);
  if (await exists(target)) await remove(target, { recursive: true });
  await rename(staging, target);
  const records = await readAddedApps(home);
  await writeAddedApps(home, [...records.filter((item) => item.appId !== record.appId), record]);
}

/** Forget an app and delete its copied files. Plugins, experts, teams and skills stay. */
export async function removeAddedApp(home: string, appId: string): Promise<void> {
  const records = await readAddedApps(home);
  if (!records.some((record) => record.appId === appId)) throw new Error(`app "${appId}" is not added`);
  await writeAddedApps(home, records.filter((record) => record.appId !== appId));
  const dir = appDir(home, appId);
  if (await exists(dir)) await remove(dir, { recursive: true });
}

/** The switcher's entry for an added app, read from its copied files. */
export async function loadAddedApp(home: string, record: AddedAppRecord): Promise<AppDefinition> {
  const dir = appDir(home, record.appId);
  const file = await readAppFile(dir, record.origin.kind === 'created' ? 'created' : 'package');
  const asset = (path: string | undefined) => (path ? joinPath(dir, path) : undefined);
  return {
    appId: record.appId,
    name: file.interface.displayName,
    description: file.interface.shortDescription,
    logo: asset(file.interface.logo),
    logoDark: asset(file.interface.logoDark),
    config: file.config,
    version: file.version,
    origin: record.origin,
    plugins: file.plugins,
  };
}

/**
 * Every added app, in the order they were added.
 *
 * One app's files decide one entry. An app whose copy no longer reads —
 * edited on disk, or written for a newer Abu — stays out of the switcher and
 * leaves every other app where it was; failing the whole read would empty the
 * switcher for all of them, on every launch. The failure is reported rather
 * than hidden.
 */
export async function loadAddedApps(home: string): Promise<AppDefinition[]> {
  const apps: AppDefinition[] = [];
  for (const record of await readAddedApps(home)) {
    try {
      apps.push(await loadAddedApp(home, record));
    } catch (error) {
      console.error(`[app] ${record.appId} is added, but its files could not be read; it stays out of the switcher.`, error);
    }
  }
  return apps;
}
