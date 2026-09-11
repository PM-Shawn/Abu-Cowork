/**
 * Unified skill installer — routes by source type:
 *   local path  → installSkillFromFolder
 *   npm name    → installSkillFromNpm
 *   URL / GitHub → downloadTarball + extract + write to ~/.abu/skills/<name>/
 */

import { unzipSync, strFromU8 } from 'fflate';
import { writeFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { parse as parseYaml } from 'yaml';
import { joinPath } from '@/utils/pathUtils';
import { atomicInstallDir } from '@/core/fsAtomic';
import { isSafeSkillDirName } from './skillDirName';
import { assertSkillNameAllowed } from './skillPolicy';
import { rootManifestCount } from './rootManifest';
import {
  downloadTarball,
  extractTarball,
  fileEntryPaths,
  findSkillEntries,
  stripPrefix,
  NpmInstallError,
  type TarEntry,
} from './npmInstaller';

// ── Constants ──────────────────────────────────────────────────────

const MAX_SINGLE_FILE = 10 * 1024 * 1024; // 10 MB

// ── Source detection ───────────────────────────────────────────────

export type InstallSourceType = 'folder' | 'npm' | 'url';

export function detectSourceType(source: string): InstallSourceType {
  if (source.startsWith('/') || source.startsWith('~/') || source.startsWith('./') || source.startsWith('../')) {
    return 'folder';
  }
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return 'url';
  }
  return 'npm';
}

// ── GitHub URL normalizer ──────────────────────────────────────────

function resolveDownloadUrl(url: string): string {
  // https://github.com/user/repo  or  .../tree/branch  → archive zip
  const ghMatch = url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:\/tree\/([^/?#]+))?(?:[/?#].*)?$/
  );
  if (ghMatch) {
    const [, owner, repo, branch = 'main'] = ghMatch;
    return `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
  }
  return url;
}

// ── URL → skill installer ──────────────────────────────────────────

export interface UrlInstallResult {
  skillName: string;
  files: string[];
  targetDir: string;
}

/**
 * Install a skill from any HTTP URL (direct .tgz/.zip, or GitHub repo URL).
 * Writes to ~/.abu/skills/<name>/ (user-level "我的技能").
 */
export async function installSkillFromUrl(
  rawUrl: string,
  options?: { overwrite?: boolean },
): Promise<UrlInstallResult> {
  const url = resolveDownloadUrl(rawUrl);
  const bytes = await downloadTarball(url);

  // Convert to unified TarEntry[] regardless of archive format
  let entries: TarEntry[];
  if (url.endsWith('.tgz') || url.endsWith('.tar.gz')) {
    entries = extractTarball(bytes);
  } else {
    // .zip or GitHub archive (default)
    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(bytes);
    } catch {
      throw new NpmInstallError('EXTRACT_FAILED', 'Failed to extract zip archive');
    }
    entries = Object.entries(unzipped).map(([path, data]) => ({ path, data }));
  }

  // Find SKILL.md and resolve skill name
  const skillLocs = findSkillEntries(entries);
  if (!skillLocs.length) {
    throw new NpmInstallError('NO_SKILL_MD', 'Archive does not contain a SKILL.md file');
  }

  const { skillMdEntry, prefix } = skillLocs[0];
  const skillName = extractNameFromSkillMd(strFromU8(skillMdEntry.data));
  if (!skillName) {
    throw new NpmInstallError('NO_NAME', 'SKILL.md is missing a valid "name" field in frontmatter');
  }
  // The name becomes a directory under ~/.abu/skills. The entry-path check
  // below refuses `..` inside a file path; this refuses it in the segment
  // those paths are written UNDER — see isSafeSkillDirName.
  if (!isSafeSkillDirName(skillName)) {
    throw new NpmInstallError('PATH_TRAVERSAL', `SKILL.md declares an unsafe skill name: "${skillName}"`);
  }
  // The name checked here must be the name that goes live — see rootManifest.ts.
  if (rootManifestCount(fileEntryPaths(entries, prefix)) > 1) {
    throw new NpmInstallError('AMBIGUOUS_SKILL_MD', 'Archive has more than one SKILL.md at its root');
  }
  // The organization's skill blacklist, before anything reaches disk.
  assertSkillNameAllowed(skillName);

  // Write to ~/.abu/skills/<name>/
  const home = await homeDir();
  const targetDir = joinPath(home, '.abu', 'skills', skillName);

  if (!options?.overwrite && (await exists(targetDir))) {
    throw new NpmInstallError('ALREADY_EXISTS', `Skill "${skillName}" already exists`);
  }

  // Stage the whole archive OUTSIDE ~/.abu/skills, then swap it in — the same
  // primitive and the same reason as the folder and npm routes.
  //
  // The per-entry guards below throw MID-LOOP, and the entry order belongs to
  // whoever built the archive — which here is an arbitrary attacker-hosted zip
  // with no registry in between. Writing straight into `~/.abu/skills/<name>/`
  // therefore left a REFUSED archive's files on disk, where the skill loader
  // scans and a watcher picks them up: its SKILL.md became a live,
  // model-visible skill under the frontmatter name IT chose while the install
  // reported failure, and the residue bricked the honest retry with
  // ALREADY_EXISTS.
  const files: string[] = [];
  await atomicInstallDir({
    targetDir,
    workDir: joinPath(home, '.abu', 'skill-staging'),
    write: async (stagingDir) => {
      await mkdir(stagingDir, { recursive: true });
      for (const entry of entries) {
        const rel = stripPrefix(entry.path, prefix);
        if (!rel || rel.endsWith('/')) continue;
        if (rel.includes('..') || rel.startsWith('/')) {
          throw new NpmInstallError('PATH_TRAVERSAL', `Unsafe path: ${entry.path}`);
        }
        if (entry.data.length > MAX_SINGLE_FILE) {
          throw new NpmInstallError('FILE_TOO_LARGE', `File "${rel}" exceeds 10 MB limit`);
        }

        const dest = joinPath(stagingDir, rel);
        const lastSlash = dest.lastIndexOf('/');
        if (lastSlash > 0) await mkdir(dest.substring(0, lastSlash), { recursive: true });

        await writeFile(dest, entry.data);
        files.push(rel);
      }
    },
  });

  return { skillName, files, targetDir };
}

// ── Helper ─────────────────────────────────────────────────────────

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
