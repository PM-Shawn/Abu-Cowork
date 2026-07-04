import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  readTextFile,
  readDir,
  readFile,
  exists,
  remove,
  rename,
} from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';

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

import { installAgentFromFolder } from './installer';

const mockReadTextFile = vi.mocked(readTextFile);
const mockReadDir = vi.mocked(readDir);
const mockReadFile = vi.mocked(readFile);
const mockRemove = vi.mocked(remove);
const mockRename = vi.mocked(rename);
const mockExists = vi.mocked(exists);
const mockHomeDir = vi.mocked(homeDir);

const AGENT_MD = '---\nname: my-agent\ndescription: an agent\n---\n# body';

type FakeEntry = { name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean };
function dir(name: string): FakeEntry {
  return { name, isDirectory: true, isFile: false, isSymlink: false };
}
function file(name: string): FakeEntry {
  return { name, isDirectory: false, isFile: true, isSymlink: false };
}

const SRC = '/Users/test/Desktop/my-agent';

function installFakeSourceTree() {
  const tree: Record<string, FakeEntry[]> = {
    [SRC]: [file('.DS_Store'), file('.mcp.json'), dir('.claude'), file('AGENT.md'), dir('prompts')],
    [`${SRC}/.claude`]: [file('settings.json')],
    [`${SRC}/prompts`]: [file('system.md')],
  };
  mockReadDir.mockImplementation(async (p: string | URL) => (tree[String(p)] ?? []) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHomeDir.mockResolvedValue('/Users/test');
  mockReadTextFile.mockResolvedValue(AGENT_MD);
  mockReadFile.mockResolvedValue(new Uint8Array([1, 2, 3]) as never);
  mockRemove.mockResolvedValue(undefined as never);
  mockRename.mockResolvedValue(undefined as never);
  mockExists.mockImplementation(async (p: string | URL) => String(p).endsWith('/AGENT.md'));
});

describe('installAgentFromFolder', () => {
  it('skips dotfiles instead of aborting the install (twin of skill bug A)', async () => {
    installFakeSourceTree();
    const result = await installAgentFromFolder(SRC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped).toEqual(expect.arrayContaining(['.DS_Store', '.mcp.json', '.claude']));
    // AGENT.md + prompts/system.md = 2 real files
    expect(result.fileCount).toBe(2);
    const readPaths = mockReadFile.mock.calls.map((c) => String(c[0]));
    expect(readPaths.some((p) => p.endsWith('.mcp.json'))).toBe(false);
  });

  it('copies via staging then renames into place (atomic, bug B)', async () => {
    installFakeSourceTree();
    const result = await installAgentFromFolder(SRC);
    expect(result.ok).toBe(true);
    const [from, to] = mockRename.mock.calls[0];
    expect(String(from)).toContain('/.abu/agent-staging/my-agent');
    expect(String(to)).toContain('/.abu/agents/my-agent');
  });

  it('cleans up staging and never renames a partial target on failure', async () => {
    installFakeSourceTree();
    mockReadFile.mockImplementation(async (p: string | URL) => {
      if (String(p).endsWith('system.md')) throw new Error('disk error');
      return new Uint8Array([1, 2, 3]) as never;
    });
    const result = await installAgentFromFolder(SRC);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('COPY_FAILED');
    const removed = mockRemove.mock.calls.map((c) => String(c[0]));
    expect(removed.some((p) => p.includes('/.abu/agent-staging/my-agent'))).toBe(true);
    expect(mockRename).not.toHaveBeenCalled();
  });

  it('returns ALREADY_EXISTS without overwrite; on overwrite moves old aside and restores on swap failure', async () => {
    installFakeSourceTree();
    mockExists.mockImplementation(
      async (p: string | URL) =>
        String(p).endsWith('/AGENT.md') || String(p).endsWith('/.abu/agents/my-agent'),
    );
    const conflict = await installAgentFromFolder(SRC);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe('ALREADY_EXISTS');

    const replaced = await installAgentFromFolder(SRC, { overwrite: true });
    expect(replaced.ok).toBe(true);
    const renames = mockRename.mock.calls.map((c) => [String(c[0]), String(c[1])]);
    expect(renames).toContainEqual([
      expect.stringContaining('/.abu/agents/my-agent'),
      expect.stringContaining('/.abu/agent-staging/__backup__my-agent'),
    ]);
    // live target never removed before swap
    const removed = mockRemove.mock.calls.map((c) => String(c[0]));
    expect(removed.some((p) => p.endsWith('/.abu/agents/my-agent'))).toBe(false);
  });

  it('restores the original agent if the swap rename fails on overwrite (no data loss)', async () => {
    installFakeSourceTree();
    mockExists.mockImplementation(
      async (p: string | URL) =>
        String(p).endsWith('/AGENT.md') || String(p).endsWith('/.abu/agents/my-agent'),
    );
    mockRename.mockImplementation(async (from: string | URL, to: string | URL) => {
      if (String(from).includes('/agent-staging/my-agent') && String(to).endsWith('/.abu/agents/my-agent')) {
        throw new Error('swap failed');
      }
      return undefined as never;
    });
    const result = await installAgentFromFolder(SRC, { overwrite: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('COPY_FAILED');
    const renames = mockRename.mock.calls.map((c) => [String(c[0]), String(c[1])]);
    expect(renames).toContainEqual([
      expect.stringContaining('/.abu/agent-staging/__backup__my-agent'),
      expect.stringContaining('/.abu/agents/my-agent'),
    ]);
  });

  it('fails with NO_AGENT_MD when AGENT.md is absent', async () => {
    mockExists.mockResolvedValue(false);
    const result = await installAgentFromFolder(SRC);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NO_AGENT_MD');
  });
});
