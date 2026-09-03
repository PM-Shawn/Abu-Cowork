/**
 * Install an agent from a local folder.
 *
 * Validates that the folder contains an AGENT.md with a valid `name` frontmatter field,
 * then recursively copies the entire directory to ~/.abu/agents/{name}/.
 */

import { readTextFile, readDir, readFile, writeFile, mkdir, exists, remove, rename, lstat } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { parse as parseYaml } from 'yaml';
import { joinPath } from '@/utils/pathUtils';
// The rule is about turning a stranger's frontmatter string into ONE directory
// name under `~/.abu/<kind>/`, which is exactly what this route does too — so
// it is imported rather than re-derived, and a hardening of the predicate
// reaches every route at once. It lives under `skill/` only because the three
// skill routes needed it first; the name is the one thing about it that is
// skill-specific.
import { isSafeSkillDirName } from '@/core/skill/skillDirName';

export type InstallResult =
  | {
      ok: true;
      name: string;
      fileCount: number;
      /** Top-level dot-entry names left out of the copy. */
      skipped: string[];
      /**
       * Folder-relative paths of the symlinks the copy refused, sorted.
       *
       * A separate channel from {@link skipped} on purpose: that one is
       * rendered as "skipped N hidden file(s)", which would be a false
       * statement about a link, and it only ever carried top-level names while
       * the links that matter are nested. `ToolboxModal` already renders this
       * field when an installer supplies it.
       */
      skippedSymlinks: string[];
    }
  | {
      ok: false;
      code: 'NO_AGENT_MD' | 'NO_NAME' | 'ALREADY_EXISTS' | 'COPY_FAILED' | 'SYMLINK_ROOT';
      message: string;
    };

/**
 * Install an agent by copying a folder to ~/.abu/agents/{name}/.
 *
 * @param folderPath - Absolute path to the source folder (must contain AGENT.md)
 * @param options    - overwrite: replace existing agent directory
 */
export async function installAgentFromFolder(
  folderPath: string,
  options?: { overwrite?: boolean },
): Promise<InstallResult> {
  // 0. The folder handed to us must be a real directory, not a link to one.
  //    Every call below — `exists`, `readTextFile`, `readDir` — resolves the
  //    final path component in the privileged host (electron/fsHost.cjs), so a
  //    linked folder is read straight THROUGH: the agent's name, its files and
  //    its refused-links report would all come from a directory the caller
  //    never named, and nothing anywhere would say so. Only the root itself can
  //    catch that — from the entries' side it is invisible. A caller who meant
  //    the target can name the target.
  if (await isSymlinkPath(folderPath)) {
    // Never rendered: ToolboxModal branches on this code and supplies its own
    // localized text (the folder path is the user's to begin with).
    return { ok: false, code: 'SYMLINK_ROOT', message: `Refusing an agent folder that is itself a symlink: ${folderPath}` };
  }

  // 1. Check the folder has an AGENT.md — one it OWNS.
  //
  //    `exists` and `readTextFile` both resolve the final component in the
  //    privileged host, so a LINKED AGENT.md is read straight through and the
  //    agent's identity — its name, and therefore the directory it installs
  //    over — comes from a file the folder does not own. `copyDirectory` then
  //    (rightly) refuses to copy that same link, so gate and copy would be
  //    running two different rules: `ok: true` for a directory with no AGENT.md
  //    in it. The sole caller always passes `overwrite: true`, so that
  //    unloadable directory would have replaced a working agent, under a name
  //    from a manifest the folder does not own, and the toast would have said
  //    the upload succeeded.
  //
  //    A link is therefore ABSENT here, exactly as a linked SKILL.md is absent
  //    to `installSkillFromFolder` and a linked `plugin.json` to
  //    `scanPluginPackage` (src/core/plugin/fsOps.ts).
  const agentMdPath = joinPath(folderPath, 'AGENT.md');
  const agentMdIsLink = await isSymlinkPath(agentMdPath);
  if (agentMdIsLink || !(await exists(agentMdPath))) {
    return {
      ok: false,
      code: 'NO_AGENT_MD',
      message: agentMdIsLink
        ? 'Folder does not contain an AGENT.md of its own: AGENT.md is a symlink. Copy the file into the folder instead of linking it.'
        : 'Folder does not contain AGENT.md',
    };
  }

  // 2. Parse name from frontmatter
  const raw = await readTextFile(agentMdPath);
  const name = extractName(raw);
  if (!name) {
    return { ok: false, code: 'NO_NAME', message: 'AGENT.md is missing a valid "name" field in frontmatter' };
  }
  // BEFORE step 3 computes a path and step 5 removes one. `joinPath` does not
  // collapse `..` and the host's guard only asks whether the RESOLVED path
  // lands under an allowed root, `$HOME` among them — so `name:
  // ../../Documents/important` makes `stagingDir` resolve to
  // `~/Documents/important`, and the first thing step 5 does to the staging
  // directory is `remove(..., { recursive: true })`. That destroys the
  // directory before the install has to succeed at anything, and the failing
  // rename then sends the catch block to remove it a second time, so neither
  // the original nor the staged copy survives.
  if (!isSafeSkillDirName(name)) {
    return { ok: false, code: 'NO_NAME', message: `AGENT.md declares a name that is not a single directory segment: "${name}"` };
  }

  // 3. Determine target directory
  const home = await homeDir();
  const targetDir = joinPath(home, '.abu', 'agents', name);

  // 4. Conflict check
  if (!options?.overwrite && (await exists(targetDir))) {
    return { ok: false, code: 'ALREADY_EXISTS', message: `Agent "${name}" already exists` };
  }

  // 5. Atomic copy via a staging dir outside ~/.abu/agents, then swap into place.
  //    A failure never leaves a partial target (which would falsely report
  //    "already exists" on retry). On overwrite, the existing target is moved
  //    aside and restored if the swap fails, so a rename error never leaves the
  //    user with neither the old nor the new agent. Dotfiles are skipped (see copyDirectory).
  const stagingDir = joinPath(home, '.abu', 'agent-staging', name);
  const backupDir = joinPath(home, '.abu', 'agent-staging', `__backup__${name}`);
  const skipped: string[] = [];
  const links: string[] = [];
  try {
    if (await exists(stagingDir)) {
      await remove(stagingDir, { recursive: true });
    }
    const fileCount = await copyDirectory(folderPath, stagingDir, skipped, links);

    await mkdir(joinPath(home, '.abu', 'agents'), { recursive: true });

    const hadExisting = await exists(targetDir);
    if (hadExisting) {
      if (await exists(backupDir)) await remove(backupDir, { recursive: true });
      await rename(targetDir, backupDir);
    }
    try {
      await rename(stagingDir, targetDir);
    } catch (swapErr) {
      if (hadExisting) {
        try { await rename(backupDir, targetDir); } catch { /* best-effort restore */ }
      }
      throw swapErr;
    }
    if (hadExisting) {
      try { await remove(backupDir, { recursive: true }); } catch { /* best-effort */ }
    }

    return { ok: true, name, fileCount, skipped, skippedSymlinks: links.sort() };
  } catch (err) {
    try {
      await remove(stagingDir, { recursive: true });
    } catch {
      /* best-effort cleanup — staging may not exist yet */
    }
    return { ok: false, code: 'COPY_FAILED', message: String(err) };
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Is `p` itself a symlink?
 *
 * `lstat` is the one fs call routed with `followFinalSymlink: false`
 * (`electron/fsHost.cjs`, `plugin:fs|lstat`), which is exactly what this
 * question needs — every other call would resolve the very thing being asked
 * about.
 *
 * A path that cannot be lstat'd is not a link we can prove, and answering
 * `false` here lets nothing through: a missing folder or manifest falls to the
 * NO_AGENT_MD check moments later, and an unreadable one fails the read.
 */
async function isSymlinkPath(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isSymlink;
  } catch {
    return false;
  }
}

/** Extract agent name from AGENT.md YAML frontmatter */
function extractName(content: string): string | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    const meta = parseYaml(match[1]) as Record<string, unknown>;
    const name = meta.name;
    return typeof name === 'string' && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Recursively copy a directory, returning total file count.
 *
 * Dotfiles / dotdirs (`.DS_Store`, `.mcp.json`, `.claude`, `.git`, …) are skipped:
 * the Tauri fs scope (`$HOME/**`) cannot read a path segment starting with `.`
 * (require_literal_leading_dot), so copying them throws "forbidden path" and would
 * abort the whole install. Only TOP-LEVEL skipped names are collected (an empty
 * `relativePrefix`) so nested basenames like `.DS_Store` aren't duplicated in the
 * caller's message.
 *
 * **Only a real directory is descended and only a regular file is copied.**
 * Everything else is left out, and every symlink among them is reported in
 * `links` by its folder-relative path. Whoever wrote this tree is not
 * necessarily the person installing it — the folder is typically one the user
 * just downloaded — so a link in it is an instruction to read something the
 * package does not own. Following them went wrong twice over:
 *
 *   - a link to a DIRECTORY killed the install with
 *     `EISDIR: illegal operation on a directory, read` — a dirent for such a
 *     link reports `isDirectory: false` / `isSymlink: true`, so it fell into
 *     the file branch and `readFile` followed it onto a directory.
 *   - worse, a link to a FILE did not crash. `readFile` followed it and the
 *     TARGET's bytes were written as a real file inside the installed agent,
 *     so `data/x -> ~/.ssh/id_rsa` materialised the key under
 *     `~/.abu/agents/<name>/`. The install reported `ok: true` and said
 *     nothing.
 *
 * Skipping fixes both, and re-creating the link would reintroduce the second:
 * whoever reads the installed agent later would still be pointed out of it.
 * (Same rule, same reasoning as `copyDirectory` in `src/core/skill/installer.ts`
 * and `copyPluginDir` in `src/core/plugin/fsOps.ts`.)
 *
 * The final branch is `isFile`, not a bare `else`, because a link is not the
 * only non-regular shape a dirent can take. A FIFO reports
 * `isDirectory:false / isFile:false / isSymlink:false` — the one combination
 * an `isSymlink` test does not catch — and `readFile` on a writer-less pipe
 * lands on `fs.readFileSync` inside `ipcMain.handle('tauri:invoke')`, i.e. on
 * the MAIN process event loop, where it never returns: every window and the
 * tray freeze until the user force-quits. macOS's stock tar round-trips a
 * FIFO, so an extracted bundle can carry one. Such entries are dropped without
 * a report: unlike a link they carry no content the package could have meant
 * to ship, and `skippedSymlinks` must not be made to lie about what they were.
 */
async function copyDirectory(
  srcDir: string,
  destDir: string,
  skipped: string[],
  links: string[],
  relativePrefix = '',
): Promise<number> {
  await mkdir(destDir, { recursive: true });
  let count = 0;

  const entries = await readDir(srcDir);
  for (const entry of entries) {
    // Dot-first, deliberately: a dot entry is left out whatever it is, so a
    // dot-named link is already excluded and `skipped` already covers it.
    if (entry.name.startsWith('.')) {
      if (relativePrefix === '') skipped.push(entry.name);
      continue;
    }

    const relative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

    // BEFORE the isDirectory branch: a link to a directory reports
    // `isDirectory: false`, so testing it afterwards would be testing nothing.
    if (entry.isSymlink) {
      links.push(relative);
      continue;
    }

    const srcPath = joinPath(srcDir, entry.name);
    const destPath = joinPath(destDir, entry.name);

    if (entry.isDirectory) {
      count += await copyDirectory(srcPath, destPath, skipped, links, relative);
    } else if (entry.isFile) {
      const bytes = await readFile(srcPath);
      await writeFile(destPath, new Uint8Array(bytes));
      count++;
    }
  }

  return count;
}
