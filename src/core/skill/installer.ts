/**
 * Install a skill from a local folder.
 *
 * Validates that the folder contains a SKILL.md with a valid `name` frontmatter field,
 * then recursively copies the entire directory to ~/.abu/skills/{name}/.
 */

import { readTextFile, readDir, readFile, writeFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { parse as parseYaml } from 'yaml';
import { joinPath } from '@/utils/pathUtils';

export type InstallResult =
  | { ok: true; name: string; fileCount: number }
  | { ok: false; code: 'NO_SKILL_MD' | 'NO_NAME' | 'ALREADY_EXISTS' | 'COPY_FAILED'; message: string };

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
  // 1. Check SKILL.md exists
  const skillMdPath = joinPath(folderPath, 'SKILL.md');
  if (!(await exists(skillMdPath))) {
    return { ok: false, code: 'NO_SKILL_MD', message: 'Folder does not contain SKILL.md' };
  }

  // 2. Parse name from frontmatter
  const raw = await readTextFile(skillMdPath);
  const name = extractName(raw);
  if (!name) {
    return { ok: false, code: 'NO_NAME', message: 'SKILL.md is missing a valid "name" field in frontmatter' };
  }

  // 3. Determine target directory
  const home = await homeDir();
  const targetDir = joinPath(home, '.abu', 'skills', name);

  // 4. Conflict check
  if (!options?.overwrite && (await exists(targetDir))) {
    return { ok: false, code: 'ALREADY_EXISTS', message: `Skill "${name}" already exists` };
  }

  // 5. Recursively copy folder
  try {
    const fileCount = await copyDirectory(folderPath, targetDir);
    return { ok: true, name, fileCount };
  } catch (err) {
    return { ok: false, code: 'COPY_FAILED', message: String(err) };
  }
}

// ── Helpers ────────────────────────────────────────────────────────

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

/** Recursively copy a directory, returning total file count */
async function copyDirectory(srcDir: string, destDir: string): Promise<number> {
  await mkdir(destDir, { recursive: true });
  let count = 0;

  const entries = await readDir(srcDir);
  for (const entry of entries) {
    const srcPath = joinPath(srcDir, entry.name);
    const destPath = joinPath(destDir, entry.name);

    if (entry.isDirectory) {
      count += await copyDirectory(srcPath, destPath);
    } else {
      const bytes = await readFile(srcPath);
      await writeFile(destPath, new Uint8Array(bytes));
      count++;
    }
  }

  return count;
}
