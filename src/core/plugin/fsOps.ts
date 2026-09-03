/**
 * Filesystem operations for plugin packages.
 *
 * ## Why this is not `skill/installer.ts`'s `copyDirectory`
 *
 * That one skips **every** dot-entry, because under Tauri the fs scope glob
 * (`$HOME/**`) refuses path segments starting with `.`
 * (`require_literal_leading_dot`), so touching them aborted the install.
 *
 * A plugin package cannot survive that rule: its manifest *is* a dot-dir —
 * `.abu-plugin/plugin.json`, `.claude-plugin/plugin.json` or
 * `.codex-plugin/plugin.json`. Copying a plugin with the skill rule would
 * install a package with no manifest, and the failure would only show up at
 * runtime.
 *
 * The rule no longer applies on the shell we actually ship: Electron's
 * `assertAllowed` (electron/fsHost.cjs) is prefix-containment via
 * `isPathWithin`, not a glob, so dot segments are ordinary path segments.
 * Abu is Electron-only for new work, so plugins copy dot-dirs and skip only
 * what is genuinely unwanted.
 */

import { readDir, readFile, writeFile, mkdir, remove } from '@tauri-apps/plugin-fs';
import { joinPath } from '../../utils/pathUtils';

/**
 * Entries never copied into an installed plugin.
 *
 * `.git` would drag a whole object store in; `node_modules` is a package
 * manager's business, not ours; `.DS_Store` is noise. Everything else —
 * including `.abu-plugin` / `.claude-plugin` / `.codex-plugin` — is part of
 * the package.
 */
export const PLUGIN_COPY_DENYLIST: ReadonlySet<string> = new Set([
  '.git',
  '.DS_Store',
  'node_modules',
]);

/**
 * What a copy brought in, and what it deliberately left behind.
 *
 * The skipped links are part of the contract, not a debug aid: the user
 * approved a disclosure that lists them, so the caller has to be able to tell
 * that the package on disk is missing exactly those entries.
 */
export interface CopyPluginDirResult {
  /** Number of real files written. */
  files: number;
  /** Package-relative paths of the symlinks that were skipped, sorted. */
  skippedSymlinks: string[];
}

/**
 * Recursively copy a plugin package, **never following and never recreating a
 * symlink**.
 *
 * A third party writes this tree, so a link in it is an instruction to read
 * something the package does not own. Two things went wrong when we followed
 * them:
 *
 *   - a link to a DIRECTORY crashed the install with
 *     `EISDIR: illegal operation on a directory, read` — a dirent for such a
 *     link reports `isDirectory: false` / `isSymlink: true`, so it fell into
 *     the file branch and `readFile` followed it onto a directory. That is a
 *     real, shipped package: `canva` in Anthropic's official marketplace
 *     carries `.cursor/skills -> ../skills`.
 *   - worse, a link to a FILE did not crash. `readFile` followed it and the
 *     TARGET's bytes were written as a real file inside the installed
 *     package, so `data/x -> ~/.ssh/id_rsa` would materialise the key
 *     somewhere the package's own skills are allowed to read.
 *
 * Skipping fixes both, and re-creating the link would reintroduce the second:
 * whoever reads the installed tree later would still be pointed out of it.
 * Skips are reported rather than swallowed so the install disclosure can say
 * what will be missing before the user confirms.
 */
export async function copyPluginDir(
  srcDir: string,
  destDir: string,
  relativePrefix = '',
): Promise<CopyPluginDirResult> {
  await mkdir(destDir, { recursive: true });
  let files = 0;
  const skippedSymlinks: string[] = [];

  for (const entry of await readDir(srcDir)) {
    if (PLUGIN_COPY_DENYLIST.has(entry.name)) continue;

    const srcPath = joinPath(srcDir, entry.name);
    const destPath = joinPath(destDir, entry.name);
    const relative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

    // BEFORE the isDirectory branch: a link to a directory reports
    // `isDirectory: false`, so testing it later would be testing nothing.
    if (entry.isSymlink) {
      skippedSymlinks.push(relative);
      continue;
    }

    if (entry.isDirectory) {
      const nested = await copyPluginDir(srcPath, destPath, relative);
      files += nested.files;
      skippedSymlinks.push(...nested.skippedSymlinks);
    } else {
      const bytes = await readFile(srcPath);
      await writeFile(destPath, new Uint8Array(bytes));
      files++;
    }
  }

  return { files, skippedSymlinks: skippedSymlinks.sort() };
}

/**
 * Package-relative paths of every symlink in a source package, sorted.
 *
 * Read-only twin of {@link copyPluginDir}'s skip list, for the disclosure the
 * user reads *before* anything is written. It applies the same denylist, and
 * it does not descend through a link — a link's target is not this package.
 */
export async function collectPluginSymlinks(
  srcDir: string,
  relativePrefix = '',
): Promise<string[]> {
  const found: string[] = [];

  for (const entry of await readDir(srcDir)) {
    if (PLUGIN_COPY_DENYLIST.has(entry.name)) continue;
    const relative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

    if (entry.isSymlink) {
      found.push(relative);
      continue;
    }
    if (entry.isDirectory) {
      found.push(...(await collectPluginSymlinks(joinPath(srcDir, entry.name), relative)));
    }
  }

  return found.sort();
}

/** Remove an installed plugin's directory. */
export async function removePluginDir(dir: string): Promise<void> {
  await remove(dir, { recursive: true });
}
