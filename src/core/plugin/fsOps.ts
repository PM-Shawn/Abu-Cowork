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

/** Recursively copy a plugin package. Returns the number of files written. */
export async function copyPluginDir(srcDir: string, destDir: string): Promise<number> {
  await mkdir(destDir, { recursive: true });
  let count = 0;

  for (const entry of await readDir(srcDir)) {
    if (PLUGIN_COPY_DENYLIST.has(entry.name)) continue;

    const srcPath = joinPath(srcDir, entry.name);
    const destPath = joinPath(destDir, entry.name);

    if (entry.isDirectory) {
      count += await copyPluginDir(srcPath, destPath);
    } else {
      const bytes = await readFile(srcPath);
      await writeFile(destPath, new Uint8Array(bytes));
      count++;
    }
  }

  return count;
}

/** Remove an installed plugin's directory. */
export async function removePluginDir(dir: string): Promise<void> {
  await remove(dir, { recursive: true });
}
