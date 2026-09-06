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
 * from that. It is also the only thing that can tell a plugin's agent from a
 * user's own agent of the same name — the plugin never installed over one, so
 * uninstall must never delete one.
 */

import { readInstalledForWrite, removeInstalled } from './installedStore';
import { removeContributedAgent } from './agentPayload';
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
  // 🔴 Read through the WRITE path: an unreadable manifest throws here, before
  // the package directory is removed. Reading it the lenient way would report
  // "not installed" for a manifest we simply could not parse — and, worse,
  // `removeInstalled` would then be asked to rewrite a file whose contents we
  // never saw. Nothing is deleted until the record is genuinely known.
  const record = (await readInstalledForWrite(opts.home)).find((p) => p.key === opts.key) ?? null;
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

  // Agents are the one contribution that lives OUTSIDE the package directory
  // (~/.abu/agents/<name>), so removing the directory above does not withdraw
  // them. Only after that removal succeeded: while the record still lists this
  // plugin, its agents are still its own.
  //
  // `removeContributedAgent` answers rather than throws, and every answer other
  // than `removed` is tolerated: `not-found` is a user who deleted the agent by
  // hand, and `symlink` / `unsafe-name` / `error` are refusals to delete
  // something this plugin did not write. None of them may strand the install
  // record — that would leave the plugin listed with its package already gone,
  // which is the state this module's ordering exists to prevent. This mirrors
  // the skills, which are withdrawn by the directory removal above and have no
  // per-item failure channel either.
  for (const name of record.contributed.agents ?? []) {
    await removeContributedAgent(name);
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
