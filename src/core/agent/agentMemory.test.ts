import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Tauri APIs before importing the module
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn().mockResolvedValue('/mock/home'),
}));

vi.mock('../../utils/pathUtils', () => ({
  joinPath: (...parts: string[]) => parts.join('/'),
  ensureParentDir: vi.fn(),
}));

import { posix } from 'node:path';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { ensureParentDir } from '../../utils/pathUtils';
import {
  loadAgentMemory,
  saveAgentMemory,
  appendAgentMemory,
  clearAgentMemory,
  loadProjectMemory,
  saveProjectMemory,
  appendProjectMemory,
  clearProjectMemory,
} from './agentMemory';

const mockReadTextFile = vi.mocked(readTextFile);
const mockWriteTextFile = vi.mocked(writeTextFile);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadAgentMemory', () => {
  it('returns empty string when no memory exists', async () => {
    mockReadTextFile.mockRejectedValue(new Error('not found'));
    const result = await loadAgentMemory('abu');
    expect(result).toBe('');
  });

  it('returns content when memory exists', async () => {
    mockReadTextFile.mockResolvedValue('# Memories\n- User prefers dark mode');
    const result = await loadAgentMemory('abu');
    expect(result).toBe('# Memories\n- User prefers dark mode');
  });

  it('truncates at paragraph boundary when exceeding limit', async () => {
    const para1 = '# Section 1\n' + 'a'.repeat(3000);
    const para2 = '# Section 2\n' + 'b'.repeat(2000);
    const content = para1 + '\n\n' + para2;
    mockReadTextFile.mockResolvedValue(content);

    const result = await loadAgentMemory('abu');
    expect(result).toContain('WARNING: Memory truncated');
    expect(result).toContain('limit 4000');
    // Should cut at paragraph boundary, preserving para1 intact
    expect(result).toContain(para1);
    expect(result).not.toContain(para2);
  });

  it('falls back to hard cut when no paragraph boundary in range', async () => {
    const content = 'x'.repeat(5000); // No \n\n anywhere
    mockReadTextFile.mockResolvedValue(content);

    const result = await loadAgentMemory('abu');
    expect(result).toContain('WARNING: Memory truncated');
    expect(result.length).toBeLessThan(5000);
  });

  it('does not truncate content within limit', async () => {
    const content = 'short memory';
    mockReadTextFile.mockResolvedValue(content);
    const result = await loadAgentMemory('abu');
    expect(result).toBe('short memory');
    expect(result).not.toContain('WARNING');
  });
});

describe('saveAgentMemory', () => {
  it('writes to correct path', async () => {
    mockWriteTextFile.mockResolvedValue(undefined);
    await saveAgentMemory('abu', 'test content');
    expect(mockWriteTextFile).toHaveBeenCalledWith(
      '/mock/home/.abu/agents/abu/memory.md',
      'test content'
    );
  });

  it('truncates content exceeding limit on save and returns wasTruncated', async () => {
    mockWriteTextFile.mockResolvedValue(undefined);
    const longContent = 'x'.repeat(5000);
    const result = await saveAgentMemory('abu', longContent);
    expect(result.wasTruncated).toBe(true);
    const savedContent = mockWriteTextFile.mock.calls[0][1] as string;
    expect(savedContent).toContain('WARNING: Memory truncated');
  });

  it('returns wasTruncated false when within limit', async () => {
    mockWriteTextFile.mockResolvedValue(undefined);
    const result = await saveAgentMemory('abu', 'short');
    expect(result.wasTruncated).toBe(false);
  });
});

describe('appendAgentMemory', () => {
  it('appends to existing memory', async () => {
    mockReadTextFile.mockResolvedValue('existing');
    mockWriteTextFile.mockResolvedValue(undefined);
    const result = await appendAgentMemory('abu', 'new stuff');
    expect(result).toBe('existing\n\nnew stuff');
  });

  it('creates new memory when none exists', async () => {
    mockReadTextFile.mockRejectedValue(new Error('not found'));
    mockWriteTextFile.mockResolvedValue(undefined);
    const result = await appendAgentMemory('abu', 'first memory');
    expect(result).toBe('first memory');
  });
});

describe('clearAgentMemory', () => {
  it('writes empty string', async () => {
    mockWriteTextFile.mockResolvedValue(undefined);
    await clearAgentMemory('abu');
    expect(mockWriteTextFile).toHaveBeenCalledWith(
      expect.stringContaining('abu/memory.md'),
      ''
    );
  });
});

/**
 * The agent name is the folder under `~/.abu/agents/`. `joinPath` does not
 * collapse `..` (the mock above joins the same way) and the host resolves it,
 * so a name that is not one plain segment would read or write outside that
 * folder. Such a name never reaches the file system.
 */
describe('agent memory — the name is one path segment', () => {
  const mockEnsureParentDir = vi.mocked(ensureParentDir);

  it.each(['../../evil', '..', '.', '', ' ', 'a/b', '/etc', '..\\..\\evil', 'evil\u0000name', 'evil\u0085name'])(
    'refuses %j without touching the file system',
    async (name) => {
      mockReadTextFile.mockResolvedValue('existing');
      await expect(saveAgentMemory(name, 'x')).rejects.toThrow();
      await expect(appendAgentMemory(name, 'x')).rejects.toThrow();
      await expect(clearAgentMemory(name)).rejects.toThrow();
      expect(await loadAgentMemory(name)).toBe('');
      expect(mockReadTextFile).not.toHaveBeenCalled();
      expect(mockWriteTextFile).not.toHaveBeenCalled();
      expect(mockEnsureParentDir).not.toHaveBeenCalled();
    },
  );

  it.each(['abu', 'HR 招聘官', '产品经理', 'code-reviewer', 'skill.v2'])(
    'writes %j only to ~/.abu/agents/<name>/memory.md',
    async (name) => {
      mockReadTextFile.mockResolvedValue('existing');
      mockWriteTextFile.mockResolvedValue(undefined);
      await saveAgentMemory(name, 'x');
      await appendAgentMemory(name, 'y');
      await clearAgentMemory(name);
      const expected = `/mock/home/.abu/agents/${name}/memory.md`;
      const written = [
        ...mockWriteTextFile.mock.calls.map((call) => String(call[0])),
        ...mockEnsureParentDir.mock.calls.map((call) => call[0]),
      ];
      expect(written).toHaveLength(6);
      for (const path of written) expect(posix.resolve(path)).toBe(expected);
    },
  );
});

describe('loadProjectMemory', () => {
  it('returns empty string when no memory exists', async () => {
    mockReadTextFile.mockRejectedValue(new Error('not found'));
    const result = await loadProjectMemory('/workspace');
    expect(result).toBe('');
  });

  it('truncates at paragraph boundary when exceeding 8000 chars', async () => {
    const para1 = '# Tech Stack\n' + 'a'.repeat(7000);
    const para2 = '# API Docs\n' + 'b'.repeat(3000);
    const content = para1 + '\n\n' + para2;
    mockReadTextFile.mockResolvedValue(content);

    const result = await loadProjectMemory('/workspace');
    expect(result).toContain('WARNING: Project memory truncated');
    expect(result).toContain('limit 8000');
    expect(result).toContain(para1);
    expect(result).not.toContain(para2);
  });
});

describe('saveProjectMemory', () => {
  it('writes to workspace path', async () => {
    mockWriteTextFile.mockResolvedValue(undefined);
    await saveProjectMemory('/workspace', 'project info');
    expect(mockWriteTextFile).toHaveBeenCalledWith(
      '/workspace/.abu/MEMORY.md',
      'project info'
    );
  });
});

describe('appendProjectMemory', () => {
  it('appends to existing project memory', async () => {
    mockReadTextFile.mockResolvedValue('existing project info');
    mockWriteTextFile.mockResolvedValue(undefined);
    const result = await appendProjectMemory('/workspace', 'new info');
    expect(result).toBe('existing project info\n\nnew info');
  });
});

describe('clearProjectMemory', () => {
  it('writes empty string', async () => {
    mockWriteTextFile.mockResolvedValue(undefined);
    await clearProjectMemory('/workspace');
    expect(mockWriteTextFile).toHaveBeenCalledWith(
      '/workspace/.abu/MEMORY.md',
      ''
    );
  });
});
