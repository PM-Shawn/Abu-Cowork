import { writeTextFile, mkdir, rename, exists, lstat, readTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { joinPath, getBaseName, normalizeSeparators } from '@/utils/pathUtils';

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
 * Where the item whose manifest is `filePath` lives, when the path is spelled
 * like one: absolute, without `.`/`..`/empty segments, and ending in
 * `<folder>/<plain item folder>/<manifest>` (manifest name compared
 * case-insensitively, so a lower-case `agent.md` qualifies). Purely
 * structural — every root the agent registry and skill loader scan has this
 * shape (~/.abu/<folder>, a project's .abu/<folder> or .agents/skills, the
 * per-project skills under ~/.abu/projects, ~/.agents/skills), while the
 * bundled builtin-* and enterprise roots, a manifest sitting directly in a
 * root, and `__builtin__` do not. Returns the normalized manifest path, the
 * item folder and its parent (the folder a rename stays in).
 */
function itemLocation(
  filePath: string,
  folder: 'skills' | 'agents',
  fileName: 'SKILL.md' | 'AGENT.md',
): { manifest: string; itemDir: string; root: string } | undefined {
  const segments = normalizeSeparators(filePath).split('/');
  const [first, ...rest] = segments;
  const absolute = first === '' || /^[A-Za-z]:$/.test(first);
  if (!absolute || rest.length < 3) return undefined;
  if (rest.some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined;
  const [container, item, manifest] = segments.slice(-3);
  if (container !== folder || !isPlainSegment(item) || manifest.toLowerCase() !== fileName.toLowerCase()) return undefined;
  return {
    manifest: segments.join('/'),
    itemDir: segments.slice(0, -1).join('/'),
    root: segments.slice(0, -2).join('/'),
  };
}

function itemExistsError(folder: string, name: string): Error {
  return Object.assign(new Error(`${folder}/${name} already exists`), { code: ITEM_EXISTS_CODE });
}

/**
 * Save a skill or agent .md file.
 *
 * A NEW item (no `oldFilePath`) is written to ~/.abu/{folder}/{name}/{fileName}.
 *
 * An EXISTING item is saved where it lives — ~/.abu, a project's folder, the
 * shared ~/.agents/skills — into the very file the registry read
 * (`oldFilePath`). It is never copied into ~/.abu: a copy there overwrote the
 * user's own same-named item and was then shadowed by the project item, so
 * the edit never took. A rename writes the manifest in place first and then
 * MOVES the item's folder to `name` within the same parent folder — so
 * whatever else it holds (a skill's scripts/ and references/, an agent's
 * memory.md) goes with it; if the move fails the old text is put back. A
 * letter-case-only rename moves too, so the folder's case really changes on
 * the case-insensitive macOS/Windows file systems. `oldFilePath` must be
 * spelled like an item (see {@link itemLocation}) and its manifest must be a
 * plain file right now — not a link, not gone — or nothing is touched.
 *
 * Nothing is ever deleted here.
 *
 * `name` must be one plain folder name; anything else throws an error whose
 * `code` is {@link ITEM_NAME_INVALID_CODE} before the disk is touched.
 *
 * `mustBeNew`: the caller is creating or renaming, so an item already at the
 * target is somebody else's — refuse (throw an error whose `code` is
 * {@link ITEM_EXISTS_CODE}) instead of overwriting it. The editors check names
 * against the registry first; this is the last line against a file that
 * appeared since, or one the registry never listed. A new item is also
 * written with the host's create-only flag; a move cannot land on an occupied
 * folder (the OS refuses to rename onto a non-empty one).
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

  if (oldFilePath === undefined) {
    const targetDir = joinPath(await homeDir(), '.abu', folder, name);
    const manifest = joinPath(targetDir, fileName);
    if (options.mustBeNew && await exists(manifest)) throw itemExistsError(folder, name);
    await mkdir(targetDir, { recursive: true });
    if (options.mustBeNew) await writeTextFile(manifest, mdContent, { createNew: true });
    else await writeTextFile(manifest, mdContent);
    return;
  }

  const location = itemLocation(oldFilePath, folder, fileName);
  if (!location) throw new Error(`not an editable ${folder} item: ${JSON.stringify(oldFilePath)}`);
  const { manifest, itemDir, root } = location;
  // The same rule the registry and loader read by: a manifest the folder
  // OWNS. A link put in its place since would carry this write elsewhere.
  const info = await lstat(manifest);
  if (!info.isFile || info.isSymlink) throw new Error(`${folder} manifest is not a plain file: ${manifest}`);

  // Exact compare: a folder differing only in letter case is still moved.
  if (getBaseName(itemDir) === name) {
    // create: false — a file deleted since the check is not recreated.
    await writeTextFile(manifest, mdContent, { create: false });
    return;
  }

  const targetDir = joinPath(root, name);
  if (options.mustBeNew && await exists(joinPath(targetDir, fileName))) throw itemExistsError(folder, name);
  // Write before moving: a failed write leaves the item as it was, and a
  // retry after a failed move finds nothing of its own at the target.
  const original = await readTextFile(manifest);
  await writeTextFile(manifest, mdContent, { create: false });
  try {
    await rename(itemDir, targetDir);
  } catch (err) {
    // Best effort: the move's error is the one to surface. If this fails too
    // the folder keeps its old name with the new text, and a retry moves it.
    await writeTextFile(manifest, original, { create: false }).catch(() => undefined);
    throw err;
  }
}
