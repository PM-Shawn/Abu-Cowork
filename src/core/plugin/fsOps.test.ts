import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn(),
  lstat: vi.fn(),
}));

import { readDir, readFile, writeFile, mkdir, remove, lstat } from '@tauri-apps/plugin-fs';
import {
  copyPluginDir,
  collectPluginSymlinks,
  removePluginDir,
  PluginSymlinkRootError,
  PLUGIN_COPY_DENYLIST,
} from './fsOps';

const mockReadDir = vi.mocked(readDir);
const mockLstat = vi.mocked(lstat);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);
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
  // The default for every virtual-tree case: a root that is a real directory.
  mockLstat.mockResolvedValue({ isSymlink: false } as never);
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

    const result = await copyPluginDir('/src', '/dst');

    expect(writtenPaths()).toEqual(['/dst/skills/today/SKILL.md']);
    expect(result.files).toBe(1);
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

    await expect(copyPluginDir('/src', '/dst')).resolves.toEqual({
      files: 3,
      skippedSymlinks: [],
    });
  });
});

describe('removePluginDir', () => {
  it('removes recursively', async () => {
    await removePluginDir('/dst/pkg');
    expect(mockRemove).toHaveBeenCalledWith('/dst/pkg', { recursive: true });
  });
});

/**
 * These run against a REAL temporary directory with REAL symlinks, driving the
 * mocked `@tauri-apps/plugin-fs` surface through node's fs the same way
 * `electron/fsHost.cjs` does.
 *
 * That is deliberate. The bug this pins — installing `canva` from the official
 * marketplace died with `EISDIR: illegal operation on a directory, read` —
 * survived a fully mocked suite precisely because every hand-written entry in
 * it said `isSymlink: false`. A link to a directory reports
 * `isDirectory: false` / `isSymlink: true`, and only a real dirent produces
 * that combination by itself.
 */
describe('copyPluginDir over a real tree with real symlinks', () => {
  let root: string;
  let src: string;
  let dst: string;
  let secret: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-plugin-fsops-'));
    src = join(root, 'pkg');
    dst = join(root, 'installed');
    secret = join(root, 'secret.txt');

    // A package shaped like the one that broke: a manifest, a real skill, a
    // link to a sibling DIRECTORY (canva ships `.cursor/skills -> ../skills`)
    // and a link to a FILE outside the package entirely.
    mkdirSync(join(src, '.claude-plugin'), { recursive: true });
    writeFileSync(join(src, '.claude-plugin', 'plugin.json'), '{"name":"canva"}');
    mkdirSync(join(src, 'skills', 'design'), { recursive: true });
    writeFileSync(join(src, 'skills', 'design', 'SKILL.md'), '# design');
    mkdirSync(join(src, '.cursor'), { recursive: true });
    symlinkSync('../skills', join(src, '.cursor', 'skills'), 'dir');
    writeFileSync(secret, 'PRIVATE KEY');
    mkdirSync(join(src, 'data'), { recursive: true });
    symlinkSync(secret, join(src, 'data', 'x'));

    mockReadDir.mockImplementation(async (p) =>
      readdirSync(String(p), { withFileTypes: true }).map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isFile: d.isFile(),
        isSymlink: d.isSymbolicLink(),
      })) as never,
    );
    // `readFileSync` FOLLOWS a symlink — exactly what the privileged host does,
    // and exactly why a link to a directory used to throw EISDIR here.
    mockReadFile.mockImplementation(async (p) => new Uint8Array(readFileSync(String(p))));
    mockWriteFile.mockImplementation(async (p, data) => {
      writeFileSync(String(p), data as Uint8Array);
    });
    mockMkdir.mockImplementation(async (p) => {
      mkdirSync(String(p), { recursive: true });
    });
    // `lstat` is the one call that must NOT resolve the final component — it
    // is how both walks decide whether their own root is a link.
    mockLstat.mockImplementation(
      async (p) => ({ isSymlink: lstatSync(String(p)).isSymbolicLink() }) as never,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('installs a package containing a symlink to a directory instead of crashing', async () => {
    // Pre-fix this rejected with "EISDIR: illegal operation on a directory,
    // read" the moment it reached `.cursor/skills`.
    const result = await copyPluginDir(src, dst);

    expect(existsSync(join(dst, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(join(dst, 'skills', 'design', 'SKILL.md'))).toBe(true);
    expect(result.files).toBe(2);
  });

  it('copies neither kind of link, and reports both', async () => {
    const result = await copyPluginDir(src, dst);

    // Not followed, and not recreated either: recreating it would still point
    // whoever reads the installed tree back out of the package.
    expect(existsSync(join(dst, '.cursor', 'skills'))).toBe(false);
    expect(existsSync(join(dst, 'data', 'x'))).toBe(false);
    expect(result.skippedSymlinks).toEqual(['.cursor/skills', 'data/x']);
  });

  it('never materialises the target of a link to a file inside the install', async () => {
    // The quiet half of the bug: a link to a FILE did not crash — `readFile`
    // followed it and wrote the TARGET's bytes as a real file in the package,
    // so `data/x -> ~/.ssh/id_rsa` handed the key to the plugin's own skills.
    await copyPluginDir(src, dst);

    const written = writtenPaths();
    expect(written).not.toContain(join(dst, 'data', 'x'));
    for (const p of written) {
      expect(readFileSync(p, 'utf8')).not.toContain('PRIVATE KEY');
    }
  });

  it('never reads a symlink at all', async () => {
    await copyPluginDir(src, dst);

    const read = mockReadFile.mock.calls.map((c) => String(c[0]));
    expect(read).not.toContain(join(src, '.cursor', 'skills'));
    expect(read).not.toContain(join(src, 'data', 'x'));
  });

  it('collectPluginSymlinks reports the same links without writing anything', async () => {
    // What `planInstall` puts on the disclosure the user confirms.
    await expect(collectPluginSymlinks(src)).resolves.toEqual(['.cursor/skills', 'data/x']);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it('refuses a package whose own root directory is a symlink', async () => {
    // `resolveSourceDir` only checks the path lexically, so a marketplace that
    // ships `plugins/<name>` as a link passes it and `readDir` then enumerates
    // the TARGET — files from outside the marketplace copied in, with an empty
    // skipped-links list. Only the root itself can hide that, so only the root
    // itself can refuse it.
    const linkedRoot = join(root, 'linked-pkg');
    symlinkSync(src, linkedRoot, 'dir');

    await expect(copyPluginDir(linkedRoot, dst)).rejects.toThrow(PluginSymlinkRootError);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('refuses to describe a package whose own root directory is a symlink', async () => {
    const linkedRoot = join(root, 'linked-pkg');
    symlinkSync(src, linkedRoot, 'dir');

    await expect(collectPluginSymlinks(linkedRoot)).rejects.toThrow(PluginSymlinkRootError);
  });
});

/**
 * A second fixture carrying ONLY the link to a file.
 *
 * The combined fixture above cannot pin the exfiltration guard on its own:
 * pre-fix, `.cursor/skills` threw `EISDIR` before the walk ever reached
 * `data/x`, so the assertion about the file link passed for the wrong reason.
 * Here the file link is the only link there is, and nothing crashes before it.
 */
describe('copyPluginDir over a package whose only link points at a file', () => {
  let root: string;
  let src: string;
  let dst: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-plugin-exfil-'));
    src = join(root, 'pkg');
    dst = join(root, 'installed');

    const secret = join(root, 'secret.txt');
    writeFileSync(secret, 'PRIVATE KEY');
    mkdirSync(join(src, '.claude-plugin'), { recursive: true });
    writeFileSync(join(src, '.claude-plugin', 'plugin.json'), '{"name":"leaky"}');
    mkdirSync(join(src, 'data'), { recursive: true });
    symlinkSync(secret, join(src, 'data', 'x'));

    mockReadDir.mockImplementation(async (p) =>
      readdirSync(String(p), { withFileTypes: true }).map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isFile: d.isFile(),
        isSymlink: d.isSymbolicLink(),
      })) as never,
    );
    mockReadFile.mockImplementation(async (p) => new Uint8Array(readFileSync(String(p))));
    mockWriteFile.mockImplementation(async (p, data) => {
      writeFileSync(String(p), data as Uint8Array);
    });
    mockMkdir.mockImplementation(async (p) => {
      mkdirSync(String(p), { recursive: true });
    });
    mockLstat.mockImplementation(
      async (p) => ({ isSymlink: lstatSync(String(p)).isSymbolicLink() }) as never,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('installs without materialising the target of the file link', async () => {
    const result = await copyPluginDir(src, dst);

    expect(result.skippedSymlinks).toEqual(['data/x']);
    expect(existsSync(join(dst, 'data', 'x'))).toBe(false);
    for (const p of writtenPaths()) {
      expect(readFileSync(p, 'utf8')).not.toContain('PRIVATE KEY');
    }
  });
});
