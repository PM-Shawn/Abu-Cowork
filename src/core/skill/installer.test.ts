import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readTextFile,
  readDir,
  readFile,
  writeFile,
  mkdir,
  exists,
  lstat,
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
  lstat: vi.fn(),
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
const mockMkdir = vi.mocked(mkdir);
const mockExists = vi.mocked(exists);
const mockLstat = vi.mocked(lstat);
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
  // Every virtual-tree case installs from a real directory, not a link to one,
  // and its SKILL.md is a real file rather than a directory or a pipe.
  mockLstat.mockImplementation(
    async (p: string | URL) =>
      (String(p).endsWith('/SKILL.md')
        ? { isSymlink: false, isFile: true, isDirectory: false }
        : { isSymlink: false, isFile: false, isDirectory: true }) as never,
  );
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
      // A path that is not there cannot be lstat'd either — the two calls have
      // to tell the same story, or the harness is describing a file that both
      // exists and does not.
      mockLstat.mockImplementation(async (p: string | URL) => {
        if (String(p).endsWith('/SKILL.md')) throw new Error('ENOENT: no such file or directory, lstat');
        return { isSymlink: false, isFile: false, isDirectory: true } as never;
      });
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

/**
 * These run against a REAL temporary directory with REAL symlinks, driving the
 * mocked `@tauri-apps/plugin-fs` surface through node's fs exactly the way
 * `electron/fsHost.cjs` does.
 *
 * Deliberately not the virtual tree above. Every hand-written entry in it says
 * `isSymlink: false`, which is precisely the blind spot that let this ship: a
 * dirent for a link reports `isDirectory: false` / `isFile: false` /
 * `isSymlink: true` whether it points at a file or at a directory, and only a
 * real dirent produces that combination by itself.
 */

/** Point the mocked plugin-fs surface at the real filesystem. */
function useRealFs() {
  mockReadDir.mockImplementation(async (p: string | URL) =>
    readdirSync(String(p), { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
      isSymlink: d.isSymbolicLink(),
    })) as never,
  );
  mockReadTextFile.mockImplementation(async (p: string | URL) => readFileSync(String(p), 'utf8'));
  // `readFileSync` FOLLOWS a symlink — what the privileged host does, and why a
  // link to a directory used to throw EISDIR right here.
  mockReadFile.mockImplementation(async (p: string | URL) => new Uint8Array(readFileSync(String(p))) as never);
  mockWriteFile.mockImplementation(async (p: string | URL, data) => {
    writeFileSync(String(p), data as Uint8Array);
    return undefined as never;
  });
  mockMkdir.mockImplementation(async (p: string | URL) => {
    mkdirSync(String(p), { recursive: true });
    return undefined as never;
  });
  mockExists.mockImplementation(async (p: string | URL) => existsSync(String(p)));
  mockRemove.mockImplementation(async (p: string | URL) => {
    rmSync(String(p), { recursive: true, force: true });
    return undefined as never;
  });
  mockRename.mockImplementation(async (from: string | URL, to: string | URL) => {
    renameSync(String(from), String(to));
    return undefined as never;
  });
  // `lstat` is the one call that must NOT resolve the final component — it is
  // how the installer decides whether the folder it was handed is itself a link
  // and whether the manifest it is about to read is a real file.
  mockLstat.mockImplementation(async (p: string | URL) => {
    const info = lstatSync(String(p));
    return {
      isSymlink: info.isSymbolicLink(),
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
    } as never;
  });
}

/** Absolute paths of every real file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

const LINKY_SKILL_MD = '---\nname: linky-skill\ndescription: a skill\n---\n# body';

describe('installSkillFromFolder over a real tree with real symlinks', () => {
  let root: string;
  let src: string;
  let installed: string;
  let secret: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-skill-install-'));
    src = join(root, 'linky-skill');
    installed = join(root, '.abu', 'skills', 'linky-skill');
    secret = join(root, 'secret.txt');

    // A skill folder shaped like the package that broke the plugin installer:
    // a real file, a real subdirectory, a link to a sibling DIRECTORY, and a
    // link to a FILE outside the folder entirely.
    mkdirSync(join(src, 'references'), { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), LINKY_SKILL_MD);
    writeFileSync(join(src, 'references', 'guide.md'), '# guide');
    symlinkSync('references', join(src, 'linkdir'), 'dir');
    writeFileSync(secret, 'PRIVATE KEY');
    mkdirSync(join(src, 'data'), { recursive: true });
    symlinkSync(secret, join(src, 'data', 'x'));

    mockHomeDir.mockResolvedValue(root);
    useRealFs();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('installs a folder containing a link to a directory instead of crashing', async () => {
    // Pre-fix this failed with COPY_FAILED wrapping
    // "EISDIR: illegal operation on a directory, read" the moment the walk
    // reached `linkdir`: its dirent says isDirectory:false, so it fell into the
    // file branch and readFile followed it onto a directory.
    const result = await installSkillFromFolder(src);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(installed, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(installed, 'references', 'guide.md'))).toBe(true);
    expect(result.fileCount).toBe(2);
  });

  it('copies neither kind of link, and reports both', async () => {
    const result = await installSkillFromFolder(src);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Not followed, and not recreated either: recreating the link would still
    // point whoever reads the installed skill back out of it.
    expect(existsSync(join(installed, 'linkdir'))).toBe(false);
    expect(existsSync(join(installed, 'data', 'x'))).toBe(false);
    expect(result.skippedSymlinks).toEqual(['data/x', 'linkdir']);
  });

  it('never reads a symlink at all', async () => {
    await installSkillFromFolder(src);

    const read = mockReadFile.mock.calls.map((c) => String(c[0]));
    expect(read).not.toContain(join(src, 'linkdir'));
    expect(read).not.toContain(join(src, 'data', 'x'));
  });

  it('refuses a source folder that is itself a symlink', async () => {
    // `exists` and `readDir` both resolve the final component in the privileged
    // host, so a linked root enumerates the TARGET: a tree from somewhere else
    // installs under a name read from somewhere else, and the skipped-links
    // report describes a folder the caller never named. Only the root itself
    // can see that, because from the entries' side it is invisible.
    const linkedRoot = join(root, 'linked-skill');
    symlinkSync(src, linkedRoot, 'dir');

    const result = await installSkillFromFolder(linkedRoot);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SYMLINK_ROOT');
    expect(existsSync(installed)).toBe(false);
  });
});

/**
 * A second fixture carrying ONLY the link to a file.
 *
 * The combined fixture above cannot pin the exfiltration guard on its own:
 * pre-fix, `linkdir` threw EISDIR and aborted the install before the walk ever
 * reached `data/x`, so an assertion about the file link would pass for the
 * wrong reason. Here the file link is the only link there is, nothing crashes
 * before it, and the assertion is on CONTENT — proving the target's material
 * was copied, not merely that a path exists.
 */
describe('installSkillFromFolder over a folder whose only link points at a file', () => {
  let root: string;
  let src: string;
  let installed: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-skill-exfil-'));
    src = join(root, 'linky-skill');
    installed = join(root, '.abu', 'skills', 'linky-skill');

    const secret = join(root, 'secret.txt');
    writeFileSync(secret, 'PRIVATE KEY');
    mkdirSync(join(src, 'data'), { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), LINKY_SKILL_MD);
    symlinkSync(secret, join(src, 'data', 'x'));

    mockHomeDir.mockResolvedValue(root);
    useRealFs();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('installs without materialising the target of the file link', async () => {
    // The quiet half: a link to a FILE did not crash. readFile followed it and
    // the TARGET's bytes were written as a real file inside the installed
    // skill, so `data/x -> ~/.ssh/id_rsa` handed the key to a directory the
    // model is allowed to read back.
    const result = await installSkillFromFolder(src);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skippedSymlinks).toEqual(['data/x']);
    for (const p of filesUnder(installed)) {
      expect(readFileSync(p, 'utf8')).not.toContain('PRIVATE KEY');
    }
  });
});

/**
 * The one segment that decides the skill's identity: `SKILL.md` itself.
 *
 * `exists` and `readTextFile` resolve the final path component in the
 * privileged host, so a LINKED `SKILL.md` is read straight through while
 * `copyDirectory` (correctly) refuses to copy that same link. Gate and copy
 * must run one rule, or the install "succeeds" into a directory with no
 * manifest — which `loader.ts` never loads, and which the overwrite paths
 * (SkillUploadModal's confirm dialog, `skill_manage` with `overwrite: true`)
 * put where a working skill used to be.
 */
describe('installSkillFromFolder when SKILL.md is itself a symlink', () => {
  let root: string;
  let src: string;
  let installed: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-skill-linked-md-'));
    src = join(root, 'linky-skill');
    installed = join(root, '.abu', 'skills', 'linky-skill');

    // A manifest that lives OUTSIDE the folder being installed.
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    writeFileSync(join(root, 'elsewhere', 'SKILL.md'), LINKY_SKILL_MD);

    mkdirSync(src, { recursive: true });
    symlinkSync(join(root, 'elsewhere', 'SKILL.md'), join(src, 'SKILL.md'));
    writeFileSync(join(src, 'body.md'), '# body');

    mockHomeDir.mockResolvedValue(root);
    useRealFs();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses the install instead of reporting success without a manifest', async () => {
    const result = await installSkillFromFolder(src);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NO_SKILL_MD');
    expect(existsSync(installed)).toBe(false);
  });

  it('leaves an existing same-named skill untouched on overwrite', async () => {
    // Pre-guard this swapped a working skill out for a directory holding only
    // `body.md`, and reported ok:true — the caller then says "upload
    // succeeded" and the loader silently has one skill fewer.
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, 'SKILL.md'), LINKY_SKILL_MD);
    writeFileSync(join(installed, 'important.md'), 'ORIGINAL CONTENT');

    const result = await installSkillFromFolder(src, { overwrite: true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NO_SKILL_MD');
    expect(readFileSync(join(installed, 'important.md'), 'utf8')).toBe('ORIGINAL CONTENT');
    expect(existsSync(join(installed, 'SKILL.md'))).toBe(true);
  });
});

/**
 * The installed directory is `~/.abu/skills/<frontmatter name>`, and the name
 * comes out of a file someone else wrote. `joinPath` does not collapse `..`
 * and the host's scope guard only asks whether the RESOLVED path is under
 * $HOME, so an unvalidated name escapes the skills directory entirely.
 */
describe('installSkillFromFolder with a traversing frontmatter name', () => {
  let root: string;
  let src: string;
  let victim: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-skill-name-'));
    src = join(root, 'evil-pkg');
    victim = join(root, 'victim');

    mkdirSync(src, { recursive: true });
    // `~/.abu/skills/../../victim` resolves to `~/victim`.
    writeFileSync(join(src, 'SKILL.md'), '---\nname: ../../victim\n---\n# body');

    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'keep.txt'), 'ORIGINAL CONTENT');

    mockHomeDir.mockResolvedValue(root);
    useRealFs();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a name that is not a single directory segment', async () => {
    const result = await installSkillFromFolder(src, { overwrite: true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NO_NAME');
    // The directory the name pointed at is still exactly as it was.
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('ORIGINAL CONTENT');
  });
});

/**
 * Non-regular entries: a FIFO.
 *
 * The rule the copy applies is "skip symlinks", but a symlink is not the only
 * non-regular shape a dirent can take. A FIFO reports
 * `isDirectory:false / isFile:false / isSymlink:false` — the one combination an
 * `isSymlink` test does not catch — and `readFile` on a writer-less pipe lands
 * on `fs.readFileSync` inside `ipcMain.handle('tauri:invoke')`, i.e. on the
 * MAIN process event loop, where it never returns: every window and the tray
 * freeze until the user force-quits. macOS's stock tar round-trips a FIFO, so a
 * downloaded-and-extracted skill folder can carry one.
 *
 * A real `mkfifo`, deliberately: hand-written dirents all say
 * `isFile: false, isSymlink: false` for directories too, so only a real one
 * produces this combination by itself.
 */
describe('installSkillFromFolder over a folder containing a FIFO', () => {
  let root: string;
  let src: string;
  let installed: string;
  let fifo: string;
  let readFileTargets: string[];
  let readTextTargets: string[];

  /**
   * Point `readFile` / `readTextFile` at the real filesystem, EXCEPT on a
   * non-regular file: a real read of a writer-less pipe never returns and would
   * hang the whole run rather than fail it. Recording the call and handing back
   * bytes turns the defect into an assertion.
   */
  function useNonBlockingReads() {
    mockReadFile.mockImplementation(async (p: string | URL) => {
      readFileTargets.push(String(p));
      if (!lstatSync(String(p)).isFile()) return new Uint8Array([0xde, 0xad]) as never;
      return new Uint8Array(readFileSync(String(p))) as never;
    });
    mockReadTextFile.mockImplementation(async (p: string | URL) => {
      readTextTargets.push(String(p));
      if (!lstatSync(String(p)).isFile()) return 'BYTES-FROM-A-PIPE' as never;
      return readFileSync(String(p), 'utf8') as never;
    });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-skill-fifo-'));
    src = join(root, 'fifo-skill');
    installed = join(root, '.abu', 'skills', 'fifo-skill');
    fifo = join(src, 'pipe');

    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), '---\nname: fifo-skill\ndescription: a skill\n---\n# body');
    writeFileSync(join(src, 'notes.txt'), 'ordinary file');
    execFileSync('mkfifo', [fifo]);

    readFileTargets = [];
    readTextTargets = [];
    mockHomeDir.mockResolvedValue(root);
    useRealFs();
    useNonBlockingReads();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('never reads the pipe, and never installs it', async () => {
    const result = await installSkillFromFolder(src);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The read that would have frozen the main process was never issued.
    expect(readFileTargets).not.toContain(fifo);
    expect(existsSync(join(installed, 'pipe'))).toBe(false);
    expect(result.fileCount).toBe(2); // SKILL.md + notes.txt
    // Not a link, so it must not be reported as one: `skippedSymlinks` is
    // rendered to the user as the links the copy refused.
    expect(result.skippedSymlinks).toEqual([]);
  });

  it('treats a SKILL.md that is a FIFO as absent instead of reading it', async () => {
    // The gate reads the manifest with `readTextFile`, which resolves the final
    // component in the privileged host exactly as `readFile` does — so the same
    // pipe freezes the app one function earlier, before the copy is reached.
    rmSync(join(src, 'SKILL.md'));
    const pipedManifest = join(src, 'SKILL.md');
    execFileSync('mkfifo', [pipedManifest]);

    const result = await installSkillFromFolder(src);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NO_SKILL_MD');
    expect(readTextTargets).not.toContain(pipedManifest);
  });
});
