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
import { getI18n, format } from '@/i18n';
import { parse as parseYaml } from 'yaml';
import { isSafeSkillDirName } from './skillDirName';

// ── Constants ──────────────────────────────────────────────────────

const MAX_SINGLE_FILE = 10 * 1024 * 1024;   // 10 MB per file
const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024;   // 50 MB total archive

// .askill is a distribution format — strip VCS/OS noise and anything the
// Tauri fs scope won't allow (dot-prefixed entries fall outside $HOME/.abu/**).
const EXCLUDE_FILES = new Set(['Thumbs.db']);
const EXCLUDE_DIRS = new Set(['node_modules', '__pycache__']);

function shouldSkipEntry(name: string, isDir: boolean): boolean {
  if (name.startsWith('.')) return true;
  if (isDir && EXCLUDE_DIRS.has(name)) return true;
  if (!isDir && EXCLUDE_FILES.has(name)) return true;
  return false;
}

// ── Types ──────────────────────────────────────────────────────────

export interface UnpackResult {
  name: string;
  files: string[];
  targetDir: string;
}

export interface ValidationError {
  code:
    | 'NO_SKILL_MD'
    | 'NO_NAME'
    /** The frontmatter name is not one directory segment — see {@link UnsafeSkillNameError}. */
    | 'UNSAFE_NAME'
    | 'PATH_TRAVERSAL'
    | 'FILE_TOO_LARGE'
    | 'ARCHIVE_TOO_LARGE'
    | 'INVALID_ZIP';
  /**
   * Developer-facing English, rendered as-is by callers that have nothing
   * better — see `skillName` for the one code that does.
   */
  message: string;
  /**
   * UNSAFE_NAME only: the refused name, so the caller can render the localized
   * {@link UnsafeSkillNameError} text instead of `message`.
   *
   * `validateArchive` is a pure function with no locale of its own, and this is
   * the branch a user importing a hostile .askill actually reaches —
   * `unpackSkill`'s throw of the same rule sits behind it and cannot be hit
   * (SkillUploadModal returns on any validation error before it, and the
   * overwrite path is only reachable after a ConflictError, which requires a
   * name that already passed). Handing the caller the name rather than the
   * sentence keeps the string in the locale files where the repo requires it.
   */
  skillName?: string;
}

// ── Pack ───────────────────────────────────────────────────────────

/**
 * Pack a skill directory into a .askill (zip) archive.
 * Returns the zip bytes ready to be saved to disk.
 *
 * **Refuses rather than following a symlink.** This is the OUTBOUND direction:
 * the archive is a file the user saves and hands to someone else, and
 * `readFile` resolves the final component in the privileged host, so a
 * `refs/notes.md -> ~/.ssh/id_rsa` inside the skill directory used to put the
 * KEY's bytes in the package under that innocuous name. The skill directory
 * need not have been installed for that: the loader discovers
 * `{workspace}/.abu/skills`, so a cloned repo can carry the link and one click
 * on Export ships it.
 *
 * Why a refusal here where the install side skips-and-reports: the install has
 * a disclosure channel (`skippedSymlinks`, rendered in the upload toast) and
 * the user is choosing what to bring IN. An export has no such channel — its
 * caller takes bytes and shows a toast — and a package silently missing
 * `refs/notes.md` is a defect the RECIPIENT discovers, not the exporter. So
 * the export stops, names every entry it will not package, and the user fixes
 * the folder. (A link to a directory already stopped it, with
 * `EISDIR: illegal operation on a directory, read` — this replaces a syscall
 * string with an explanation and closes the file case, which did not stop.)
 */
export async function packSkill(skillDir: string): Promise<Uint8Array> {
  const fileMap: Record<string, Uint8Array> = {};
  const refused: string[] = [];
  await collectFiles(skillDir, '', fileMap, refused);
  if (refused.length > 0) throw new SkillPackSymlinkError(refused.sort());
  return zipSync(fileMap, { level: 6 });
}

/**
 * Recursively collect files from a directory into a flat { relativePath: bytes }
 * map, appending to `refused` the directory-relative path of everything the
 * archive will not carry.
 *
 * A link goes on that list BEFORE the isDirectory branch — a dirent for a link
 * reports `isDirectory: false` whichever kind of thing it points at, so testing
 * it afterwards would be testing nothing — and it is never read and never
 * descended into. Anything that is neither a real directory nor a real file
 * joins it: a FIFO reports `isFile: false` too, and `readFile` on one blocks
 * the privileged host's event loop until a writer appears.
 */
async function collectFiles(
  baseDir: string,
  prefix: string,
  out: Record<string, Uint8Array>,
  refused: string[],
): Promise<void> {
  const entries = await readDir(joinPath(baseDir, prefix || '.'));
  for (const entry of entries) {
    if (shouldSkipEntry(entry.name, entry.isDirectory)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymlink) {
      refused.push(rel);
    } else if (entry.isDirectory) {
      await collectFiles(baseDir, rel, out, refused);
    } else if (entry.isFile) {
      const bytes = await readFile(joinPath(baseDir, rel));
      out[rel] = new Uint8Array(bytes);
    } else {
      refused.push(rel);
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
  // The loop above screens entry PATHS for `..`; this screens the segment those
  // paths are written UNDER, which is the archive's own frontmatter name.
  if (!isSafeSkillDirName(name)) {
    return {
      code: 'UNSAFE_NAME',
      message: `SKILL.md declares a name that is not a single directory segment: "${name}"`,
      skillName: name,
    };
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
  const name = extractNameFromSkillMd(skillMdContent);

  // The one rule every skill installer applies to a name it turns into a
  // directory (src/core/skill/skillDirName.ts). This is the fourth route, and
  // the last one to get it: `validateArchive` screens entry paths for `..` but
  // never screened the name, `joinPath` does not collapse `..`, and the host's
  // guard only asks whether the RESOLVED path lands under an allowed root — so
  // `name: ../../.ssh` resolved to `~/.ssh` and every check passed. Enforced
  // here rather than relying on `validateArchive` having run: the overwrite
  // path (SkillUploadModal) calls this directly, and the two must agree on
  // their own rather than because one happens to go first.
  if (!name || !isSafeSkillDirName(name)) {
    throw new UnsafeSkillNameError(name ?? '');
  }

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

    // Defensive: archives from older/external packagers may contain dotfiles
    // that Tauri's fs scope won't let us write. Skip any path segment that
    // would be filtered on the pack side.
    const segments = relativePath.split('/');
    const skip = segments.some((seg, i) => {
      const isDir = i < segments.length - 1;
      return shouldSkipEntry(seg, isDir);
    });
    if (skip) continue;

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

/**
 * The archive declares a `name` that is not one directory segment.
 *
 * Rendered by the upload modal straight from `.message`, so the text is the
 * locale's, not a developer string.
 */
export class UnsafeSkillNameError extends Error {
  readonly skillName: string;

  constructor(skillName: string) {
    super(format(getI18n().toolbox.importUnsafeName, { name: skillName }));
    this.name = 'UnsafeSkillNameError';
    this.skillName = skillName;
  }
}

/**
 * The skill directory holds entries {@link packSkill} will not put in an
 * archive: symlinks, and anything else that is not a real file or directory.
 */
export class SkillPackSymlinkError extends Error {
  /** Directory-relative paths of the refused entries, sorted. */
  readonly entries: string[];

  constructor(entries: string[]) {
    super(
      format(getI18n().toolbox.exportSymlinkRefused, {
        n: String(entries.length),
        names: entries.join(getI18n().toolResult.listSeparator),
      }),
    );
    this.name = 'SkillPackSymlinkError';
    this.entries = entries;
  }

  /**
   * The one caller renders `String(err)` into the export-failed toast
   * (SkillsSection's handleExport), and the default `Error.prototype.toString`
   * would put "SkillPackSymlinkError: " in front of a sentence written for the
   * user.
   */
  toString(): string {
    return this.message;
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
