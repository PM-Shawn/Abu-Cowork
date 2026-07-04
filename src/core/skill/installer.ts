/**
 * Install a skill from a local folder.
 *
 * Validates that the folder contains a SKILL.md with a valid `name` frontmatter field,
 * then recursively copies the entire directory to ~/.abu/skills/{name}/.
 */

import { readTextFile, readDir, readFile, writeFile, mkdir, exists, remove, rename } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { parse as parseYaml } from 'yaml';
import { joinPath } from '@/utils/pathUtils';
import { getCurrentPolicy } from '@/core/enterprise/policy/enforcer';
import { checkSkill } from '@/core/enterprise/policy/matcher';

export type InstallResult =
  | { ok: true; name: string; fileCount: number; skipped: string[] }
  | { ok: false; code: 'NO_SKILL_MD' | 'NO_NAME' | 'ALREADY_EXISTS' | 'COPY_FAILED' | 'POLICY_DENIED'; message: string };

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

  // 3a. Policy check: deny if skill name is blacklisted
  const policyCheck = checkSkill(getCurrentPolicy(), name);
  if (policyCheck.decision === 'deny') {
    return { ok: false, code: 'POLICY_DENIED', message: `[policy] ${policyCheck.reason ?? `skill '${name}' blocked by policy`}` };
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
  const stagingDir = joinPath(home, '.abu', 'skill-staging', name);
  const backupDir = joinPath(home, '.abu', 'skill-staging', `__backup__${name}`);
  const skipped: string[] = [];
  try {
    if (await exists(stagingDir)) {
      await remove(stagingDir, { recursive: true });
    }
    const fileCount = await copyDirectory(folderPath, stagingDir, skipped, true);

    await mkdir(joinPath(home, '.abu', 'skills'), { recursive: true });

    // Move any existing target aside so a failed swap can be rolled back.
    const hadExisting = await exists(targetDir);
    if (hadExisting) {
      if (await exists(backupDir)) await remove(backupDir, { recursive: true });
      await rename(targetDir, backupDir);
    }
    try {
      await rename(stagingDir, targetDir);
    } catch (swapErr) {
      // Restore the original so the user never ends up with nothing.
      if (hadExisting) {
        try { await rename(backupDir, targetDir); } catch { /* best-effort restore */ }
      }
      throw swapErr;
    }
    // Swap succeeded — drop the backup.
    if (hadExisting) {
      try { await remove(backupDir, { recursive: true }); } catch { /* best-effort */ }
    }

    return { ok: true, name, fileCount, skipped };
  } catch (err) {
    // Roll back the staging dir so nothing partial is left behind.
    try {
      await remove(stagingDir, { recursive: true });
    } catch {
      /* best-effort cleanup — staging may not exist yet */
    }
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

/**
 * Recursively copy a directory, returning total file count.
 *
 * Dotfiles / dotdirs (`.DS_Store`, `.mcp.json`, `.claude`, `.git`, …) are skipped:
 * the Tauri fs scope (`$HOME/**`) cannot read a path segment starting with `.`
 * (require_literal_leading_dot), so attempting to copy them throws "forbidden path"
 * and would abort the whole install. Only TOP-LEVEL skipped names are collected
 * (isTop) so the caller can tell the user what was left out (e.g. an `.mcp.json`
 * with secrets) without duplicating nested basenames like `.DS_Store`.
 */
async function copyDirectory(srcDir: string, destDir: string, skipped: string[], isTop = false): Promise<number> {
  await mkdir(destDir, { recursive: true });
  let count = 0;

  const entries = await readDir(srcDir);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      if (isTop) skipped.push(entry.name);
      continue;
    }

    const srcPath = joinPath(srcDir, entry.name);
    const destPath = joinPath(destDir, entry.name);

    if (entry.isDirectory) {
      count += await copyDirectory(srcPath, destPath, skipped);
    } else {
      const bytes = await readFile(srcPath);
      await writeFile(destPath, new Uint8Array(bytes));
      count++;
    }
  }

  return count;
}
