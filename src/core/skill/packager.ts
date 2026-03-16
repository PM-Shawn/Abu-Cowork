/**
 * Skill Package (.askill) - Pack & Unpack
 *
 * .askill files are zip archives containing a skill directory:
 *   SKILL.md (required) + optional supporting files (scripts/, references/, assets/)
 *
 * The skill name is extracted from the SKILL.md YAML frontmatter `name` field.
 */

import { zipSync, unzipSync, strFromU8 } from 'fflate';
import { readFile, writeFile, readDir, mkdir, exists } from '@tauri-apps/plugin-fs';
import { joinPath } from '@/utils/pathUtils';
import { parse as parseYaml } from 'yaml';

// ── Constants ──────────────────────────────────────────────────────

const MAX_SINGLE_FILE = 10 * 1024 * 1024;   // 10 MB per file
const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024;   // 50 MB total archive

// ── Types ──────────────────────────────────────────────────────────

export interface UnpackResult {
  name: string;
  files: string[];
  targetDir: string;
}

export interface ValidationError {
  code: 'NO_SKILL_MD' | 'NO_NAME' | 'PATH_TRAVERSAL' | 'FILE_TOO_LARGE' | 'ARCHIVE_TOO_LARGE' | 'INVALID_ZIP';
  message: string;
}

// ── Pack ───────────────────────────────────────────────────────────

/**
 * Pack a skill directory into a .askill (zip) archive.
 * Returns the zip bytes ready to be saved to disk.
 */
export async function packSkill(skillDir: string): Promise<Uint8Array> {
  const fileMap: Record<string, Uint8Array> = {};
  await collectFiles(skillDir, '', fileMap);
  return zipSync(fileMap, { level: 6 });
}

/** Recursively collect files from a directory into a flat { relativePath: bytes } map */
async function collectFiles(
  baseDir: string,
  prefix: string,
  out: Record<string, Uint8Array>,
): Promise<void> {
  const entries = await readDir(joinPath(baseDir, prefix || '.'));
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      await collectFiles(baseDir, rel, out);
    } else {
      const bytes = await readFile(joinPath(baseDir, rel));
      out[rel] = new Uint8Array(bytes);
    }
  }
}

// ── Validate ──────────────────────────────────────────────────────

/**
 * Validate a zip archive before unpacking.
 * Returns null if valid, or a ValidationError describing the problem.
 */
export function validateArchive(bytes: Uint8Array): ValidationError | null {
  if (bytes.length > MAX_ARCHIVE_SIZE) {
    return { code: 'ARCHIVE_TOO_LARGE', message: `Archive exceeds ${MAX_ARCHIVE_SIZE / 1024 / 1024}MB limit` };
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return { code: 'INVALID_ZIP', message: 'File is not a valid zip archive' };
  }

  // Must contain SKILL.md (at root level)
  const skillMdKey = Object.keys(entries).find(
    (k) => k === 'SKILL.md' || k.endsWith('/SKILL.md'),
  );
  if (!skillMdKey) {
    return { code: 'NO_SKILL_MD', message: 'Archive does not contain SKILL.md' };
  }

  // Check path traversal & file sizes
  for (const [path, data] of Object.entries(entries)) {
    if (path.includes('..') || path.startsWith('/')) {
      return { code: 'PATH_TRAVERSAL', message: `Unsafe path detected: ${path}` };
    }
    if (data.length > MAX_SINGLE_FILE) {
      return { code: 'FILE_TOO_LARGE', message: `File "${path}" exceeds ${MAX_SINGLE_FILE / 1024 / 1024}MB limit` };
    }
  }

  // Extract name from SKILL.md frontmatter
  const skillMdContent = strFromU8(entries[skillMdKey]);
  const name = extractNameFromSkillMd(skillMdContent);
  if (!name) {
    return { code: 'NO_NAME', message: 'SKILL.md is missing a valid "name" field in frontmatter' };
  }

  return null;
}

// ── Unpack ─────────────────────────────────────────────────────────

/**
 * Unpack a .askill archive into the target skills base directory.
 * The skill name is extracted from SKILL.md frontmatter.
 *
 * @param bytes    - The zip archive bytes
 * @param baseDir  - Target base directory (e.g. ~/.abu/skills/)
 * @param options  - overwrite: replace existing skill directory
 * @returns UnpackResult with name, file list, and target directory
 */
export async function unpackSkill(
  bytes: Uint8Array,
  baseDir: string,
  options?: { overwrite?: boolean },
): Promise<UnpackResult> {
  const entries = unzipSync(bytes);

  // Find SKILL.md and determine the prefix (if files are nested in a subdirectory)
  const skillMdKey = Object.keys(entries).find(
    (k) => k === 'SKILL.md' || k.endsWith('/SKILL.md'),
  )!;

  // Determine prefix to strip (e.g. "my-skill/" if zip was created from a parent dir)
  const prefix = skillMdKey === 'SKILL.md' ? '' : skillMdKey.replace(/SKILL\.md$/, '');

  // Extract name
  const skillMdContent = strFromU8(entries[skillMdKey]);
  const name = extractNameFromSkillMd(skillMdContent)!;

  const targetDir = joinPath(baseDir, name);

  // Check for existing skill
  if (!options?.overwrite && await exists(targetDir)) {
    throw new ConflictError(name, targetDir);
  }

  // Write all files
  const files: string[] = [];
  for (const [path, data] of Object.entries(entries)) {
    // Strip prefix and skip directory entries (trailing /)
    const relativePath = prefix ? path.replace(prefix, '') : path;
    if (!relativePath || relativePath.endsWith('/')) continue;

    const targetPath = joinPath(targetDir, relativePath);

    // Ensure parent directory exists
    const parentDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
    if (parentDir) {
      await mkdir(parentDir, { recursive: true });
    }

    await writeFile(targetPath, data);
    files.push(relativePath);
  }

  return { name, files, targetDir };
}

// ── Helpers ────────────────────────────────────────────────────────

/** Extract skill name from SKILL.md YAML frontmatter */
function extractNameFromSkillMd(content: string): string | null {
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

/** Custom error for skill name conflict */
export class ConflictError extends Error {
  skillName: string;
  targetDir: string;
  constructor(skillName: string, targetDir: string) {
    super(`Skill "${skillName}" already exists`);
    this.name = 'ConflictError';
    this.skillName = skillName;
    this.targetDir = targetDir;
  }
}
