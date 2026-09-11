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
  /** The offending directory, so a UI can say so in the user's language. */
  readonly dir: string;

  constructor(dir: string) {
    super(`Refusing a plugin package whose own directory is a symlink: ${dir}`);
    this.name = 'PluginSymlinkRootError';
    this.dir = dir;
  }
}

/** The package directory does not exist. */
export class PluginPackageNotFoundError extends Error {
  readonly dir: string;

  constructor(dir: string) {
    super(`Plugin package directory not found: ${dir}`);
    this.name = 'PluginPackageNotFoundError';
    this.dir = dir;
  }
}

/**
 * The package directory exists but this process may not read it.
 *
 * Deliberately loud. The `exists`-based scan this replaced swallowed EACCES to
 * `false`, so an unreadable `.abu-plugin/` silently fell through to the next
 * manifest candidate — which is how a package gets installed under a manifest
 * it never nominated, with a disclosure describing the wrong identity. A
 * directory we cannot read is unknown, not absent, and the copy would fail on
 * it moments later anyway.
 */
export class PluginPackageUnreadableError extends Error {
  readonly dir: string;

  constructor(dir: string) {
    super(`Cannot read the plugin package directory — permission denied: ${dir}`);
    this.name = 'PluginPackageUnreadableError';
    this.dir = dir;
  }
}

/**
 * The errno of a failed fs call, if it can still be told.
 *
 * The privileged host re-throws as a plain `new Error(err.message)`
 * (`electron/tauriHost.cjs`), so `code` does not survive the IPC hop — node
 * leads the message with the errno (`ENOENT: no such file or directory,
 * lstat '<path>'`) and that is the only thing left to read on the shell we
 * ship. `code` is still checked first for the callers that keep it.
 */
function fsErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return /^([A-Z]+):/.exec(error instanceof Error ? error.message : '')?.[1];
}

/**
 * Turn a failed listing of `dir` into a domain error the install flow can
 * render, or hand the original back untouched.
 *
 * A syscall string in the install disclosure is a bug in its own right: the
 * user whose marketplace catalog points at a deleted folder is being asked to
 * debug `lstat`. Anything we cannot classify is rethrown as-is rather than
 * flattened into a wrong-but-friendly message.
 */
function packageDirError(dir: string, error: unknown): unknown {
  switch (fsErrorCode(error)) {
    case 'ENOENT':
      return new PluginPackageNotFoundError(dir);
    case 'EACCES':
    case 'EPERM':
      return new PluginPackageUnreadableError(dir);
    default:
      return error;
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
  const info = await lstat(dir).catch((error: unknown) => {
    throw packageDirError(dir, error);
  });
  if (info.isSymlink) throw new PluginSymlinkRootError(dir);
}

/** One directory read under the single ownership rule. */
interface OwnedListing {
  /** Entries the copy brings in: real directories and real files. */
  owned: PackageEntry[];
  /**
   * Names of entries skipped for being links. Denylisted names are absent from
   * both lists: they are not part of the package at all, so there is nothing to
   * disclose about them. So is a non-regular entry such as a FIFO — it carries
   * no content the package could have meant to ship, and this list is rendered
   * to the user as the LINKS the copy refused.
   */
  links: string[];
}

/**
 * THE rule: what a plugin package owns in one directory.
 *
 * Every walk in this module — the pre-consent scan, the copy, and the
 * read-only symlink collection — goes through here, so "denylisted, a link, or
 * not a real directory or file ⇒ absent" is defined once. Three hand-kept
 * copies of it is exactly how the disclosure and the install drift apart: a
 * fourth rule (a size cap, another skipped name) added to two of three re-opens
 * the disagreement silently.
 *
 * The non-regular test lives HERE rather than in the copy's file branch because
 * `scanPluginPackage` hands its entries to readers as well as to the copy:
 * `readManifestWith` (`installer.ts`) does `if (!(await scan.find(candidate)))
 * continue;` and then `readTextFile`s that path, so a `plugin.json` that is a
 * FIFO would freeze the privileged host's event loop before any copy started.
 * One rule, every consumer.
 */
async function listPackageDir(absoluteDir: string): Promise<OwnedListing> {
  const entries = await readDir(absoluteDir).catch((error: unknown) => {
    throw packageDirError(absoluteDir, error);
  });

  const owned: PackageEntry[] = [];
  const links: string[] = [];
  for (const entry of entries) {
    // Dirent names must stay a single segment when joinPath normalizes them.
    // A POSIX basename containing a literal backslash could otherwise become
    // a slash and traverse a different, unverified (possibly linked) ancestor.
    if (!entry.name || entry.name === '.' || entry.name === '..' || /[/\\]/.test(entry.name)) continue;
    if (PLUGIN_COPY_DENYLIST.has(entry.name)) continue;
    // BEFORE the isDirectory branch: a link to a directory reports
    // `isDirectory: false`, so testing it later would be testing nothing.
    if (entry.isSymlink) {
      links.push(entry.name);
      continue;
    }
    // A link is not the only non-regular shape a dirent can take. A FIFO
    // reports `isDirectory:false / isFile:false / isSymlink:false` — the one
    // combination the test above does not catch — and every read below lands on
    // a synchronous `readFileSync` inside `ipcMain.handle('tauri:invoke')`, i.e.
    // on the MAIN process event loop, where a writer-less pipe never returns:
    // every window and the tray freeze until the user force-quits. tar
    // round-trips a FIFO, so an extracted package can carry one. Absent from
    // `links` on purpose — a pipe is not a link, and that list is a statement
    // to the user about links.
    if (!entry.isDirectory && !entry.isFile) continue;
    owned.push({ name: entry.name, isDirectory: entry.isDirectory });
  }
  return { owned, links };
}

/** One owned entry, as the traversal hands it to a visitor. */
interface WalkedEntry {
  name: string;
  srcPath: string;
  /** Package-relative path, `/`-separated. */
  relative: string;
}

/**
 * What a caller does with the owned entries {@link walkOwnedTree} finds.
 *
 * `C` is whatever the caller has to thread down the tree — the copy carries
 * the matching destination directory, the collect carries nothing.
 */
interface OwnedTreeVisitor<C> {
  /** Called on entering an owned directory; returns the context for its children. */
  directory(entry: WalkedEntry, context: C): Promise<C>;
  file(entry: WalkedEntry, context: C): Promise<void>;
}

/**
 * The single recursive walk of a package tree, returning the package-relative
 * paths of every link it refused to descend into or copy.
 *
 * It never follows a link: a link's target is not this package. The copy and
 * the pre-consent collection are this walk with different visitors, which is
 * what makes "the disclosure and the install agree" structural rather than a
 * property of two functions being edited together.
 */
async function walkOwnedTree<C>(
  srcDir: string,
  relativePrefix: string,
  context: C,
  visit: OwnedTreeVisitor<C>,
): Promise<string[]> {
  const prefixed = (name: string) => (relativePrefix ? `${relativePrefix}/${name}` : name);
  const listing = await listPackageDir(srcDir);
  const skipped: string[] = listing.links.map(prefixed);

  for (const entry of listing.owned) {
    const walked: WalkedEntry = {
      name: entry.name,
      srcPath: joinPath(srcDir, entry.name),
      relative: prefixed(entry.name),
    };
    if (entry.isDirectory) {
      const childContext = await visit.directory(walked, context);
      skipped.push(...(await walkOwnedTree(walked.srcPath, walked.relative, childContext, visit)));
    } else {
      // A bare `else` is safe only because `listPackageDir` already dropped
      // everything that is neither a real directory nor a real file — do not
      // reintroduce the assumption that "not a directory" means "readable".
      await visit.file(walked, context);
    }
  }

  return skipped;
}

/**
 * One owned entry directly under a package directory.
 *
 * `isDirectory: false` means a REGULAR file — {@link listPackageDir} drops
 * links and every other non-regular entry — so a consumer may read it.
 */
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
    // Normalised once, here: `find` drops empty segments while this used to
    // key on the raw string, so `children('skills/')` both missed the cache
    // and asked the host to list `<root>/skills/`.
    const key = relativeDir.split('/').filter((s) => s !== '').join('/');
    const cached = listings.get(key);
    if (cached) return cached;
    const pending = (async () => {
      // The root listing is the only place this can live: `readDir` resolves
      // the final component in the privileged host, so a linked root
      // enumerates the target and every entry looks perfectly ordinary. Doing
      // it here rather than in the callers makes it hold for EVERY consumer of
      // a scan — `readManifestFrom` is a public export — instead of holding
      // because `planInstall` happens to call `collectPluginSymlinks` first.
      if (key === '') await assertRealPackageRoot(rootDir);
      const absolute = key ? joinPath(rootDir, key) : rootDir;
      const owned = new Map<string, PackageEntry>();
      for (const entry of (await listPackageDir(absolute)).owned) owned.set(entry.name, entry);
      return owned;
    })();
    listings.set(key, pending);
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
 *
 * Non-regular entries that are not links — a FIFO — are dropped by
 * {@link listPackageDir} before the walk sees them, and deliberately not
 * reported: see there for why reading one freezes the app, and why it does not
 * belong on a list the user reads as "links".
 *
 * What none of this catches is a HARD link, whose dirent is
 * `{isFile:true, isSymlink:false}` — indistinguishable from a real file at the
 * `readDir` surface, so its bytes are copied in like any other file's.
 * Detecting one needs `st_nlink`/`st_dev`, which the plugin-fs dirent surface
 * does not expose. Read "the package does not own it" with that bound:
 * archives cannot carry a hard link (tar refuses absolute link targets, git
 * cannot store one), so it takes someone who can already run `ln` as this user
 * — who could read the target directly anyway.
 */
export async function copyPluginDir(
  srcDir: string,
  destDir: string,
): Promise<CopyPluginDirResult> {
  await assertRealPackageRoot(srcDir);
  await mkdir(destDir, { recursive: true });

  let files = 0;
  // The context threaded down the walk is the destination directory that
  // mirrors the source directory currently being listed.
  const skippedSymlinks = await walkOwnedTree<string>(srcDir, '', destDir, {
    directory: async ({ name }, parentDest) => {
      const dest = joinPath(parentDest, name);
      await mkdir(dest, { recursive: true });
      return dest;
    },
    file: async ({ name, srcPath }, dest) => {
      const bytes = await readFile(srcPath);
      await writeFile(joinPath(dest, name), new Uint8Array(bytes));
      files++;
    },
  });

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
  // The same walk the copy does, with a visitor that writes nothing: the skip
  // list is the walk's own return value, so it cannot drift from the copy's.
  const skipped = await walkOwnedTree<undefined>(srcDir, '', undefined, {
    directory: async () => undefined,
    file: async () => {
      /* nothing to read: enumerating the tree is the whole job */
    },
  });
  return skipped.sort();
}

/** Remove an installed plugin's directory. */
export async function removePluginDir(dir: string): Promise<void> {
  await remove(dir, { recursive: true });
}
