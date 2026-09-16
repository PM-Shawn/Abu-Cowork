import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  readTextFile,
  readDir,
  readFile,
  writeFile,
  mkdir,
  exists,
  remove,
  rename,
  lstat,
} from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
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
import { join, resolve } from 'node:path';

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
  lstat: vi.fn(),
}));

import { installAgentFromFolder } from './installer';

const mockReadTextFile = vi.mocked(readTextFile);
const mockReadDir = vi.mocked(readDir);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);
const mockRemove = vi.mocked(remove);
const mockRename = vi.mocked(rename);
const mockExists = vi.mocked(exists);
const mockLstat = vi.mocked(lstat);
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
  // Nothing in the virtual tree is a link, and its AGENT.md is a real file
  // rather than a directory or a pipe; the real-tree suites below override this.
  mockLstat.mockImplementation(
    async (p: string | URL) =>
      (String(p).endsWith('/AGENT.md')
        ? { isSymlink: false, isFile: true, isDirectory: false }
        : { isSymlink: false, isFile: false, isDirectory: true }) as never,
  );
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
    // A path that is not there cannot be lstat'd either — the two calls have to
    // tell the same story, or the harness is describing a file that both exists
    // and does not.
    mockLstat.mockImplementation(async (p: string | URL) => {
      if (String(p).endsWith('/AGENT.md')) throw new Error('ENOENT: no such file or directory, lstat');
      return { isSymlink: false, isFile: false, isDirectory: true } as never;
    });
    const result = await installAgentFromFolder(SRC);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NO_AGENT_MD');
  });
});

/**
 * Everything below runs against a REAL temporary directory holding REAL
 * symlinks and a REAL FIFO, deliberately NOT the hand-written virtual tree
 * above.
 *
 * Every entry in that tree says `isSymlink: false, isFile: true`, which is
 * precisely the blind spot that let this ship: only a real dirent produces
 * `isDirectory:false / isFile:false / isSymlink:true` for a link (whichever
 * kind of thing it points at) or `isDirectory:false / isFile:false /
 * isSymlink:false` for a FIFO.
 */

/**
 * Point the mocked plugin-fs surface at the real filesystem, THROUGH the
 * lexical normalization the privileged host applies first.
 *
 * `electron/fsHost.cjs` runs every renderer path through
 * `resolveValidatedPath` (`path.resolve`, fsHost.cjs:280-288) before node's fs
 * ever sees it, so `~/.abu/agent-staging/../../Documents/x` arrives at
 * `rmSync` already collapsed to `~/Documents/x` — with no requirement that the
 * `.abu/agent-staging` it traverses exist. A harness that handed the
 * uncollapsed spelling straight to node would ENOENT on the missing directory
 * and hide the very thing under test.
 */
function useRealFs() {
  mockReadDir.mockImplementation(async (p: string | URL) =>
    readdirSync(resolve(String(p)), { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
      isSymlink: d.isSymbolicLink(),
    })) as never,
  );
  mockReadTextFile.mockImplementation(async (p: string | URL) => readFileSync(resolve(String(p)), 'utf8'));
  // `readFileSync` FOLLOWS a symlink — what the privileged host does, and why a
  // link to a directory used to throw EISDIR right here.
  mockReadFile.mockImplementation(
    async (p: string | URL) => new Uint8Array(readFileSync(resolve(String(p)))) as never,
  );
  mockWriteFile.mockImplementation(async (p: string | URL, data) => {
    writeFileSync(resolve(String(p)), data as Uint8Array);
    return undefined as never;
  });
  mockMkdir.mockImplementation(async (p: string | URL) => {
    mkdirSync(resolve(String(p)), { recursive: true });
    return undefined as never;
  });
  mockExists.mockImplementation(async (p: string | URL) => existsSync(resolve(String(p))));
  mockRemove.mockImplementation(async (p: string | URL) => {
    rmSync(resolve(String(p)), { recursive: true, force: true });
    return undefined as never;
  });
  mockRename.mockImplementation(async (from: string | URL, to: string | URL) => {
    renameSync(resolve(String(from)), resolve(String(to)));
    return undefined as never;
  });
  // `lstat` is the one call routed with `followFinalSymlink: false`
  // (`plugin:fs|lstat`, electron/fsHost.cjs) — it must NOT resolve the final
  // component, because it is how the installer asks whether that component is
  // itself a link.
  //
  // All three flags, as `toFileInfo` (electron/fsHost.cjs) returns them: a
  // caller asking whether a manifest is a REGULAR file it owns needs `isFile`
  // too, and answering only `isSymlink` would make a FIFO indistinguishable
  // from an ordinary file in this harness.
  mockLstat.mockImplementation(async (p: string | URL) => {
    const info = lstatSync(resolve(String(p)));
    return {
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      isSymlink: info.isSymbolicLink(),
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

/**
 * The install directory is `~/.abu/agents/<frontmatter name>` and the staging
 * directory is `~/.abu/agent-staging/<the same name>` — both concatenated from
 * a string in a file somebody else wrote. `joinPath` does not collapse `..`
 * and the host's guard only asks whether the RESOLVED path lands under an
 * allowed root, and `$HOME` is one.
 *
 * Staging is the dangerous half: it is REMOVED recursively before anything
 * else happens, so an escaping name destroys a directory without the install
 * ever having to succeed.
 */
describe('installAgentFromFolder with a traversing frontmatter name', () => {
  let root: string;
  let src: string;
  let victim: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-agent-name-'));
    src = join(root, 'evil-pkg');
    victim = join(root, 'Documents', 'important');

    mkdirSync(src, { recursive: true });
    // `~/.abu/agent-staging/../../Documents/important` resolves to
    // `~/Documents/important`.
    writeFileSync(join(src, 'AGENT.md'), '---\nname: ../../Documents/important\n---\n# body');

    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'thesis.txt'), 'ORIGINAL CONTENT');

    mockHomeDir.mockResolvedValue(root);
    useRealFs();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses the name instead of recursively deleting the directory it points at', async () => {
    // ToolboxModal.tsx:144 — the only caller — always passes overwrite: true.
    const result = await installAgentFromFolder(src, { overwrite: true });

    // Asserted BEFORE the result code: the directory surviving is the property
    // that matters, and it is the one that failed before the fix.
    expect(existsSync(victim)).toBe(true);
    expect(readFileSync(join(victim, 'thesis.txt'), 'utf8')).toBe('ORIGINAL CONTENT');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NO_NAME');
  });

  it('writes nothing anywhere when the name is refused', async () => {
    await installAgentFromFolder(src, { overwrite: true });

    // The refusal has to land BEFORE the first remove/mkdir/write/rename, not
    // merely produce a failing result afterwards.
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });
});

const LINKY_AGENT_MD = '---\nname: linky-agent\ndescription: an agent\n---\n# body';

describe('installAgentFromFolder over a real tree with real symlinks', () => {
  let root: string;
  let src: string;
  let installed: string;
  let secret: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-agent-install-'));
    src = join(root, 'linky-agent');
    installed = join(root, '.abu', 'agents', 'linky-agent');
    secret = join(root, 'secret.txt');

    // An agent folder shaped like the package that broke the skill installer:
    // a real file, a real subdirectory, a link to a sibling DIRECTORY, and a
    // link to a FILE outside the folder entirely.
    mkdirSync(join(src, 'prompts'), { recursive: true });
    writeFileSync(join(src, 'AGENT.md'), LINKY_AGENT_MD);
    writeFileSync(join(src, 'prompts', 'system.md'), '# system');
    symlinkSync('prompts', join(src, 'linkdir'), 'dir');
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
    const result = await installAgentFromFolder(src);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(installed, 'AGENT.md'))).toBe(true);
    expect(existsSync(join(installed, 'prompts', 'system.md'))).toBe(true);
    expect(result.fileCount).toBe(2);
  });

  it('copies neither kind of link, and reports both', async () => {
    const result = await installAgentFromFolder(src);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Not followed, and not recreated either: recreating the link would still
    // point whoever reads the installed agent back out of it.
    expect(existsSync(join(installed, 'linkdir'))).toBe(false);
    expect(existsSync(join(installed, 'data', 'x'))).toBe(false);
    expect(result.skippedSymlinks).toEqual(['data/x', 'linkdir']);
  });

  it('never reads a symlink at all', async () => {
    await installAgentFromFolder(src);

    const read = mockReadFile.mock.calls.map((c) => String(c[0]));
    expect(read).not.toContain(join(src, 'linkdir'));
    expect(read).not.toContain(join(src, 'data', 'x'));
  });

  it('refuses a source folder that is itself a symlink', async () => {
    // `exists`, `readTextFile` and `readDir` all resolve the final component in
    // the privileged host, so a linked root enumerates the TARGET: a tree from
    // somewhere else installs under a name read from somewhere else, and the
    // refused-links report describes a folder the caller never named. Only the
    // root itself can see that — from the entries' side it is invisible.
    const linkedRoot = join(root, 'linked-agent');
    symlinkSync(src, linkedRoot, 'dir');

    const result = await installAgentFromFolder(linkedRoot);

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
describe('installAgentFromFolder over a folder whose only link points at a file', () => {
  let root: string;
  let src: string;
  let installed: string;
  let secret: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-agent-exfil-'));
    src = join(root, 'linky-agent');
    installed = join(root, '.abu', 'agents', 'linky-agent');
    secret = join(root, 'secret.txt');

    mkdirSync(join(src, 'data'), { recursive: true });
    writeFileSync(join(src, 'AGENT.md'), LINKY_AGENT_MD);
    writeFileSync(secret, '-----BEGIN OPENSSH PRIVATE KEY-----');
    symlinkSync(secret, join(src, 'data', 'x'));

    mockHomeDir.mockResolvedValue(root);
    useRealFs();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('installs without materialising the target of the file link', async () => {
    const result = await installAgentFromFolder(src);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Pre-fix the install reported ok with `skipped: []` and the TARGET's bytes
    // were written as a REAL file inside the installed agent — the same end
    // state `~/.abu/skills/<name>/data/x -> ~/.ssh/id_rsa` produced before
    // 37fc036d closed it on the skill side.
    const installedFiles = filesUnder(installed);
    for (const f of installedFiles) {
      expect(readFileSync(f, 'utf8')).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    }
    expect(installedFiles.map((f) => f.slice(installed.length + 1))).toEqual(['AGENT.md']);
    expect(result.skippedSymlinks).toEqual(['data/x']);
  });
});

/**
 * The manifest gate and the copy have to apply ONE rule.
 *
 * `exists` and `readTextFile` both resolve the final component in the
 * privileged host, so a LINKED AGENT.md is read straight through and the
 * agent's identity — its name, and therefore the directory it installs over —
 * comes from a file the folder does not own. The copy walk then (rightly)
 * refuses that same link, so the two would disagree: `ok: true` for a
 * directory with no AGENT.md in it, which nothing loads, having replaced a
 * working agent under a name the attacker chose. Same split 7674068b closed on
 * the skill side.
 */
describe('installAgentFromFolder when AGENT.md is itself a symlink', () => {
  let root: string;
  let src: string;
  let installed: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-agent-linked-md-'));
    src = join(root, 'pkg');
    installed = join(root, '.abu', 'agents', 'victim-agent');

    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    writeFileSync(join(root, 'elsewhere', 'AGENT.md'), '---\nname: victim-agent\n---\n# body');
    mkdirSync(src, { recursive: true });
    symlinkSync(join(root, 'elsewhere', 'AGENT.md'), join(src, 'AGENT.md'));

    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, 'AGENT.md'), '---\nname: victim-agent\n---\n# the real one');

    mockHomeDir.mockResolvedValue(root);
    useRealFs();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses the install instead of reporting success without a manifest', async () => {
    const result = await installAgentFromFolder(src, { overwrite: true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NO_AGENT_MD');
  });

  it('leaves an existing same-named agent untouched on overwrite', async () => {
    await installAgentFromFolder(src, { overwrite: true });

    expect(readFileSync(join(installed, 'AGENT.md'), 'utf8')).toContain('the real one');
  });
});

/**
 * A FIFO is the one non-regular shape the `isSymlink` test does not catch: its
 * dirent reports `isDirectory:false / isFile:false / isSymlink:false`, so a
 * walk that dispatches on "is it a directory, else read it" hands a pipe to
 * `readFile`. In the shipped app that call is `fs.readFileSync` inside
 * `ipcMain.handle('tauri:invoke')` — on the MAIN process event loop — and a
 * writer-less FIFO never returns, freezing every window until force-quit.
 * macOS's stock tar round-trips a FIFO, so an extracted bundle carries one.
 *
 * The terminal read is stubbed to throw rather than call `readFileSync`,
 * because a faithful call would hang this suite exactly as it hangs the app —
 * which is the point. Everything before it is real: the fixture is a real FIFO
 * and the dirent under test comes from a real `readdirSync`.
 */
describe.skipIf(process.platform === 'win32')('installAgentFromFolder over a folder containing a FIFO', () => {
  let root: string;
  let src: string;
  let installed: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-agent-fifo-'));
    src = join(root, 'pipey-agent');
    installed = join(root, '.abu', 'agents', 'pipey-agent');

    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'AGENT.md'), '---\nname: pipey-agent\n---\n# body');
    execFileSync('mkfifo', [join(src, 'pipe')]);

    mockHomeDir.mockResolvedValue(root);
    useRealFs();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('never hands the pipe to readFile', async () => {
    const attempted: string[] = [];
    mockReadFile.mockImplementation(async (p: string | URL) => {
      const real = resolve(String(p));
      attempted.push(real);
      if (lstatSync(real).isFIFO()) throw new Error('readFile would have blocked the main process on a FIFO');
      return new Uint8Array(readFileSync(real)) as never;
    });

    const result = await installAgentFromFolder(src);

    expect(attempted).not.toContain(join(src, 'pipe'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Copied as a plain file, the pipe's dirent-shaped emptiness would also
    // have landed a bogus regular file in the installed agent.
    expect(existsSync(join(installed, 'pipe'))).toBe(false);
    expect(result.fileCount).toBe(1);
  });

  it('treats an AGENT.md that is a FIFO as absent instead of reading it', async () => {
    // The gate reads the manifest with `readTextFile`, which resolves the final
    // component in the privileged host exactly as `readFile` does — so the same
    // pipe freezes the app one function earlier, before the copy is reached.
    // A link test alone does not catch it: `lstat` on a FIFO answers
    // `isSymlink:false`.
    rmSync(join(src, 'AGENT.md'));
    execFileSync('mkfifo', [join(src, 'AGENT.md')]);

    const attempted: string[] = [];
    mockReadTextFile.mockImplementation(async (p: string | URL) => {
      const real = resolve(String(p));
      attempted.push(real);
      if (lstatSync(real).isFIFO()) throw new Error('readTextFile would have blocked the main process on a FIFO');
      return readFileSync(real, 'utf8');
    });

    const result = await installAgentFromFolder(src, { overwrite: true });

    expect(attempted).not.toContain(join(src, 'AGENT.md'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NO_AGENT_MD');
  });
});
