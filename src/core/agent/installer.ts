/**
 * Install an agent from a local folder.
 *
 * Validates that the folder contains an AGENT.md with a valid `name` frontmatter field,
 * then recursively copies the entire directory to ~/.abu/agents/{name}/.
 */

import { readTextFile, readDir, readFile, writeFile, mkdir, exists, remove, rename } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { parse as parseYaml } from 'yaml';
import { joinPath } from '@/utils/pathUtils';

export type InstallResult =
  | { ok: true; name: string; fileCount: number; skipped: string[] }
  | { ok: false; code: 'NO_AGENT_MD' | 'NO_NAME' | 'ALREADY_EXISTS' | 'COPY_FAILED'; message: string };

/**
 * Install an agent by copying a folder to ~/.abu/agents/{name}/.
 *
 * @param folderPath - Absolute path to the source folder (must contain AGENT.md)
 * @param options    - overwrite: replace existing agent directory
 */
export async function installAgentFromFolder(
  folderPath: string,
  options?: { overwrite?: boolean },
): Promise<InstallResult> {
  // 1. Check AGENT.md exists
  const agentMdPath = joinPath(folderPath, 'AGENT.md');
  if (!(await exists(agentMdPath))) {
    return { ok: false, code: 'NO_AGENT_MD', message: 'Folder does not contain AGENT.md' };
  }

  // 2. Parse name from frontmatter
  const raw = await readTextFile(agentMdPath);
  const name = extractName(raw);
  if (!name) {
    return { ok: false, code: 'NO_NAME', message: 'AGENT.md is missing a valid "name" field in frontmatter' };
  }

  // 3. Determine target directory
  const home = await homeDir();
  const targetDir = joinPath(home, '.abu', 'agents', name);

  // 4. Conflict check
  if (!options?.overwrite && (await exists(targetDir))) {
    return { ok: false, code: 'ALREADY_EXISTS', message: `Agent "${name}" already exists` };
  }

  // 5. Atomic copy via a staging dir outside ~/.abu/agents, then swap into place.
  //    A failure never leaves a partial target (which would falsely report
  //    "already exists" on retry). On overwrite, the existing target is moved
  //    aside and restored if the swap fails, so a rename error never leaves the
  //    user with neither the old nor the new agent. Dotfiles are skipped (see copyDirectory).
  const stagingDir = joinPath(home, '.abu', 'agent-staging', name);
  const backupDir = joinPath(home, '.abu', 'agent-staging', `__backup__${name}`);
  const skipped: string[] = [];
  try {
    if (await exists(stagingDir)) {
      await remove(stagingDir, { recursive: true });
    }
    const fileCount = await copyDirectory(folderPath, stagingDir, skipped, true);

    await mkdir(joinPath(home, '.abu', 'agents'), { recursive: true });

    const hadExisting = await exists(targetDir);
    if (hadExisting) {
      if (await exists(backupDir)) await remove(backupDir, { recursive: true });
      await rename(targetDir, backupDir);
    }
    try {
      await rename(stagingDir, targetDir);
    } catch (swapErr) {
      if (hadExisting) {
        try { await rename(backupDir, targetDir); } catch { /* best-effort restore */ }
      }
      throw swapErr;
    }
    if (hadExisting) {
      try { await remove(backupDir, { recursive: true }); } catch { /* best-effort */ }
    }

    return { ok: true, name, fileCount, skipped };
  } catch (err) {
    try {
      await remove(stagingDir, { recursive: true });
    } catch {
      /* best-effort cleanup — staging may not exist yet */
    }
    return { ok: false, code: 'COPY_FAILED', message: String(err) };
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/** Extract agent name from AGENT.md YAML frontmatter */
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
 * (require_literal_leading_dot), so copying them throws "forbidden path" and would
 * abort the whole install. Only TOP-LEVEL skipped names are collected (isTop) so
 * nested basenames like `.DS_Store` aren't duplicated in the caller's message.
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
