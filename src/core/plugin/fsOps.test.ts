import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn(),
}));

import { readDir, readFile, writeFile, mkdir, remove } from '@tauri-apps/plugin-fs';
import { copyPluginDir, removePluginDir, PLUGIN_COPY_DENYLIST } from './fsOps';

const mockReadDir = vi.mocked(readDir);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockRemove = vi.mocked(remove);

/** Register a virtual tree: dir path → entries. */
function tree(dirs: Record<string, Array<{ name: string; isDirectory: boolean }>>) {
  mockReadDir.mockImplementation(async (p) => {
    const entries = dirs[String(p)] ?? [];
    return entries.map((e) => ({ ...e, isFile: !e.isDirectory, isSymlink: false })) as never;
  });
  mockReadFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
}

function writtenPaths(): string[] {
  return mockWriteFile.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('copyPluginDir', () => {
  it('copies the manifest dot-directory — the whole package depends on it', async () => {
    // The skill installer's copyDirectory skips every dot-entry (a Tauri fs
    // scope workaround). Applying that rule here would install a plugin with
    // no manifest at all, and it would only fail at runtime.
    tree({
      '/src': [{ name: '.abu-plugin', isDirectory: true }],
      '/src/.abu-plugin': [{ name: 'plugin.json', isDirectory: false }],
    });

    await copyPluginDir('/src', '/dst');

    expect(writtenPaths()).toContain('/dst/.abu-plugin/plugin.json');
  });

  it('copies a .claude-plugin manifest too', async () => {
    tree({
      '/src': [{ name: '.claude-plugin', isDirectory: true }],
      '/src/.claude-plugin': [{ name: 'plugin.json', isDirectory: false }],
    });

    await copyPluginDir('/src', '/dst');

    expect(writtenPaths()).toContain('/dst/.claude-plugin/plugin.json');
  });

  it('recurses into nested skill directories', async () => {
    tree({
      '/src': [{ name: 'skills', isDirectory: true }],
      '/src/skills': [{ name: 'today', isDirectory: true }],
      '/src/skills/today': [{ name: 'SKILL.md', isDirectory: false }],
    });

    const count = await copyPluginDir('/src', '/dst');

    expect(writtenPaths()).toEqual(['/dst/skills/today/SKILL.md']);
    expect(count).toBe(1);
  });

  it.each([...PLUGIN_COPY_DENYLIST])('skips %s', async (denied) => {
    tree({
      '/src': [
        { name: denied, isDirectory: true },
        { name: 'README.md', isDirectory: false },
      ],
      [`/src/${denied}`]: [{ name: 'junk', isDirectory: false }],
    });

    await copyPluginDir('/src', '/dst');

    expect(writtenPaths()).toEqual(['/dst/README.md']);
  });

  it('creates the destination directory before writing into it', async () => {
    tree({ '/src': [{ name: 'a.txt', isDirectory: false }] });
    await copyPluginDir('/src', '/dst');
    expect(mkdir).toHaveBeenCalledWith('/dst', { recursive: true });
  });

  it('counts every file it wrote', async () => {
    tree({
      '/src': [
        { name: 'a.txt', isDirectory: false },
        { name: 'sub', isDirectory: true },
      ],
      '/src/sub': [
        { name: 'b.txt', isDirectory: false },
        { name: 'c.txt', isDirectory: false },
      ],
    });

    await expect(copyPluginDir('/src', '/dst')).resolves.toBe(3);
  });
});

describe('removePluginDir', () => {
  it('removes recursively', async () => {
    await removePluginDir('/dst/pkg');
    expect(mockRemove).toHaveBeenCalledWith('/dst/pkg', { recursive: true });
  });
});
