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

import { readDir, readFile, writeFile, mkdir, remove, lstat } from '@tauri-apps/plugin-fs';
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
 * A package whose own root directory is a symlink.
 *
 * Kept here rather than reusing `installer.ts`'s `PluginSecurityError` because
 * `installer` imports this module; the dependency only goes one way.
 */
export class PluginSymlinkRootError extends Error {
  constructor(dir: string) {
    super(`Refusing a plugin package whose own directory is a symlink: ${dir}`);
    this.name = 'PluginSymlinkRootError';
  }
}

/**
 * Throw unless `dir` is a real directory rather than a link to one.
 *
 * Every walk below starts with `readDir(dir)`, which resolves the final
 * component in the privileged host (`readdirSync`), so a linked root
 * enumerates the TARGET: files from outside the package get copied in and
 * `skippedSymlinks` comes back empty — no disclosure at all. Only the root
 * itself can catch that, because from the entries' side it is invisible.
 *
 * `lstat` is the one fs call routed with `followFinalSymlink: false`
 * (`electron/fsHost.cjs`, `plugin:fs|lstat`), which is exactly what this needs.
 */
async function assertRealPackageRoot(dir: string): Promise<void> {
  if ((await lstat(dir)).isSymlink) throw new PluginSymlinkRootError(dir);
}

/** One owned entry directly under a package directory. */
export interface PackageEntry {
  name: string;
  isDirectory: boolean;
}

/**
 * A read-only view of a package tree that sees exactly what the copy will
 * bring in: a denylisted name or a symlink does not exist.
 *
 * Every pre-consent scan goes through this. `exists`, `readDir` and
 * `readTextFile` all resolve symlinks in the privileged host, so a scan built
 * on them describes a link's TARGET while {@link copyPluginDir} skips the
 * link — the disclosure the user approves would then not match what lands.
 */
export interface PackageScan {
  /** The owned entry at `relativePath`, or undefined if the copy would skip it. */
  find(relativePath: string): Promise<PackageEntry | undefined>;
  /** Owned entries directly under `relativePath` (`''` = the package root). */
  children(relativePath: string): Promise<PackageEntry[]>;
}

/**
 * Open a {@link PackageScan} over `rootDir`.
 *
 * Listings are read once and memoised, so a whole disclosure — the three
 * manifest candidates, `skills`, and `commands`/`agents`/`hooks` — costs a
 * single `readDir` of the package root plus one per dot-dir actually visited.
 * That is fewer round-trips than the `exists` chain it replaces.
 *
 * A directory is only listed after the parent listing proved it is an owned
 * directory, so the only call that can fail on a missing path is the root's —
 * which is the one that should fail.
 */
export function scanPluginPackage(rootDir: string): PackageScan {
  const listings = new Map<string, Promise<Map<string, PackageEntry>>>();

  function listOwned(relativeDir: string): Promise<Map<string, PackageEntry>> {
    const cached = listings.get(relativeDir);
    if (cached) return cached;
    const pending = (async () => {
      const absolute = relativeDir ? joinPath(rootDir, relativeDir) : rootDir;
      const owned = new Map<string, PackageEntry>();
      for (const entry of await readDir(absolute)) {
        if (PLUGIN_COPY_DENYLIST.has(entry.name)) continue;
        if (entry.isSymlink) continue;
        owned.set(entry.name, { name: entry.name, isDirectory: entry.isDirectory });
      }
      return owned;
    })();
    listings.set(relativeDir, pending);
    return pending;
  }

  async function find(relativePath: string): Promise<PackageEntry | undefined> {
    const segments = relativePath.split('/').filter((s) => s !== '');
    if (segments.length === 0) return undefined;
    let parent = '';
    for (const [index, segment] of segments.entries()) {
      const entry = (await listOwned(parent)).get(segment);
      // Every segment has to be owned, not just the last one: a real
      // `.claude-plugin/` holding a linked `plugin.json` is still reading a
      // file the package does not own, and so is a linked `.claude-plugin/`.
      if (!entry) return undefined;
      if (index === segments.length - 1) return entry;
      if (!entry.isDirectory) return undefined;
      parent = parent ? `${parent}/${segment}` : segment;
    }
    return undefined;
  }

  async function children(relativePath: string): Promise<PackageEntry[]> {
    if (relativePath !== '') {
      const entry = await find(relativePath);
      if (!entry?.isDirectory) return [];
    }
    return [...(await listOwned(relativePath)).values()];
  }

  return { find, children };
}

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
): Promise<CopyPluginDirResult> {
  await assertRealPackageRoot(srcDir);
  return copyOwnedTree(srcDir, destDir, '');
}

async function copyOwnedTree(
  srcDir: string,
  destDir: string,
  relativePrefix: string,
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
      const nested = await copyOwnedTree(srcPath, destPath, relative);
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
export async function collectPluginSymlinks(srcDir: string): Promise<string[]> {
  await assertRealPackageRoot(srcDir);
  return (await collectOwnedTreeSymlinks(srcDir, '')).sort();
}

async function collectOwnedTreeSymlinks(
  srcDir: string,
  relativePrefix: string,
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
      found.push(...(await collectOwnedTreeSymlinks(joinPath(srcDir, entry.name), relative)));
    }
  }

  return found;
}

/** Remove an installed plugin's directory. */
export async function removePluginDir(dir: string): Promise<void> {
  await remove(dir, { recursive: true });
}
