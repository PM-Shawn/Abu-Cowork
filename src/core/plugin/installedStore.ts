import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import { installedManifestPath , pluginInstallDir } from './paths';

export interface InstalledPlugin {
  key: string;
  marketplace: string;
  name: string;
  version: string;
  sha?: string;
  checksum?: string;
  installedAt: string;
  /**
   * How the package was obtained — mirrors `PluginSource['kind']`.
   *
   * Optional because records written before this field existed must still
   * load; consumers that need "was this authored locally?" fall back to the
   * absence of `sha` for those (see `authored.ts`).
   */
  sourceKind?: 'relative' | 'url' | 'git-subdir';
  /**
   * What this plugin contributed to the app (skill ids, MCP server names).
   * Uninstall correctness is derived from this record — never by rescanning
   * directories and guessing what belonged to the plugin.
   */
  contributed: { skills: string[]; mcpServers: string[] };
}

/**
 * Read the installed-plugins manifest for `home`.
 *
 * Degrades to `[]` (never throws) both when the file is missing and when its
 * contents are not valid JSON — a single corrupted manifest must not lock up
 * the whole plugin system.
 */
export async function readInstalled(home: string): Promise<InstalledPlugin[]> {
  const path = installedManifestPath(home);

  let fileExists: boolean;
  try {
    fileExists = await exists(path);
  } catch {
    return [];
  }
  if (!fileExists) return [];

  let raw: string;
  try {
    raw = await readTextFile(path);
  } catch {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isInstalledPlugin).map(withValidSourceKind);
  } catch {
    return [];
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Validate one record before anyone builds a path or a policy decision on it.
 *
 * `installed.json` is not a trusted document — it is hand-editable, synced
 * between machines, and truncatable by a crash — and every consumer sits on
 * the skill-loading path, where `loader.ts` has no guard. One malformed record
 * must not be able to take every skill down with it.
 *
 * This got sharper once `pluginInstallDir` began rejecting unsafe segments: a
 * record carrying a traversal now *throws* instead of quietly yielding a bad
 * path, so a bad record becomes a fatal one unless it is dropped right here.
 * Dropping (rather than repairing) is deliberate: a record we cannot vouch for
 * should not contribute skills or, more importantly, MCP servers.
 */
function isInstalledPlugin(value: unknown): value is InstalledPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  if (!isNonEmptyString(p.key)) return false;
  if (!isNonEmptyString(p.marketplace)) return false;
  if (!isNonEmptyString(p.name)) return false;
  if (!isNonEmptyString(p.version)) return false;

  const contributed = p.contributed as Record<string, unknown> | undefined;
  if (typeof contributed !== 'object' || contributed === null) return false;
  if (!isStringArray(contributed.skills)) return false;
  if (!isStringArray(contributed.mcpServers)) return false;

  // The segments must also survive path construction. Doing it here keeps the
  // throw contained to this one record instead of the whole read.
  try {
    pluginInstallDir('/', p.marketplace, p.name, p.version);
  } catch {
    return false;
  }
  return true;
}

/**
 * Drop a `sourceKind` that is not one of the known kinds, keeping the record.
 *
 * Unlike the identity fields above, this one is advisory: it only feeds the
 * "did I author this?" split in the UI, so a nonsense value is not worth
 * discarding an otherwise-valid install over. Dropping the field puts the
 * record back on the legacy fallback path instead of letting an unvalidated
 * string leak out typed as the union. The copy is shallow so any *other*
 * unknown key still round-trips untouched.
 */
function withValidSourceKind(p: InstalledPlugin): InstalledPlugin {
  // Typed as the union by the interface, but it came straight out of JSON and
  // nothing has checked it yet — widen before comparing.
  const raw = p.sourceKind as unknown;
  if (raw === undefined) return p;
  if (raw === 'relative' || raw === 'url' || raw === 'git-subdir') return p;
  const copy = { ...p };
  delete copy.sourceKind;
  return copy;
}

async function writeInstalled(home: string, plugins: InstalledPlugin[]): Promise<void> {
  const path = installedManifestPath(home);
  await writeTextFile(path, JSON.stringify(plugins, null, 2));
}

/** Insert `p`, or replace the existing entry with the same key. */
export async function upsertInstalled(home: string, p: InstalledPlugin): Promise<void> {
  const plugins = await readInstalled(home);
  const idx = plugins.findIndex((x) => x.key === p.key);
  if (idx >= 0) {
    plugins[idx] = p;
  } else {
    plugins.push(p);
  }
  await writeInstalled(home, plugins);
}

/** Remove the entry with `key`. No-op (no throw, no write) if it isn't present. */
export async function removeInstalled(home: string, key: string): Promise<void> {
  const plugins = await readInstalled(home);
  const next = plugins.filter((x) => x.key !== key);
  if (next.length === plugins.length) return;
  await writeInstalled(home, next);
}

/** Find the entry with `key`, or `null` if not installed. */
export async function findInstalled(home: string, key: string): Promise<InstalledPlugin | null> {
  const plugins = await readInstalled(home);
  return plugins.find((x) => x.key === key) ?? null;
}
