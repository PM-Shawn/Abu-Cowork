/**
 * Install a skill from a local folder.
 *
 * Validates that the folder contains a SKILL.md with a valid `name` frontmatter field,
 * then recursively copies the entire directory to ~/.abu/skills/{name}/.
 */

import { readTextFile, readDir, readFile, writeFile, mkdir, exists, lstat } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { parse as parseYaml } from 'yaml';
import { joinPath } from '@/utils/pathUtils';
import { atomicInstallDir } from '@/core/fsAtomic';
import { skillPolicyDenial } from './skillPolicy';
import { isSafeSkillDirName } from './skillDirName';

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
       * rendered as "skipped N hidden file(s)" (`toolbox.importSkippedFiles`,
       * `toolResult.skill.skippedNote`), which would be a false statement
       * about a link. The two are also different facts — a hidden file is
       * Abu's own convention, a link is the source tree pointing out of
       * itself — and the user needs to be told the second one.
       */
      skippedSymlinks: string[];
    }
  | {
      ok: false;
      code: 'NO_SKILL_MD' | 'NO_NAME' | 'ALREADY_EXISTS' | 'COPY_FAILED' | 'SYMLINK_ROOT';
      message: string;
    }
  | {
      ok: false;
      code: 'POLICY_DENIED';
      message: string;
      /** The name the organization's policy blocks, for the caller's localized text. */
      skillName: string;
    };

/**
 * Install a skill by copying a folder to ~/.abu/skills/{name}/.
 *
 * @param folderPath - Absolute path to the source folder (must contain SKILL.md)
 * @param options    - overwrite: replace existing skill directory
 */
export async function installSkillFromFolder(
  folderPath: string,
  options?: { overwrite?: boolean },
): Promise<InstallResult> {
  // 0. The folder handed to us must be a real directory, not a link to one.
  //    Every call below — `exists`, `readTextFile`, `readDir` — resolves the
  //    final path component in the privileged host (electron/fsHost.cjs), so a
  //    linked folder is read straight THROUGH: the skill's name, its files and
  //    its skipped-links report would all come from a directory the caller
  //    never named, and nothing anywhere would say so. Only the root itself can
  //    catch that — from the entries' side it is invisible. A caller who meant
  //    the target can name the target.
  if ((await lstatKind(folderPath)) === 'symlink') {
    // Never rendered: every caller branches on this code and supplies its own
    // localized text (the folder path is theirs to begin with).
    return { ok: false, code: 'SYMLINK_ROOT', message: `Refusing a skill folder that is itself a symlink: ${folderPath}` };
  }

  // 1. Check the folder has a SKILL.md — one it OWNS.
  //
  //    Every segment has to be owned, not just the root. `exists` and
  //    `readTextFile` both resolve the final component in the privileged host,
  //    so a LINKED SKILL.md is read straight through and the skill's identity
  //    — its name, and therefore the directory it installs over — comes from a
  //    file the folder does not own. `copyDirectory` then (rightly) refuses to
  //    copy that same link, so gate and copy would be running two different
  //    rules: the install reported `ok: true` for a directory with no SKILL.md
  //    in it, which `loader.ts` never loads. On the overwrite paths — the
  //    confirm dialog in SkillUploadModal, and `skill_manage` with
  //    `overwrite: true` — that unloadable directory replaced a working skill,
  //    named by a manifest the folder does not own, and the toast said the
  //    upload succeeded.
  //
  //    A link is therefore ABSENT here, exactly as a linked `plugin.json` is
  //    absent to `scanPluginPackage` (src/core/plugin/fsOps.ts). The folder is
  //    already proven real above, so lstat on this basename asks precisely the
  //    right question — and it answers the whole ownership question at once,
  //    which a link test alone does not: a SKILL.md that is a FIFO freezes the
  //    privileged host's event loop inside `readTextFile` (see `copyDirectory`).
  //
  //    ⚠️ Time-of-check: this is one syscall's answer about one moment. A
  //    writer racing inside the source folder can swap the manifest for a link
  //    after this lstat and before the read below, which no userland walk
  //    without `openat`/`O_NOFOLLOW` can prevent. The invariant "the gate that
  //    reads the manifest and the copy that writes files apply one rule" holds
  //    for a tree that does not change under the walk — which is the stated
  //    threat model (a hostile package, hostile frontmatter), not a hostile
  //    process already running as the user.
  const skillMdPath = joinPath(folderPath, 'SKILL.md');
  const missingManifest = await manifestAbsenceReason(skillMdPath);
  if (missingManifest) {
    return { ok: false, code: 'NO_SKILL_MD', message: missingManifest };
  }

  // 2. Parse name from frontmatter
  const raw = await readTextFile(skillMdPath);
  const name = extractName(raw);
  if (!name) {
    return { ok: false, code: 'NO_NAME', message: 'SKILL.md is missing a valid "name" field in frontmatter' };
  }
  if (!isSafeSkillDirName(name)) {
    return { ok: false, code: 'NO_NAME', message: `SKILL.md declares a name that is not a single directory segment: "${name}"` };
  }

  // 3a. Policy check: deny if skill name is blacklisted
  const policyReason = skillPolicyDenial(name);
  if (policyReason) {
    return { ok: false, code: 'POLICY_DENIED', message: `[policy] ${policyReason}`, skillName: name };
  }

  // 3. Determine target directory
  const home = await homeDir();
  const targetDir = joinPath(home, '.abu', 'skills', name);

  // 4. Conflict check
  if (!options?.overwrite && (await exists(targetDir))) {
    return { ok: false, code: 'ALREADY_EXISTS', message: `Skill "${name}" already exists` };
  }

  // 5. Atomic copy: build the skill in a staging dir first, then swap it into place.
  //    Staging lives OUTSIDE ~/.abu/skills so a half-copied dir is never scanned as a
  //    skill, and a failure never leaves a partial target that would falsely report
  //    "already exists" on the next attempt. On overwrite, the existing target is
  //    moved aside (not deleted) and restored if the swap fails, so a rename error
  //    never leaves the user with neither the old nor the new skill.
  //    (Shared with the agent/plugin installers via atomicInstallDir — see src/core/fsAtomic.ts.)
  const skipped: string[] = [];
  const links: string[] = [];
  let fileCount = 0;
  try {
    await atomicInstallDir({
      targetDir,
      workDir: joinPath(home, '.abu', 'skill-staging'),
      write: async (stagingDir) => {
        fileCount = await copyDirectory(folderPath, stagingDir, skipped, links);
      },
    });

    return { ok: true, name, fileCount, skipped, skippedSymlinks: links.sort() };
  } catch (err) {
    return { ok: false, code: 'COPY_FAILED', message: String(err) };
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * What `p` itself is, without resolving it.
 *
 * `lstat` is the one fs call routed with `followFinalSymlink: false`
 * (`electron/fsHost.cjs`, `plugin:fs|lstat`), which is exactly what an
 * ownership question needs — every other call would resolve the very thing
 * being asked about.
 *
 * `'unknown'` for a path that cannot be lstat'd at all. That answer lets
 * nothing through: a missing folder or manifest falls to the NO_SKILL_MD check
 * moments later, and an unreadable one still fails the read.
 */
async function lstatKind(p: string): Promise<'file' | 'directory' | 'symlink' | 'other' | 'unknown'> {
  try {
    const info = await lstat(p);
    if (info.isSymlink) return 'symlink';
    if (info.isDirectory) return 'directory';
    return info.isFile ? 'file' : 'other';
  } catch {
    return 'unknown';
  }
}

/**
 * Why the folder has no SKILL.md of its own, or `null` if it has one.
 *
 * The manifest decides the skill's identity — its name, and therefore the
 * directory it installs over — so it has to be a REGULAR FILE the folder owns.
 * Everything else is absent:
 *
 *   - a **link** is read straight through by `readTextFile` (the host resolves
 *     the final component), so the identity would come from a file the folder
 *     does not own, while `copyDirectory` rightly refuses to copy that same
 *     link — gate and copy running two different rules;
 *   - a **FIFO** is worse than wrong: `readTextFile` lands on
 *     `fs.readFileSync` inside `ipcMain.handle('tauri:invoke')`, i.e. on the
 *     MAIN process event loop, where a writer-less pipe never returns and every
 *     window and the tray freeze until the user force-quits;
 *   - a **directory** named SKILL.md fails the read with EISDIR.
 *
 * The messages are developer-facing English, like the rest of this module's:
 * every caller either branches on the code or renders `message` as-is.
 */
async function manifestAbsenceReason(skillMdPath: string): Promise<string | null> {
  switch (await lstatKind(skillMdPath)) {
    case 'file':
      return null;
    case 'symlink':
      return 'Folder does not contain a SKILL.md of its own: SKILL.md is a symlink. Copy the file into the folder instead of linking it.';
    case 'unknown':
      // Not lstat-able. Absent if it is really not there; otherwise leave it to
      // the read, which fails loudly rather than silently reporting "no
      // SKILL.md" for a file that exists but cannot be examined.
      return (await exists(skillMdPath)) ? null : 'Folder does not contain SKILL.md';
    default:
      return 'Folder does not contain a SKILL.md of its own: SKILL.md is not a regular file. Copy a real SKILL.md into the folder.';
  }
}

/** Extract skill name from SKILL.md YAML frontmatter */
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
 * (require_literal_leading_dot), so attempting to copy them throws "forbidden path"
 * and would abort the whole install. Only TOP-LEVEL skipped names are collected
 * (an empty `relativePrefix`) so the caller can tell the user what was left out
 * (e.g. an `.mcp.json` with secrets) without duplicating nested basenames like
 * `.DS_Store`.
 *
 * **A symlink is never followed and never recreated**, and every one is
 * reported in `links` by its folder-relative path. Whoever wrote this tree is
 * not necessarily the person installing it — the model picks the path on the
 * `skill_manage` route — so a link in it is an instruction to read something
 * the skill does not own. Following them went wrong twice over:
 *
 *   - a link to a DIRECTORY killed the install with
 *     `EISDIR: illegal operation on a directory, read` — a dirent for such a
 *     link reports `isDirectory: false` / `isSymlink: true`, so it fell into
 *     the file branch and `readFile` followed it onto a directory. Real
 *     packages ship these: `canva` carries `.cursor/skills -> ../skills`.
 *   - worse, a link to a FILE did not crash. `readFile` followed it and the
 *     TARGET's bytes were written as a real file inside the installed skill,
 *     so `data/x -> ~/.ssh/id_rsa` materialised the key under
 *     `~/.abu/skills/<name>/`, which `skill_view` will happily read back.
 *
 * Skipping fixes both, and re-creating the link would reintroduce the second:
 * whoever reads the installed skill later would still be pointed out of it.
 * (Same rule, same reasoning as `copyPluginDir` — see `src/core/plugin/fsOps.ts`.)
 *
 * The final branch is `isFile`, not a bare `else`, because a link is not the
 * only non-regular shape a dirent can take. A FIFO reports
 * `isDirectory:false / isFile:false / isSymlink:false` — the one combination an
 * `isSymlink` test does not catch — and `readFile` on a writer-less pipe lands
 * on `fs.readFileSync` inside `ipcMain.handle('tauri:invoke')`, i.e. on the
 * MAIN process event loop, where it never returns: every window and the tray
 * freeze until the user force-quits. macOS's stock tar round-trips a FIFO, so
 * an extracted skill archive can carry one. Such entries are dropped without a
 * report: unlike a link they carry no content the package could have meant to
 * ship, and `skippedSymlinks` is rendered to the user as the links the copy
 * refused — it must not be made to say a pipe was one.
 *
 * What this does NOT catch is a HARD link, whose dirent is
 * `{isFile:true, isSymlink:false}` — indistinguishable from a real file at the
 * `readDir` surface, so its bytes are copied in like any other file's.
 * Detecting one needs `st_nlink`/`st_dev`, which the plugin-fs dirent surface
 * does not expose. Read "nothing from outside the folder" with that bound:
 * archives cannot carry a hard link (tar refuses absolute link targets, git
 * cannot store one), so it takes someone who can already run `ln` as this user
 * — who could read the target directly anyway.
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
    // dot-named link is already excluded and the report above already covers
    // it. Testing isSymlink first would only move it between two lists.
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
