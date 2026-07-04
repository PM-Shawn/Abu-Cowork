import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  readTextFile,
  readDir,
  readFile,
  writeFile,
  exists,
  remove,
  rename,
} from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';

// ── Mocks ──────────────────────────────────────────────────────────
// Fully mock plugin-fs so we can drive a fake source filesystem.
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  readDir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(false),
  remove: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

// Enterprise policy: default to allow everything.
vi.mock('@/core/enterprise/policy/enforcer', () => ({
  getCurrentPolicy: vi.fn().mockReturnValue({}),
}));
vi.mock('@/core/enterprise/policy/matcher', () => ({
  checkSkill: vi.fn().mockReturnValue({ decision: 'allow' }),
}));

import { installSkillFromFolder } from './installer';

const mockReadTextFile = vi.mocked(readTextFile);
const mockReadDir = vi.mocked(readDir);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockExists = vi.mocked(exists);
const mockRemove = vi.mocked(remove);
const mockRename = vi.mocked(rename);
const mockHomeDir = vi.mocked(homeDir);

const SKILL_MD = '---\nname: dj-data-agent\ndescription: a skill\n---\n# body';

type FakeEntry = { name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean };
function dir(name: string): FakeEntry {
  return { name, isDirectory: true, isFile: false, isSymlink: false };
}
function file(name: string): FakeEntry {
  return { name, isDirectory: false, isFile: true, isSymlink: false };
}

const SRC = '/Users/test/Desktop/dj_semantic/dj-data-agent';

/**
 * Fake source tree mirroring the real dj-data-agent folder:
 *   .DS_Store, .mcp.json, .claude/, SKILL.md, references/*, scripts/*
 */
function installFakeSourceTree() {
  const tree: Record<string, FakeEntry[]> = {
    [SRC]: [
      file('.DS_Store'),
      file('.mcp.json'),
      dir('.claude'),
      file('SKILL.md'),
      dir('references'),
      dir('scripts'),
    ],
    [`${SRC}/.claude`]: [file('settings.local.json')],
    // nested .DS_Store: must be skipped but NOT reported (top-level names only)
    [`${SRC}/references`]: [file('cooper-guide.md'), file('dclaw-mcp-tools.md'), file('.DS_Store')],
    [`${SRC}/scripts`]: [file('poll.sh')],
  };
  mockReadDir.mockImplementation(async (p: string | URL) => {
    const key = String(p);
    return (tree[key] ?? []) as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHomeDir.mockResolvedValue('/Users/test');
  mockReadTextFile.mockResolvedValue(SKILL_MD);
  mockReadFile.mockResolvedValue(new Uint8Array([1, 2, 3]) as never);
  mockWriteFile.mockResolvedValue(undefined as never);
  mockRemove.mockResolvedValue(undefined as never);
  mockRename.mockResolvedValue(undefined as never);
  // Default: nothing exists except SKILL.md (validated first)
  mockExists.mockImplementation(async (p: string | URL) => String(p).endsWith('/SKILL.md'));
});

describe('installSkillFromFolder', () => {
  describe('dotfile tolerance (bug A)', () => {
    it('skips dotfiles/dotdirs instead of aborting the whole install', async () => {
      installFakeSourceTree();
      const result = await installSkillFromFolder(SRC);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Only TOP-LEVEL dotfiles are reported — the nested references/.DS_Store is
      // skipped from the copy but NOT added to the list (no duplicate ".DS_Store").
      expect(result.skipped.slice().sort()).toEqual(['.DS_Store', '.claude', '.mcp.json']);
      // Only the 4 real files (SKILL.md + 2 references + 1 script) get copied
      expect(result.fileCount).toBe(4);
    });

    it('never attempts to read a dotfile (Tauri scope would throw "forbidden path")', async () => {
      installFakeSourceTree();
      await installSkillFromFolder(SRC);
      const readPaths = mockReadFile.mock.calls.map((c) => String(c[0]));
      expect(readPaths.some((p) => p.endsWith('.mcp.json'))).toBe(false);
      expect(readPaths.some((p) => p.endsWith('.DS_Store'))).toBe(false);
    });

    it('does NOT abort even if a dotfile read would throw', async () => {
      installFakeSourceTree();
      // Simulate the real Tauri behavior: reading a dotfile throws "forbidden path".
      mockReadFile.mockImplementation(async (p: string | URL) => {
        if (String(p).includes('/.')) throw new Error(`forbidden path: ${String(p)}`);
        return new Uint8Array([1, 2, 3]) as never;
      });
      const result = await installSkillFromFolder(SRC);
      expect(result.ok).toBe(true);
    });
  });

  describe('atomic install (bug B)', () => {
    it('copies into a staging dir then renames into place', async () => {
      installFakeSourceTree();
      const result = await installSkillFromFolder(SRC);
      expect(result.ok).toBe(true);
      // rename staging -> final target
      const renameCall = mockRename.mock.calls[0];
      expect(String(renameCall[0])).toContain('/.abu/skill-staging/dj-data-agent');
      expect(String(renameCall[1])).toContain('/.abu/skills/dj-data-agent');
    });

    it('cleans up the staging dir and leaves NO partial target when copy fails', async () => {
      installFakeSourceTree();
      // A real (non-dot) content file fails mid-copy.
      mockReadFile.mockImplementation(async (p: string | URL) => {
        if (String(p).endsWith('poll.sh')) throw new Error('disk error');
        return new Uint8Array([1, 2, 3]) as never;
      });
      const result = await installSkillFromFolder(SRC);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('COPY_FAILED');
      // staging got cleaned up
      const removed = mockRemove.mock.calls.map((c) => String(c[0]));
      expect(removed.some((p) => p.includes('/.abu/skill-staging/dj-data-agent'))).toBe(true);
      // never renamed anything into the real skills dir
      expect(mockRename).not.toHaveBeenCalled();
    });
  });

  describe('overwrite / already-exists', () => {
    it('returns ALREADY_EXISTS when target exists and overwrite is not set', async () => {
      installFakeSourceTree();
      mockExists.mockImplementation(
        async (p: string | URL) =>
          String(p).endsWith('/SKILL.md') || String(p).endsWith('/.abu/skills/dj-data-agent'),
      );
      const result = await installSkillFromFolder(SRC);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('ALREADY_EXISTS');
    });

    it('replaces the existing target when overwrite=true (moves old aside, does NOT delete it before the swap)', async () => {
      installFakeSourceTree();
      mockExists.mockImplementation(
        async (p: string | URL) =>
          String(p).endsWith('/SKILL.md') || String(p).endsWith('/.abu/skills/dj-data-agent'),
      );
      const result = await installSkillFromFolder(SRC, { overwrite: true });
      expect(result.ok).toBe(true);

      const renames = mockRename.mock.calls.map((c) => [String(c[0]), String(c[1])]);
      // 1) existing target moved aside to backup (NOT removed outright)
      expect(renames).toContainEqual([
        expect.stringContaining('/.abu/skills/dj-data-agent'),
        expect.stringContaining('/.abu/skill-staging/__backup__dj-data-agent'),
      ]);
      // 2) staging swapped into place
      expect(renames).toContainEqual([
        expect.stringContaining('/.abu/skill-staging/dj-data-agent'),
        expect.stringContaining('/.abu/skills/dj-data-agent'),
      ]);
      // the live target is never removed before the swap — only the backup is dropped after
      const removed = mockRemove.mock.calls.map((c) => String(c[0]));
      expect(removed.some((p) => p.endsWith('/.abu/skills/dj-data-agent'))).toBe(false);
    });

    it('restores the original skill if the swap rename fails on overwrite (no data loss)', async () => {
      installFakeSourceTree();
      mockExists.mockImplementation(
        async (p: string | URL) =>
          String(p).endsWith('/SKILL.md') || String(p).endsWith('/.abu/skills/dj-data-agent'),
      );
      // Fail ONLY the staging→target swap; the backup move and restore succeed.
      mockRename.mockImplementation(async (from: string | URL, to: string | URL) => {
        if (String(from).includes('/skill-staging/dj-data-agent') && String(to).endsWith('/.abu/skills/dj-data-agent')) {
          throw new Error('swap failed');
        }
        return undefined as never;
      });
      const result = await installSkillFromFolder(SRC, { overwrite: true });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('COPY_FAILED');
      // backup restored back to the live target
      const renames = mockRename.mock.calls.map((c) => [String(c[0]), String(c[1])]);
      expect(renames).toContainEqual([
        expect.stringContaining('/.abu/skill-staging/__backup__dj-data-agent'),
        expect.stringContaining('/.abu/skills/dj-data-agent'),
      ]);
    });
  });

  describe('validation (unchanged)', () => {
    it('fails with NO_SKILL_MD when SKILL.md is absent', async () => {
      mockExists.mockResolvedValue(false);
      const result = await installSkillFromFolder(SRC);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('NO_SKILL_MD');
    });

    it('fails with NO_NAME when frontmatter has no name', async () => {
      mockReadTextFile.mockResolvedValue('---\ndescription: no name here\n---\n# body');
      const result = await installSkillFromFolder(SRC);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('NO_NAME');
    });
  });
});
