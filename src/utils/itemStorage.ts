import { writeTextFile, mkdir, rename, exists } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { joinPath, getParentDir, getBaseName } from '@/utils/pathUtils';

/** `code` of the error {@link saveItemToAbuDir} throws when `mustBeNew` finds the file already there. */
export const ITEM_EXISTS_CODE = 'ITEM_EXISTS';
/** `code` of the error {@link saveItemToAbuDir} throws for a name that is not one plain folder name. */
export const ITEM_NAME_INVALID_CODE = 'ITEM_NAME_INVALID';

/**
 * Is `segment` one plain folder name — something `joinPath` cannot turn into
 * a different folder? Rejects empty/blank, leading or trailing whitespace,
 * `.`/`..`, either path separator, and control characters (NUL included).
 * Everything else — unicode names from the create_agent tool included — passes.
 */
function isPlainSegment(segment: string): boolean {
  if (!segment || segment.trim() !== segment) return false;
  if (segment === '.' || segment === '..') return false;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
  return !/[\\/\u0000-\u001f\u007f-\u009f]/.test(segment);
}

/**
 * The item folder `oldFilePath` lives in, when that folder is one of
 * `root`'s own item folders (`root/<plain name>`), else undefined. Purely
 * structural: the folder must be spelled exactly as `root` plus one plain
 * segment, so `root/.`, `root/..`, `root/x/..` or a trailing slash never
 * qualify. Compared case-insensitively for the Windows drive letter.
 */
function ownedItemDir(oldFilePath: string, root: string): string | undefined {
  const oldDir = getParentDir(oldFilePath);
  const base = getBaseName(oldDir);
  if (!isPlainSegment(base)) return undefined;
  return joinPath(root, base).toLowerCase() === oldDir.toLowerCase() ? oldDir : undefined;
}

/**
 * Save a skill or agent .md file to ~/.abu/{folder}/{name}/{fileName}.
 *
 * Nothing is ever deleted here. A rename is a MOVE: when `oldFilePath` lies in
 * one of ~/.abu/{folder}/'s own item folders under a different name, that
 * folder is renamed to `name` first — so whatever else it holds (a skill's
 * scripts/ and references/, an agent's memory.md) goes with it — and the
 * manifest is then written in place. A letter-case-only rename moves too, so
 * the folder's case really changes on the case-insensitive macOS/Windows file
 * systems. An `oldFilePath` anywhere else (a project-level, workspace or draft
 * item) is only copied from: the manifest is written into ~/.abu and the
 * original stays where it is.
 *
 * `name` must be one plain folder name; anything else throws an error whose
 * `code` is {@link ITEM_NAME_INVALID_CODE} before the disk is touched.
 *
 * `mustBeNew`: the caller is creating or renaming, so an item already at the
 * target is somebody else's — refuse (throw an error whose `code` is
 * {@link ITEM_EXISTS_CODE}) instead of overwriting it. The editors check names
 * against the registry first; this is the last line against a file that
 * appeared since, or one the registry never listed. A fresh write also asks
 * the host to create the file only if it is still absent; a move cannot land
 * on an occupied folder (the OS refuses to rename onto a non-empty one).
 */
export async function saveItemToAbuDir(
  folder: 'skills' | 'agents',
  fileName: 'SKILL.md' | 'AGENT.md',
  name: string,
  mdContent: string,
  oldFilePath?: string,
  options: { mustBeNew?: boolean } = {},
): Promise<void> {
  if (!isPlainSegment(name)) {
    throw Object.assign(new Error(`invalid ${folder} name: ${JSON.stringify(name)}`), { code: ITEM_NAME_INVALID_CODE });
  }
  const home = await homeDir();
  const root = joinPath(home, '.abu', folder);
  const targetDir = joinPath(root, name);
  const manifest = joinPath(targetDir, fileName);
  if (options.mustBeNew && await exists(manifest)) {
    throw Object.assign(new Error(`${folder}/${name} already exists`), { code: ITEM_EXISTS_CODE });
  }

  const oldDir = oldFilePath ? ownedItemDir(oldFilePath, root) : undefined;
  // Exact compare: a folder differing only in letter case is still moved.
  // A folder that is already gone has nothing to carry — write afresh.
  const moving = oldDir !== undefined && getBaseName(oldDir) !== name && await exists(oldDir);
  if (moving) {
    await rename(oldDir, targetDir);
    await writeTextFile(manifest, mdContent);
    return;
  }
  await mkdir(targetDir, { recursive: true });
  if (options.mustBeNew) await writeTextFile(manifest, mdContent, { createNew: true });
  else await writeTextFile(manifest, mdContent);
}
