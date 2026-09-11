import { writeTextFile, mkdir, remove, exists } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { joinPath, getParentDir } from '@/utils/pathUtils';

/** `code` of the error {@link saveItemToAbuDir} throws when `mustBeNew` finds the file already there. */
export const ITEM_EXISTS_CODE = 'ITEM_EXISTS';

/**
 * Save a skill or agent .md file to ~/.abu/{folder}/{name}/{fileName}.
 * If `oldFilePath` is provided and the name changed, removes the old directory.
 *
 * `mustBeNew`: the caller is creating or renaming, so an item already at the
 * target is somebody else's — refuse (throw an error whose `code` is
 * {@link ITEM_EXISTS_CODE}) instead of overwriting it. The editors check names
 * against the registry first; this is the last line against a file that
 * appeared since, or one the registry never listed.
 */
export async function saveItemToAbuDir(
  folder: 'skills' | 'agents',
  fileName: 'SKILL.md' | 'AGENT.md',
  name: string,
  mdContent: string,
  oldFilePath?: string,
  options: { mustBeNew?: boolean } = {},
): Promise<void> {
  const home = await homeDir();
  const targetDir = joinPath(home, '.abu', folder, name);
  if (options.mustBeNew && await exists(joinPath(targetDir, fileName))) {
    throw Object.assign(new Error(`${folder}/${name} already exists`), { code: ITEM_EXISTS_CODE });
  }
  await mkdir(targetDir, { recursive: true });
  await writeTextFile(joinPath(targetDir, fileName), mdContent);

  // If renamed, remove old directory — unless the rename only changed letter
  // case: on the case-insensitive macOS/Windows file systems `Reviewer/` IS
  // `reviewer/`, so removing the "old" folder would delete what was just saved.
  // Only ever a sibling item folder inside ~/.abu/{folder}/: a project-level
  // item (<workspace>/.abu/{folder}/x) is repository content this function only
  // copies from, and the root itself is never an item.
  if (oldFilePath) {
    const oldDir = getParentDir(oldFilePath);
    const ownedByAbuDir = getParentDir(oldDir).toLowerCase() === joinPath(home, '.abu', folder).toLowerCase();
    if (ownedByAbuDir && oldDir.toLowerCase() !== targetDir.toLowerCase()) {
      await remove(oldDir, { recursive: true }).catch(() => {/* ignore if already gone */});
    }
  }
}
