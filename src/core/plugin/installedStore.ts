import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import { installedManifestPath } from './paths';

export interface InstalledPlugin {
  key: string;
  marketplace: string;
  name: string;
  version: string;
  sha?: string;
  checksum?: string;
  installedAt: string;
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
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as InstalledPlugin[]) : [];
  } catch {
    return [];
  }
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
