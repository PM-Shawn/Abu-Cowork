/**
 * Turn a plugin package's `agents/` payload into Abu's own agent format.
 *
 * The Claude Code / Codex plugin ecosystem ships an agent as ONE markdown file
 * (`agents/<name>.md`: YAML frontmatter + the system prompt as the body), while
 * Abu stores an agent as a directory (`~/.abu/agents/<name>/AGENT.md`). This
 * module is the pure translation layer between the two, plus the one removal
 * primitive uninstall needs. Nothing here discovers or installs anything —
 * that is the installer's job.
 *
 * Two rules make a stranger's agent safe enough to register:
 *   - **allowlist**, not denylist: only the keys `parseAgentFile` actually
 *     reads survive, so ecosystem-only keys (`color`, `permissionMode`, …)
 *     cannot smuggle behaviour into a file Abu will later parse;
 *   - **`memory` and `source` are dropped**, declared or not. `memory` has no runtime
 *     consumer today (it is pure metadata), so a package's `memory: user`
 *     would only colour a detail panel; a converted agent is written without
 *     the key and is treated exactly like an agent that never declared one
 *     (spec §4, Ruling 2026-09-06). `source` is provenance and belongs to the
 *     host: only `renderAgentMd`'s `pluginKey` option can write one (spec §1).
 * `tools` / `disallowed-tools` pass through: every tool call still goes through
 * Abu's permission gate and approvals, so declaring them only narrows the
 * default set (spec §4).
 */

import { remove, lstat } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { joinPath } from '@/utils/pathUtils';
import { isSafeSkillDirName } from '@/core/skill/skillDirName';

export { AGENT_FRONTMATTER_ALLOWLIST, convertSingleFileAgent, renderAgentMd, type ConvertedAgent } from '../../../electron/shared/pluginAgentFormat.mjs';

export type RemoveContributedAgentResult = {
  removed: boolean;
  reason?: 'not-found' | 'symlink' | 'unsafe-name' | 'error';
};

/**
 * Delete `~/.abu/agents/<name>` — the directory a plugin install contributed.
 *
 * Three gates before anything is removed, because the argument comes out of an
 * install record that is hand-editable JSON on disk:
 *
 *   - **`isSafeSkillDirName`** — the same single-segment predicate the agent
 *     installer applies before it *creates* this directory. `joinPath` does not
 *     collapse `..` and the privileged host only asks whether the RESOLVED path
 *     is under an allowed root (`$HOME` among them), so `../../Documents` would
 *     resolve to a real directory and be removed recursively. Removal must
 *     apply exactly the rule creation applied.
 *   - **`lstat`, not `exists`** — `lstat` is the one fs call routed with
 *     `followFinalSymlink: false` (electron/fsHost.cjs), which is the only way
 *     to ask what the path ITSELF is. Every other call resolves it.
 *   - **a real directory** — a link is refused rather than followed (removing
 *     it would be removing something the plugin never installed, and following
 *     it would delete the target's contents); anything else is reported absent,
 *     which is what it is as far as a contributed agent goes.
 */
export async function removeContributedAgent(name: string): Promise<RemoveContributedAgentResult> {
  if (!isSafeSkillDirName(name)) return { removed: false, reason: 'unsafe-name' };

  try {
    const home = await homeDir();
    // The expression `installAgentFromFolder` builds its target with, so both
    // sides of install/uninstall name the same directory by construction.
    const dir = joinPath(home, '.abu', 'agents', name);

    let info: { isSymlink: boolean; isDirectory: boolean };
    try {
      info = await lstat(dir);
    } catch {
      // Not lstat-able — absent for our purposes; there is nothing to withdraw.
      return { removed: false, reason: 'not-found' };
    }
    if (info.isSymlink) return { removed: false, reason: 'symlink' };
    if (!info.isDirectory) return { removed: false, reason: 'not-found' };

    await remove(dir, { recursive: true });
    return { removed: true };
  } catch {
    return { removed: false, reason: 'error' };
  }
}
