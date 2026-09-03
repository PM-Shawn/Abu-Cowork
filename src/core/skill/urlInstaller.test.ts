import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exists, mkdir, writeFile } from '@tauri-apps/plugin-fs';
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

import { unzipSync, strFromU8 } from 'fflate';
import { downloadTarball, extractTarball, findSkillEntries } from './npmInstaller';
import { detectSourceType, installSkillFromUrl } from './urlInstaller';

const mockExists = vi.mocked(exists);
const mockMkdir = vi.mocked(mkdir);
const mockWriteFile = vi.mocked(writeFile);
const mockHomeDir = vi.mocked(homeDir);
const mockDownloadTarball = vi.mocked(downloadTarball);
const mockExtractTarball = vi.mocked(extractTarball);
const mockFindSkillEntries = vi.mocked(findSkillEntries);
const mockUnzipSync = vi.mocked(unzipSync);
const mockStrFromU8 = vi.mocked(strFromU8);

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
      await installSkillFromUrl('https://github.com/user/my-skill');

      expect(mockMkdir).toHaveBeenCalledWith('/Users/test/.abu/skills/my-skill', { recursive: true });
      expect(mockWriteFile).toHaveBeenCalled();
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
