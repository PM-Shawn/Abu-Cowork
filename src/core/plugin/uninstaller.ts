/**
 * Plugin removal.
 *
 * Ordering matters: the package directory goes first, and the install record
 * is only rewritten once that succeeded. The reverse order would let a failed
 * delete leave the plugin invisible in the UI while its skills and MCP servers
 * were still live on disk — the worst of both states.
 *
 * What gets withdrawn comes from the record's `contributed` list, never from
 * re-scanning the directory: the list is what the user approved at install
 * time, and a package that grew new files afterwards must not gain anything
 * from that.
 */

import { findInstalled, removeInstalled } from './installedStore';
import { pluginInstallDir } from './paths';
import { getParentDir } from '../../utils/pathUtils';

export class PluginNotInstalledError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`Plugin is not installed: ${key}`);
    this.name = 'PluginNotInstalledError';
    this.key = key;
  }
}

export interface UninstallPluginOptions {
  home: string;
  /** Composite `${name}@${marketplace}` key. */
  key: string;
  removeDir: (dir: string) => Promise<void>;
  /**
   * Treat "directory already missing" as success. Lets a user clean up a
   * record whose folder they deleted by hand instead of being stuck with a
   * ghost entry.
   */
  tolerateMissingDir?: boolean;
}

export interface UninstallResult {
  key: string;
  /** What the caller should now deregister (skill roots, MCP servers). */
  withdrawn: { skills: string[]; mcpServers: string[] };
}

function isMissingDirError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT') return true;
  return /ENOENT|no such file/i.test(String((error as Error)?.message ?? ''));
}

export async function uninstallPlugin(opts: UninstallPluginOptions): Promise<UninstallResult> {
  const record = await findInstalled(opts.home, opts.key);
  if (!record) throw new PluginNotInstalledError(opts.key);

  // Remove the plugin's whole <market>/<name>/ dir, not just the <version>
  // subdir — otherwise an empty <name>/ (and any _remote staging) is left
  // behind, which reads as a ghost install on disk.
  const dir = getParentDir(pluginInstallDir(opts.home, record.marketplace, record.name, record.version));
  try {
    await opts.removeDir(dir);
  } catch (error) {
    if (!(opts.tolerateMissingDir && isMissingDirError(error))) throw error;
  }

  await removeInstalled(opts.home, opts.key);

  return {
    key: opts.key,
    withdrawn: {
      skills: [...record.contributed.skills],
      mcpServers: [...record.contributed.mcpServers],
    },
  };
}
