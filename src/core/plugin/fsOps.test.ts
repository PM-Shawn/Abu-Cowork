import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
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
  scanPluginPackage,
  PluginPackageNotFoundError,
  PluginPackageUnreadableError,
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

/**
 * The scan, the copy and the collect are ONE rule, not three that happen to
 * agree.
 *
 * They used to be three independent walks each re-implementing
 * "denylisted-or-symlink ⇒ absent". A fourth rule added to only two of them
 * silently re-opens the disagreement this whole area exists to close: the
 * disclosure would describe a tree the copy does not produce. These cases
 * drive all three off the same fixture, and they enumerate the exported
 * denylist rather than a second copy of it, so adding an entry to
 * `PLUGIN_COPY_DENYLIST` extends the pin for free.
 */
describe('one ownership rule behind the scan, the copy and the collect', () => {
  it.each([...PLUGIN_COPY_DENYLIST])('all three treat %s as absent', async (denied) => {
    tree({
      '/src': [
        { name: denied, isDirectory: true },
        { name: 'README.md', isDirectory: false },
      ],
      [`/src/${denied}`]: [{ name: 'junk', isDirectory: false }],
    });

    const scan = scanPluginPackage('/src');
    await expect(scan.find(denied)).resolves.toBeUndefined();
    expect((await scan.children('')).map((e) => e.name)).toEqual(['README.md']);
    await expect(copyPluginDir('/src', '/dst')).resolves.toEqual({ files: 1, skippedSymlinks: [] });
    await expect(collectPluginSymlinks('/src')).resolves.toEqual([]);
  });
});

describe('scanPluginPackage', () => {
  it('normalizes the listing key so a trailing slash is not a second cache entry', async () => {
    // `find` filters empty segments but `listOwned` keyed on the raw string,
    // so `children('skills/')` both missed the cache and asked the host for
    // `/src/skills/`. Latent only because every caller passes a clean literal.
    tree({
      '/src': [{ name: 'skills', isDirectory: true }],
      '/src/skills': [{ name: 'today', isDirectory: true }],
    });

    const scan = scanPluginPackage('/src');
    expect((await scan.children('skills')).map((e) => e.name)).toEqual(['today']);
    expect((await scan.children('skills/')).map((e) => e.name)).toEqual(['today']);

    const listed = mockReadDir.mock.calls.map((c) => String(c[0]));
    expect(listed).not.toContain('/src/skills/');
    expect(listed.filter((p) => p === '/src/skills')).toHaveLength(1);
  });

  it('refuses a package root that is a link, for every caller and not by call order', async () => {
    // The refusal used to live only in `copyPluginDir` / `collectPluginSymlinks`,
    // so a scan-only caller (`readManifestFrom`) read a linked root's target.
    mockLstat.mockResolvedValue({ isSymlink: true } as never);
    tree({ '/src': [{ name: '.abu-plugin', isDirectory: true }] });

    await expect(scanPluginPackage('/src').find('.abu-plugin')).rejects.toThrow(
      PluginSymlinkRootError,
    );
  });
});

/**
 * A failure to list a package directory is a domain outcome, not a syscall.
 *
 * The privileged host re-throws as a plain `new Error(err.message)`
 * (`electron/tauriHost.cjs`), so the `code` property never survives the IPC
 * hop — only node's message, which leads with the code. These cases use that
 * message-only shape deliberately: it is the one that actually ships.
 */
describe('unreadable package directories', () => {
  it('reports a missing package directory as a plugin error, not ENOENT', async () => {
    mockLstat.mockRejectedValue(new Error("ENOENT: no such file or directory, lstat '/src'"));

    await expect(collectPluginSymlinks('/src')).rejects.toThrow(PluginPackageNotFoundError);
    const message = await collectPluginSymlinks('/src').then(
      () => '',
      (e: unknown) => (e as Error).message,
    );
    expect(message).toContain('/src');
    // The point of the item: a marketplace catalog pointing at a deleted
    // folder must not put a syscall in front of the user.
    expect(message).not.toContain('ENOENT');
    expect(message).not.toContain('lstat');
  });

  it('fails loud, and says "permission", when a directory cannot be read', async () => {
    // Deliberate: `exists` used to swallow EACCES to `false`, which let an
    // unreadable `.abu-plugin/` fall through to the next manifest candidate —
    // i.e. install a package under a manifest it did not nominate.
    mockReadDir.mockImplementation(async (p) => {
      if (String(p) === '/src') {
        return [{ name: '.abu-plugin', isDirectory: true, isFile: false, isSymlink: false }] as never;
      }
      throw new Error("EACCES: permission denied, scandir '/src/.abu-plugin'");
    });

    const scan = scanPluginPackage('/src');
    await expect(scan.find('.abu-plugin/plugin.json')).rejects.toThrow(PluginPackageUnreadableError);
    await expect(scan.find('.abu-plugin/plugin.json')).rejects.toThrow(/permission/i);
  });

  it('leaves an error it does not recognise exactly as it found it', async () => {
    const weird = new Error('the disk fell off');
    mockLstat.mockRejectedValue(weird);

    await expect(collectPluginSymlinks('/src')).rejects.toBe(weird);
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

  it('the scan hides exactly the links the copy skips and the collect reports', async () => {
    // One rule, three consumers: what the disclosure can see, what the copy
    // leaves behind and what the pre-consent walk reports are the same set.
    const scan = scanPluginPackage(src);
    await expect(scan.find('.cursor/skills')).resolves.toBeUndefined();
    await expect(scan.find('data/x')).resolves.toBeUndefined();

    const copied = await copyPluginDir(src, dst);
    await expect(collectPluginSymlinks(src)).resolves.toEqual(copied.skippedSymlinks);
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

/**
 * Non-regular entries: a FIFO.
 *
 * The ownership rule is "denylisted or a link ⇒ absent", but a link is not the
 * only non-regular shape a dirent can take. A FIFO reports
 * `isDirectory:false / isFile:false / isSymlink:false` — the one combination an
 * `isSymlink` test does not catch — and every read below lands on a synchronous
 * `readFileSync` / `readFileSync(utf8)` inside `ipcMain.handle('tauri:invoke')`,
 * i.e. on the MAIN process event loop, where a writer-less pipe never returns:
 * every window and the tray freeze until the user force-quits. tar round-trips a
 * FIFO, so an extracted package can carry one.
 *
 * A real `mkfifo`, deliberately — the virtual trees above hand-write
 * `isFile: !isDirectory`, which is exactly the assumption a pipe breaks.
 *
 * Skipped on Windows: there is no `mkfifo(1)` there (and no FIFO dirent for the
 * copy to meet), so the fixture cannot build the shape this guard protects
 * against — same skip as `installAgentFromFolder over a folder containing a FIFO`.
 */
describe.skipIf(process.platform === 'win32')('a package containing a FIFO', () => {
  let root: string;
  let src: string;
  let dst: string;
  let fifo: string;
  let readFileTargets: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-plugin-fifo-'));
    src = join(root, 'pkg');
    dst = join(root, 'installed');
    fifo = join(src, 'pipe');
    readFileTargets = [];

    mkdirSync(join(src, '.claude-plugin'), { recursive: true });
    writeFileSync(join(src, '.claude-plugin', 'plugin.json'), '{"name":"pipey"}');
    writeFileSync(join(src, 'readme.md'), '# readme');
    execFileSync('mkfifo', [fifo]);

    mockReadDir.mockImplementation(async (p) =>
      readdirSync(String(p), { withFileTypes: true }).map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isFile: d.isFile(),
        isSymlink: d.isSymbolicLink(),
      })) as never,
    );
    // Real reads, EXCEPT on a non-regular file: a real read of a writer-less
    // pipe never returns and would hang the whole run rather than fail it.
    // Recording the call and handing back bytes turns the defect into an
    // assertion.
    mockReadFile.mockImplementation(async (p) => {
      readFileTargets.push(String(p));
      if (!lstatSync(String(p)).isFile()) return new Uint8Array([0xde, 0xad]);
      return new Uint8Array(readFileSync(String(p)));
    });
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

  it('is neither read nor copied by copyPluginDir', async () => {
    const result = await copyPluginDir(src, dst);

    // The read that would have frozen the main process was never issued.
    expect(readFileTargets).not.toContain(fifo);
    expect(existsSync(join(dst, 'pipe'))).toBe(false);
    expect(existsSync(join(dst, 'readme.md'))).toBe(true);
    expect(result.files).toBe(2); // plugin.json + readme.md
    // Not a link, so it must not be reported as one — `skippedSymlinks` is the
    // disclosure the user approved, and it says these were links.
    expect(result.skippedSymlinks).toEqual([]);
  });

  it('is absent from the pre-consent scan too, so the disclosure and the copy agree', async () => {
    const scan = scanPluginPackage(src);

    expect((await scan.children('')).map((e) => e.name).sort()).toEqual([
      '.claude-plugin',
      'readme.md',
    ]);
    expect(await scan.find('pipe')).toBeUndefined();
    expect(await collectPluginSymlinks(src)).toEqual([]);
  });

  it('is not offered to the manifest reader as a plugin.json', async () => {
    // `readManifestWith` (src/core/plugin/installer.ts) does
    // `if (!(await scan.find(candidate))) continue;` and then `readTextFile`s
    // that path — a second reachable site for the same freeze, reached before
    // any copy happens.
    rmSync(join(src, '.claude-plugin', 'plugin.json'));
    execFileSync('mkfifo', [join(src, '.claude-plugin', 'plugin.json')]);

    const scan = scanPluginPackage(src);

    expect(await scan.find('.claude-plugin/plugin.json')).toBeUndefined();
  });
});
