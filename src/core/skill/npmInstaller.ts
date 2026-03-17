/**
 * npm Registry Skill Installer
 *
 * Downloads skill packages from npm registries (including private registries),
 * extracts SKILL.md files, and installs them to ~/.abu/skills/<name>/.
 *
 * Flow: fetch metadata → download .tgz → gunzip → parse tar → find SKILL.md → write to disk
 */

import { fetch } from '@tauri-apps/plugin-http';
import { gunzipSync, strFromU8 } from 'fflate';
import { writeFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { joinPath } from '@/utils/pathUtils';
import { parse as parseYaml } from 'yaml';

// ── Constants ──────────────────────────────────────────────────────

const MAX_SINGLE_FILE = 10 * 1024 * 1024;   // 10 MB per file
const MAX_TARBALL_SIZE = 50 * 1024 * 1024;   // 50 MB total download
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

// ── Types ──────────────────────────────────────────────────────────

export interface NpmPackageInfo {
  name: string;
  version: string;
  description: string;
  tarballUrl: string;
}

interface TarEntry {
  path: string;
  data: Uint8Array;
}

export interface NpmInstallResult {
  packageName: string;
  version: string;
  skillName: string;
  files: string[];
  targetDir: string;
}

export type NpmInstallErrorCode =
  | 'PACKAGE_NOT_FOUND'
  | 'NETWORK_ERROR'
  | 'TARBALL_TOO_LARGE'
  | 'NO_SKILL_MD'
  | 'NO_NAME'
  | 'PATH_TRAVERSAL'
  | 'FILE_TOO_LARGE'
  | 'EXTRACT_FAILED'
  | 'ALREADY_EXISTS';

export class NpmInstallError extends Error {
  code: NpmInstallErrorCode;
  constructor(code: NpmInstallErrorCode, message: string) {
    super(message);
    this.name = 'NpmInstallError';
    this.code = code;
  }
}

// ── Progress callback ──────────────────────────────────────────────

export type InstallStep = 'fetching_metadata' | 'downloading' | 'extracting' | 'installing' | 'done';

export type OnProgress = (step: InstallStep, detail?: string) => void;

// ── Main entry ─────────────────────────────────────────────────────

/**
 * Install a skill from an npm registry.
 *
 * @param packageName  npm package name (e.g. "cooper", "@scope/my-skill")
 * @param registry     Registry URL (defaults to npmjs.org)
 * @param options      overwrite: replace existing skill; onProgress: step callbacks
 */
export async function installSkillFromNpm(
  packageName: string,
  registry?: string,
  options?: { overwrite?: boolean; onProgress?: OnProgress },
): Promise<NpmInstallResult> {
  const reg = (registry || DEFAULT_REGISTRY).replace(/\/+$/, '');
  const progress = options?.onProgress ?? (() => {});

  // Step 1: Fetch package metadata
  progress('fetching_metadata', packageName);
  const pkgInfo = await fetchPackageMetadata(reg, packageName);

  // Step 2: Download tarball
  progress('downloading', pkgInfo.version);
  const tarballBytes = await downloadTarball(pkgInfo.tarballUrl);

  // Step 3: Extract
  progress('extracting');
  const entries = extractTarball(tarballBytes);

  // Step 4: Find and validate SKILL.md
  const skillEntries = findSkillEntries(entries);
  if (skillEntries.length === 0) {
    throw new NpmInstallError('NO_SKILL_MD', `Package "${packageName}" does not contain a SKILL.md file`);
  }

  // Use the first SKILL.md found
  const { skillMdEntry, prefix } = skillEntries[0];
  const skillMdContent = strFromU8(skillMdEntry.data);
  const skillName = extractNameFromSkillMd(skillMdContent);
  if (!skillName) {
    throw new NpmInstallError('NO_NAME', 'SKILL.md is missing a valid "name" field in frontmatter');
  }

  // Step 5: Write to ~/.abu/skills/<name>/
  progress('installing', skillName);
  const home = await homeDir();
  const skillsBase = joinPath(home, '.abu/skills');
  const targetDir = joinPath(skillsBase, skillName);

  if (!options?.overwrite && await exists(targetDir)) {
    throw new NpmInstallError('ALREADY_EXISTS', `Skill "${skillName}" already exists at ${targetDir}`);
  }

  await mkdir(targetDir, { recursive: true });

  const files: string[] = [];
  for (const entry of entries) {
    // Strip the npm "package/" prefix and skill-specific prefix
    const relativePath = stripPrefix(entry.path, prefix);
    if (!relativePath || relativePath.endsWith('/')) continue;

    // Security: reject path traversal
    if (relativePath.includes('..') || relativePath.startsWith('/')) {
      throw new NpmInstallError('PATH_TRAVERSAL', `Unsafe path: ${entry.path}`);
    }

    // Size check
    if (entry.data.length > MAX_SINGLE_FILE) {
      throw new NpmInstallError('FILE_TOO_LARGE', `File "${relativePath}" exceeds 10MB limit`);
    }

    const targetPath = joinPath(targetDir, relativePath);

    // Ensure parent directory exists
    const lastSlash = targetPath.lastIndexOf('/');
    if (lastSlash > 0) {
      await mkdir(targetPath.substring(0, lastSlash), { recursive: true });
    }

    await writeFile(targetPath, entry.data);
    files.push(relativePath);
  }

  progress('done', skillName);

  return {
    packageName: pkgInfo.name,
    version: pkgInfo.version,
    skillName,
    files,
    targetDir,
  };
}

// ── npm Registry API ───────────────────────────────────────────────

async function fetchPackageMetadata(registry: string, packageName: string): Promise<NpmPackageInfo> {
  // Scoped packages need encoding: @scope/name → @scope%2fname
  const encodedName = packageName.startsWith('@')
    ? `@${encodeURIComponent(packageName.slice(1))}`
    : encodeURIComponent(packageName);

  const url = `${registry}/${encodedName}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw new NpmInstallError('NETWORK_ERROR', `Failed to reach registry: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (resp.status === 404) {
    throw new NpmInstallError('PACKAGE_NOT_FOUND', `Package "${packageName}" not found in registry`);
  }
  if (!resp.ok) {
    throw new NpmInstallError('NETWORK_ERROR', `Registry returned ${resp.status}: ${resp.statusText}`);
  }

  const data = await resp.json() as Record<string, unknown>;

  // npm returns full metadata; get the latest version
  const distTags = data['dist-tags'] as Record<string, string> | undefined;
  const latestVersion = distTags?.latest;

  if (!latestVersion) {
    throw new NpmInstallError('PACKAGE_NOT_FOUND', `Package "${packageName}" has no published versions`);
  }

  const versions = data.versions as Record<string, Record<string, unknown>> | undefined;
  const versionData = versions?.[latestVersion];

  if (!versionData) {
    throw new NpmInstallError('PACKAGE_NOT_FOUND', `Version "${latestVersion}" metadata not found`);
  }

  const dist = versionData.dist as { tarball?: string } | undefined;
  if (!dist?.tarball) {
    throw new NpmInstallError('PACKAGE_NOT_FOUND', `No tarball URL found for "${packageName}@${latestVersion}"`);
  }

  return {
    name: packageName,
    version: latestVersion,
    description: (versionData.description as string) ?? '',
    tarballUrl: dist.tarball,
  };
}

// ── Download & Extract ─────────────────────────────────────────────

async function downloadTarball(url: string): Promise<Uint8Array> {
  let resp: Response;
  try {
    resp = await fetch(url, { method: 'GET' });
  } catch (err) {
    throw new NpmInstallError('NETWORK_ERROR', `Failed to download tarball: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!resp.ok) {
    throw new NpmInstallError('NETWORK_ERROR', `Tarball download failed: ${resp.status}`);
  }

  const buffer = await resp.arrayBuffer();
  if (buffer.byteLength > MAX_TARBALL_SIZE) {
    throw new NpmInstallError('TARBALL_TOO_LARGE', `Tarball exceeds ${MAX_TARBALL_SIZE / 1024 / 1024}MB limit`);
  }

  return new Uint8Array(buffer);
}

function extractTarball(tgzBytes: Uint8Array): TarEntry[] {
  let tarBytes: Uint8Array;
  try {
    tarBytes = gunzipSync(tgzBytes);
  } catch {
    throw new NpmInstallError('EXTRACT_FAILED', 'Failed to decompress .tgz file');
  }
  return parseTar(tarBytes);
}

// ── Minimal tar parser ─────────────────────────────────────────────

function parseTar(tarBytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  const decoder = new TextDecoder();
  let offset = 0;

  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);

    // End of archive: two consecutive 512-byte blocks of zeros
    if (header.every(b => b === 0)) break;

    // File name (bytes 0-99)
    const name = decodeString(decoder, header, 0, 100);
    // File size in octal (bytes 124-135)
    const size = parseOctal(header, 124, 12);
    // Type flag (byte 156): '0' or '\0' = regular file, '5' = directory
    const typeFlag = header[156];
    // UStar prefix (bytes 345-499) for long paths
    const prefix = decodeString(decoder, header, 345, 155);

    const fullPath = prefix ? `${prefix}/${name}` : name;

    offset += 512; // past header

    // Only collect regular files
    if (typeFlag === 0x30 || typeFlag === 0) {
      entries.push({
        path: fullPath,
        data: tarBytes.slice(offset, offset + size),
      });
    }

    // Advance past data blocks (padded to 512-byte boundary)
    offset += Math.ceil(size / 512) * 512;
  }

  return entries;
}

function decodeString(decoder: TextDecoder, buf: Uint8Array, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nullIdx = slice.indexOf(0);
  return decoder.decode(nullIdx >= 0 ? slice.subarray(0, nullIdx) : slice).trim();
}

function parseOctal(buf: Uint8Array, start: number, length: number): number {
  const decoder = new TextDecoder();
  const str = decoder.decode(buf.subarray(start, start + length)).trim().replace(/\0/g, '');
  return parseInt(str, 8) || 0;
}

// ── Skill detection ────────────────────────────────────────────────

interface SkillLocation {
  skillMdEntry: TarEntry;
  /** Prefix to strip from all entries belonging to this skill (e.g. "package/" or "package/skills/cooper/") */
  prefix: string;
}

/**
 * Find SKILL.md files in tar entries and determine their prefix.
 * npm tarballs always have a "package/" root prefix.
 *
 * Supported layouts:
 *   package/SKILL.md                      → prefix = "package/"
 *   package/skills/cooper/SKILL.md        → prefix = "package/skills/cooper/"
 *   package/cooper/SKILL.md               → prefix = "package/cooper/"
 */
function findSkillEntries(entries: TarEntry[]): SkillLocation[] {
  const results: SkillLocation[] = [];

  for (const entry of entries) {
    if (!entry.path.endsWith('SKILL.md')) continue;

    const prefix = entry.path.replace(/SKILL\.md$/, '');
    results.push({ skillMdEntry: entry, prefix });
  }

  // Prefer the shallowest SKILL.md (closest to root)
  results.sort((a, b) => a.prefix.split('/').length - b.prefix.split('/').length);

  return results;
}

function stripPrefix(path: string, prefix: string): string {
  if (prefix && path.startsWith(prefix)) {
    return path.slice(prefix.length);
  }
  return path;
}

// ── Helpers ────────────────────────────────────────────────────────

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
