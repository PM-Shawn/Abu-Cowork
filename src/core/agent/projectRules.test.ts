import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Tauri APIs before importing the module
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  readDir: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn().mockResolvedValue('/mock/home'),
}));

vi.mock('../../utils/pathUtils', () => ({
  joinPath: (...parts: string[]) => parts.join('/'),
  ensureParentDir: vi.fn(),
}));

import { readTextFile, readDir, exists, mkdir, writeTextFile } from '@tauri-apps/plugin-fs';
import {
  loadUserRules,
  loadProjectRules,
  loadModularRules,
  loadAllRules,
  initWorkspaceRules,
} from './projectRules';

const mockReadTextFile = vi.mocked(readTextFile);
const mockReadDir = vi.mocked(readDir);
const mockExists = vi.mocked(exists);
const mockMkdir = vi.mocked(mkdir);
const mockWriteTextFile = vi.mocked(writeTextFile);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadUserRules', () => {
  it('returns empty string when file does not exist', async () => {
    mockReadTextFile.mockRejectedValue(new Error('not found'));
    const result = await loadUserRules();
    expect(result).toBe('');
  });

  it('returns content when file exists', async () => {
    mockReadTextFile.mockResolvedValue('# My Rules\nUse TypeScript.');
    const result = await loadUserRules();
    expect(result).toBe('# My Rules\nUse TypeScript.');
  });

  it('truncates content exceeding 4000 chars', async () => {
    const longContent = 'x'.repeat(5000);
    mockReadTextFile.mockResolvedValue(longContent);
    const result = await loadUserRules();
    expect(result.length).toBeLessThan(5000);
    expect(result).toContain('用户规则已截断');
    // Should be 4000 chars + truncation message
    expect(result.startsWith('x'.repeat(4000))).toBe(true);
  });
});

describe('loadProjectRules', () => {
  it('returns empty string when file does not exist', async () => {
    mockReadTextFile.mockRejectedValue(new Error('not found'));
    const result = await loadProjectRules('/workspace');
    expect(result).toBe('');
  });

  it('reads from correct path', async () => {
    mockReadTextFile.mockResolvedValue('project rules');
    const result = await loadProjectRules('/workspace');
    expect(result).toBe('project rules');
    expect(mockReadTextFile).toHaveBeenCalledWith('/workspace/.abu/ABU.md');
  });
});

describe('loadModularRules', () => {
  it('returns empty when rules dir does not exist', async () => {
    mockExists.mockResolvedValue(false);
    const result = await loadModularRules('/workspace');
    expect(result).toBe('');
  });

  it('loads and sorts .md files alphabetically', async () => {
    mockExists.mockResolvedValue(true);
    mockReadDir.mockResolvedValue([
      { name: 'coding-style.md', isDirectory: false, isFile: true, isSymlink: false },
      { name: 'api-conventions.md', isDirectory: false, isFile: true, isSymlink: false },
      { name: 'not-md.txt', isDirectory: false, isFile: true, isSymlink: false },
      { name: 'subdir', isDirectory: true, isFile: false, isSymlink: false },
    ]);
    mockReadTextFile.mockImplementation(async (path: string) => {
      if (path.includes('api-conventions')) return 'API rules here';
      if (path.includes('coding-style')) return 'Coding rules here';
      return '';
    });

    const result = await loadModularRules('/workspace');
    // api-conventions comes before coding-style alphabetically
    expect(result).toContain('### api-conventions.md');
    expect(result).toContain('### coding-style.md');
    expect(result).not.toContain('not-md.txt');
    expect(result).not.toContain('subdir');
    // Verify alphabetical order
    const apiIdx = result.indexOf('api-conventions');
    const codingIdx = result.indexOf('coding-style');
    expect(apiIdx).toBeLessThan(codingIdx);
  });

  it('limits to MAX_RULE_FILES (20)', async () => {
    mockExists.mockResolvedValue(true);
    const entries = Array.from({ length: 25 }, (_, i) => ({
      name: `rule-${String(i).padStart(2, '0')}.md`,
      isDirectory: false,
      isFile: true,
      isSymlink: false,
    }));
    mockReadDir.mockResolvedValue(entries);
    mockReadTextFile.mockResolvedValue('content');

    await loadModularRules('/workspace');
    // readTextFile should be called for 20 files max (the rules dir readDir doesn't use readTextFile)
    expect(mockReadTextFile).toHaveBeenCalledTimes(20);
  });
});

describe('loadAllRules', () => {
  it('returns empty string when no rules exist', async () => {
    mockReadTextFile.mockRejectedValue(new Error('not found'));
    mockExists.mockResolvedValue(false);
    const result = await loadAllRules('/workspace');
    expect(result).toBe('');
  });

  it('combines user and project rules', async () => {
    // First call = user rules, second call = project rules
    mockReadTextFile.mockImplementation(async (path: string) => {
      if (path.includes('/mock/home/')) return 'user rules';
      if (path.includes('ABU.md')) return 'project rules';
      return '';
    });
    mockExists.mockResolvedValue(false); // no modular rules dir

    const result = await loadAllRules('/workspace');
    expect(result).toContain('用户规则');
    expect(result).toContain('user rules');
    expect(result).toContain('项目规则');
    expect(result).toContain('project rules');
  });

  it('returns only user rules when workspacePath is null', async () => {
    mockReadTextFile.mockResolvedValue('user rules');
    const result = await loadAllRules(null);
    expect(result).toContain('user rules');
    expect(result).not.toContain('项目规则（.abu/ABU.md）');
  });

  it('truncates when total exceeds budget', async () => {
    const longUserRules = 'u'.repeat(4000);
    const longProjectRules = 'p'.repeat(8000);
    mockReadTextFile.mockImplementation(async (path: string) => {
      if (path.includes('/mock/home/')) return longUserRules;
      if (path.includes('ABU.md')) return longProjectRules;
      return '';
    });
    mockExists.mockResolvedValue(false);

    const result = await loadAllRules('/workspace');
    // Total budget is 4000 + 8000 = 12000, but with headers it'll exceed
    // The result should be truncated
    expect(result.length).toBeLessThanOrEqual(12000 + 100); // some slack for truncation msg
  });
});

describe('initWorkspaceRules', () => {
  it('returns message when ABU.md already exists', async () => {
    mockExists.mockResolvedValue(true);
    const result = await initWorkspaceRules('/workspace');
    expect(result).toContain('已存在');
  });

  it('creates template and rules directory', async () => {
    // First exists check (ABU.md) = false, rest = false
    mockExists.mockResolvedValue(false);
    mockMkdir.mockResolvedValue(undefined);
    mockWriteTextFile.mockResolvedValue(undefined);

    const result = await initWorkspaceRules('/workspace');
    expect(result).toContain('创建了');
    expect(mockWriteTextFile).toHaveBeenCalledWith(
      '/workspace/.abu/ABU.md',
      expect.stringContaining('# 项目规则')
    );
    expect(mockMkdir).toHaveBeenCalled();
  });
});
