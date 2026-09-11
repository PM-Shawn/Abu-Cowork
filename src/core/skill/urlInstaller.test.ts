import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exists, mkdir, writeFile, remove, rename } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('@tauri-apps/plugin-fs', async () => {
  const actual = await vi.importActual<typeof import('@tauri-apps/plugin-fs')>(
    '@tauri-apps/plugin-fs',
  );
  return {
    ...actual,
    exists: vi.fn().mockResolvedValue(false),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('fflate', () => ({
  unzipSync: vi.fn(),
  strFromU8: vi.fn(),
}));

// Keep NpmInstallError real (used for throws); mock only I/O functions.
vi.mock('./npmInstaller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./npmInstaller')>();
  return {
    ...actual,
    downloadTarball: vi.fn(),
    extractTarball: vi.fn().mockReturnValue([]),
    findSkillEntries: vi.fn(),
  };
});

// The organization's skill blacklist hook: allows everything but one name.
vi.mock('@/core/enterprise/policy/matcher', () => ({
  checkSkill: vi.fn((_policy: unknown, name: string) =>
    name === 'blocked-skill' ? { decision: 'deny', reason: 'blocked by policy' } : { decision: 'allow' }),
}));

import { unzipSync, strFromU8 } from 'fflate';
import { downloadTarball, extractTarball, findSkillEntries } from './npmInstaller';
import { detectSourceType, installSkillFromUrl } from './urlInstaller';
import { SkillPolicyDeniedError } from './skillPolicy';

const mockExists = vi.mocked(exists);
const mockMkdir = vi.mocked(mkdir);
const mockWriteFile = vi.mocked(writeFile);
const mockRemove = vi.mocked(remove);
const mockRename = vi.mocked(rename);
const mockHomeDir = vi.mocked(homeDir);

const mockDownloadTarball = vi.mocked(downloadTarball);
const mockExtractTarball = vi.mocked(extractTarball);
const mockFindSkillEntries = vi.mocked(findSkillEntries);
const mockUnzipSync = vi.mocked(unzipSync);
const mockStrFromU8 = vi.mocked(strFromU8);

// ── A disk small enough to assert against ──────────────────────────
//
// The claim under test is about WHERE bytes land and WHEN, so the mocks have
// to remember: `exists` must see what a previous call wrote, and a rename must
// move it. A per-call `toHaveBeenCalledWith` cannot express "the live skills
// directory was never touched".

const SKILLS_ROOT = '/Users/test/.abu/skills';

const disk = { dirs: new Set<string>(), files: new Map<string, Uint8Array>() };

function underPrefix(prefix: string): string[] {
  const inside = (p: string) => p === prefix || p.startsWith(`${prefix}/`);
  return [...disk.dirs, ...disk.files.keys()].filter(inside).sort();
}

/** Everything that currently exists inside `~/.abu/skills`. */
function liveEntries(): string[] {
  return underPrefix(SKILLS_ROOT).filter((p) => p !== SKILLS_ROOT);
}

function useFakeDisk() {
  disk.dirs.clear();
  disk.files.clear();
  mockMkdir.mockImplementation(async (p: string | URL) => {
    disk.dirs.add(String(p));
    return undefined as never;
  });
  mockWriteFile.mockImplementation(async (p: string | URL, data) => {
    disk.files.set(String(p), data as Uint8Array);
    return undefined as never;
  });
  mockExists.mockImplementation(async (p: string | URL) => underPrefix(String(p)).length > 0);
  mockRemove.mockImplementation(async (p: string | URL) => {
    for (const gone of underPrefix(String(p))) {
      disk.dirs.delete(gone);
      disk.files.delete(gone);
    }
    return undefined as never;
  });
  mockRename.mockImplementation(async (from: string | URL, to: string | URL) => {
    const [a, b] = [String(from), String(to)];
    for (const p of underPrefix(a)) {
      const moved = b + p.slice(a.length);
      const bytes = disk.files.get(p);
      if (bytes) {
        disk.files.set(moved, bytes);
        disk.files.delete(p);
      } else {
        disk.dirs.delete(p);
        disk.dirs.add(moved);
      }
    }
    return undefined as never;
  });
}

const SKILL_MD = '---\nname: my-skill\ndescription: a skill\n---\n# body';
const SKILL_MD_BYTES = new Uint8Array([1, 2, 3]);
const DUMMY_BYTES = new Uint8Array([9, 9, 9]);

const SKILL_LOC = {
  skillMdEntry: { path: 'my-skill-main/SKILL.md', data: SKILL_MD_BYTES },
  prefix: 'my-skill-main/',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockHomeDir.mockResolvedValue('/Users/test');
  mockExists.mockResolvedValue(false);
  mockDownloadTarball.mockResolvedValue(DUMMY_BYTES);
  mockStrFromU8.mockReturnValue(SKILL_MD);
  mockFindSkillEntries.mockReturnValue([SKILL_LOC]);
});

// ── detectSourceType ────────────────────────────────────────────────

describe('detectSourceType', () => {
  it.each([
    ['/abs/path/to/skill', 'folder'],
    ['~/Downloads/skill', 'folder'],
    ['./relative', 'folder'],
    ['../sibling', 'folder'],
    ['https://github.com/user/repo', 'url'],
    ['http://10.0.0.1:8080/skill.tgz', 'url'],
    ['cooper', 'npm'],
    ['@scope/my-skill', 'npm'],
    ['some-skill-pkg', 'npm'],
  ] as const)('"%s" → %s', (source, expected) => {
    expect(detectSourceType(source)).toBe(expected);
  });
});

// ── installSkillFromUrl ─────────────────────────────────────────────

describe('installSkillFromUrl', () => {
  describe('GitHub URL normalisation', () => {
    it('converts bare repo URL to main.zip archive URL', async () => {
      mockUnzipSync.mockReturnValue({ 'my-skill-main/SKILL.md': SKILL_MD_BYTES });

      await installSkillFromUrl('https://github.com/user/my-skill');

      expect(mockDownloadTarball).toHaveBeenCalledWith(
        'https://github.com/user/my-skill/archive/refs/heads/main.zip',
      );
    });

    it('respects explicit branch in /tree/ URL', async () => {
      mockUnzipSync.mockReturnValue({ 'my-skill-feat/SKILL.md': SKILL_MD_BYTES });
      mockFindSkillEntries.mockReturnValue([{
        skillMdEntry: { path: 'my-skill-feat/SKILL.md', data: SKILL_MD_BYTES },
        prefix: 'my-skill-feat/',
      }]);

      await installSkillFromUrl('https://github.com/user/my-skill/tree/feat');

      expect(mockDownloadTarball).toHaveBeenCalledWith(
        'https://github.com/user/my-skill/archive/refs/heads/feat.zip',
      );
    });
  });

  describe('zip path (GitHub / .zip URL)', () => {
    beforeEach(() => {
      mockUnzipSync.mockReturnValue({
        'my-skill-main/SKILL.md': SKILL_MD_BYTES,
        'my-skill-main/README.md': new Uint8Array([7]),
      });
    });

    it('returns correct skillName and targetDir', async () => {
      const result = await installSkillFromUrl('https://github.com/user/my-skill');

      expect(result.skillName).toBe('my-skill');
      expect(result.targetDir).toBe('/Users/test/.abu/skills/my-skill');
    });

    it('creates target directory and writes files', async () => {
      useFakeDisk();

      await installSkillFromUrl('https://github.com/user/my-skill');

      expect(liveEntries()).toEqual([
        `${SKILLS_ROOT}/my-skill`,
        `${SKILLS_ROOT}/my-skill/README.md`,
        `${SKILLS_ROOT}/my-skill/SKILL.md`,
      ]);
    });

    it('uses extractTarball for .tgz URL', async () => {
      const tgzEntries = [{ path: 'package/SKILL.md', data: SKILL_MD_BYTES }];
      mockExtractTarball.mockReturnValue(tgzEntries);
      mockFindSkillEntries.mockReturnValue([{
        skillMdEntry: { path: 'package/SKILL.md', data: SKILL_MD_BYTES },
        prefix: 'package/',
      }]);

      await installSkillFromUrl('http://example.com/my-skill.tgz');

      expect(mockExtractTarball).toHaveBeenCalledWith(DUMMY_BYTES);
      expect(mockUnzipSync).not.toHaveBeenCalled();
    });
  });

  describe('error cases', () => {
    it('throws ALREADY_EXISTS when skill exists and overwrite not set', async () => {
      mockExists.mockResolvedValue(true);
      mockUnzipSync.mockReturnValue({ 'root/SKILL.md': SKILL_MD_BYTES });

      await expect(installSkillFromUrl('https://github.com/user/my-skill')).rejects.toMatchObject({
        code: 'ALREADY_EXISTS',
      });
    });

    it('allows overwrite when option is set', async () => {
      mockExists.mockResolvedValue(true);
      mockUnzipSync.mockReturnValue({ 'root/SKILL.md': SKILL_MD_BYTES });

      await expect(
        installSkillFromUrl('https://github.com/user/my-skill', { overwrite: true }),
      ).resolves.toBeDefined();
    });

    it('throws NO_SKILL_MD when archive has no SKILL.md', async () => {
      mockFindSkillEntries.mockReturnValue([]);
      mockUnzipSync.mockReturnValue({ 'root/README.md': new Uint8Array([1]) });

      await expect(installSkillFromUrl('https://github.com/user/my-skill')).rejects.toMatchObject({
        code: 'NO_SKILL_MD',
      });
    });

    it('throws NO_NAME when SKILL.md has no name field', async () => {
      mockStrFromU8.mockReturnValue('---\ndescription: no name here\n---\n# body');
      mockUnzipSync.mockReturnValue({ 'root/SKILL.md': SKILL_MD_BYTES });

      await expect(installSkillFromUrl('https://github.com/user/my-skill')).rejects.toMatchObject({
        code: 'NO_NAME',
      });
    });

    it('rejects a frontmatter name that escapes the skills directory', async () => {
      // `~/.abu/skills/../../.ssh` resolves to `~/.ssh`, which the host's scope
      // guard allows: it only asks whether the resolved path is under an
      // allowed root. The entry-path check below does not see this — the name
      // is the segment those paths are written UNDER.
      mockStrFromU8.mockReturnValue('---\nname: ../../.ssh\n---\n# body');
      mockUnzipSync.mockReturnValue({ 'root/SKILL.md': SKILL_MD_BYTES });

      await expect(installSkillFromUrl('https://github.com/user/my-skill')).rejects.toMatchObject({
        code: 'PATH_TRAVERSAL',
      });
      expect(mockMkdir).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("refuses a skill name the organization's policy blocks, writing nothing", async () => {
      useFakeDisk();
      mockStrFromU8.mockReturnValue('---\nname: blocked-skill\n---\n# body');
      mockUnzipSync.mockReturnValue({ 'root/SKILL.md': SKILL_MD_BYTES });

      const err = await installSkillFromUrl('https://github.com/user/my-skill').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SkillPolicyDeniedError);
      expect((err as SkillPolicyDeniedError).skillName).toBe('blocked-skill');
      expect(mockMkdir).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(liveEntries()).toEqual([]);
    });

    it('refuses an archive whose second SKILL.md, differing only in case, would replace the checked one', async () => {
      // One file on APFS / NTFS: the entry written last is the manifest that
      // goes live, and it declares a name nobody checked.
      useFakeDisk();
      mockUnzipSync.mockReturnValue({ 'root/SKILL.md': SKILL_MD_BYTES, 'root/skill.md': DUMMY_BYTES });
      mockFindSkillEntries.mockReturnValue([{
        skillMdEntry: { path: 'root/SKILL.md', data: SKILL_MD_BYTES },
        prefix: 'root/',
      }]);

      await expect(installSkillFromUrl('https://github.com/user/my-skill')).rejects.toMatchObject({
        code: 'AMBIGUOUS_SKILL_MD',
      });
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(liveEntries()).toEqual([]);
    });

    it('rejects path traversal in zip entries', async () => {
      // findSkillEntries returns valid location, but one entry has .. in path
      mockUnzipSync.mockReturnValue({
        'root/SKILL.md': SKILL_MD_BYTES,
        'root/../etc/passwd': new Uint8Array([1]),
      });
      // Override findSkillEntries to return entries including the traversal
      mockFindSkillEntries.mockImplementation((entries) => {
        const skillEntry = entries.find((e) => e.path.endsWith('SKILL.md'));
        if (!skillEntry) return [];
        return [{ skillMdEntry: skillEntry, prefix: 'root/' }];
      });

      await expect(installSkillFromUrl('https://github.com/user/my-skill')).rejects.toMatchObject({
        code: 'PATH_TRAVERSAL',
      });
    });
  });
});

/**
 * A refusal must leave nothing behind — the URL twin of the npm case.
 *
 * `mkdir(targetDir)` ran before the per-entry traversal and size guards inside
 * the write loop, and those guards throw mid-loop with the entry order chosen
 * by whoever built the archive. `~/.abu/skills` is scanned as the `user` skill
 * source and watched for changes, so a refused archive's SKILL.md became a
 * live, model-visible skill under the ATTACKER's frontmatter name — and bricked
 * the honest retry with ALREADY_EXISTS.
 */
describe('installSkillFromUrl when it refuses an archive part-way through', () => {
  beforeEach(() => {
    useFakeDisk();
    // SKILL.md first, so the refusal happens with files already written.
    mockUnzipSync.mockReturnValue({
      'my-skill-main/SKILL.md': SKILL_MD_BYTES,
      'my-skill-main/payload.txt': new Uint8Array([7]),
      'my-skill-main/../../../.ssh/authorized_keys': new Uint8Array([8]),
    });
  });

  it('leaves no trace of an archive refused for path traversal', async () => {
    await expect(installSkillFromUrl('https://github.com/user/my-skill')).rejects.toMatchObject({
      code: 'PATH_TRAVERSAL',
    });

    expect(liveEntries()).toEqual([]);
  });

  it('does not brick the next honest install of the same name', async () => {
    await expect(installSkillFromUrl('https://github.com/user/my-skill')).rejects.toMatchObject({
      code: 'PATH_TRAVERSAL',
    });

    mockUnzipSync.mockReturnValue({ 'my-skill-main/SKILL.md': SKILL_MD_BYTES });
    const result = await installSkillFromUrl('https://github.com/user/my-skill');

    expect(result.skillName).toBe('my-skill');
    expect(liveEntries()).toEqual([
      `${SKILLS_ROOT}/my-skill`,
      `${SKILLS_ROOT}/my-skill/SKILL.md`,
    ]);
  });
});
