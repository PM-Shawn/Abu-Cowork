/**
 * Install an agent from a local folder.
 *
 * Validates that the folder contains an AGENT.md with a valid `name` frontmatter field,
 * then recursively copies the entire directory to ~/.abu/agents/{name}/.
 */

import { readTextFile, readDir, readFile, writeFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { parse as parseYaml } from 'yaml';
import { joinPath } from '@/utils/pathUtils';

export type InstallResult =
  | { ok: true; name: string; fileCount: number }
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

  // 5. Recursively copy folder
  try {
    const fileCount = await copyDirectory(folderPath, targetDir);
    return { ok: true, name, fileCount };
  } catch (err) {
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
