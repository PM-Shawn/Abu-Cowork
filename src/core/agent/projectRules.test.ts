import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock Tauri APIs before importing the module
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  readDir: vi.fn(),
  exists: vi.fn(),
  lstat: vi.fn(),
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

import { readTextFile, readDir, exists, lstat, mkdir, writeTextFile } from '@tauri-apps/plugin-fs';
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
const mockLstat = vi.mocked(lstat);
const mockMkdir = vi.mocked(mkdir);
const mockWriteTextFile = vi.mocked(writeTextFile);

beforeEach(() => {
  vi.clearAllMocks();
  // Nothing in the virtual fixtures is a link, and every rules file in them is
  // a regular file rather than a directory or a pipe; the real-tree suite at
  // the bottom of this file overrides this with `lstatSync`.
  mockLstat.mockImplementation(
    async (p: string | URL) =>
      (String(p).endsWith('.md')
        ? { isSymlink: false, isFile: true, isDirectory: false }
        : { isSymlink: false, isFile: false, isDirectory: true }) as never,
  );
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

  it('truncates content exceeding 4000 chars at paragraph boundary', async () => {
    // Create content with paragraphs: paragraph break at ~3500 chars
    const para1 = 'a'.repeat(3500);
    const para2 = 'b'.repeat(2000);
    const longContent = para1 + '\n\n' + para2;
    mockReadTextFile.mockResolvedValue(longContent);
    const result = await loadUserRules();
    expect(result.length).toBeLessThan(5000);
    expect(result).toContain('user rules truncated');
    // Should truncate at the paragraph boundary (3500), not at 4000
    expect(result).toContain(para1);
    expect(result).not.toContain(para2);
  });

  it('truncates at hard limit when no suitable paragraph boundary', async () => {
    // Single long line with no paragraph breaks
    const longContent = 'x'.repeat(5000);
    mockReadTextFile.mockResolvedValue(longContent);
    const result = await loadUserRules();
    expect(result.length).toBeLessThan(5000);
    expect(result).toContain('user rules truncated');
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
    expect(result).toContain('User Rules');
    expect(result).toContain('user rules');
    expect(result).toContain('Project Rules');
    expect(result).toContain('project rules');
  });

  it('returns only user rules when workspacePath is null', async () => {
    mockReadTextFile.mockResolvedValue('user rules');
    const result = await loadAllRules(null);
    expect(result).toContain('user rules');
    expect(result).not.toContain('Project Rules (.abu/ABU.md)');
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
    expect(result).toContain('already exists');
  });

  it('creates template and rules directory', async () => {
    // First exists check (ABU.md) = false, rest = false
    mockExists.mockResolvedValue(false);
    mockMkdir.mockResolvedValue(undefined);
    mockWriteTextFile.mockResolvedValue(undefined);

    const result = await initWorkspaceRules('/workspace');
    expect(result).toContain('Created');
    expect(mockWriteTextFile).toHaveBeenCalledWith(
      '/workspace/.abu/ABU.md',
      expect.stringContaining('# Project Rules')
    );
    expect(mockMkdir).toHaveBeenCalled();
  });
});

/**
 * Everything below runs against a REAL temporary workspace containing REAL
 * symlinks, deliberately NOT the hand-written dirents above: every one of
 * those says `isDirectory: false` because it was typed that way, while a real
 * dirent for a LINK says `isDirectory: false` too — and that collision is the
 * whole defect. Only a real tree tells them apart.
 *
 * What makes this path different from an installer is the destination. These
 * bytes are spliced into the SYSTEM PROMPT (`orchestrator.ts` calls
 * `loadAllRules` on every non-fork prompt build) and sent to the model
 * provider, so following a link here is an outbound read of an arbitrary local
 * file — from a directory that arrived by `git clone`.
 */

/** What the non-blocking read hands back where the real host would block. */
const BYTES_FROM_A_PIPE = 'BYTES-FROM-A-PIPE';

/** Every path `useRealFs`'s readTextFile was asked for, in call order. */
let readTextTargets: string[] = [];

/** Point the mocked plugin-fs surface at the real filesystem, as fsHost does. */
function useRealFs() {
  mockReadDir.mockImplementation(async (p: string | URL) =>
    readdirSync(String(p), { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
      isSymlink: d.isSymbolicLink(),
    })) as never,
  );
  // `readFileSync` FOLLOWS a symlink — exactly what `plugin:fs|read_text_file`
  // does in the privileged host (electron/fsHost.cjs).
  //
  // EXCEPT on a non-regular file: a faithful read of a writer-less pipe never
  // returns, so a regression would HANG this run rather than fail it (the
  // blocked `readFileSync` stalls the worker's event loop, so vitest's own
  // timeout cannot fire either). Recording the call and handing back
  // recognisable bytes turns the defect into an assertion, as
  // `useNonBlockingReads` does in skill/installer.test.ts.
  readTextTargets = [];
  mockReadTextFile.mockImplementation(async (p: string | URL) => {
    readTextTargets.push(String(p));
    if (!lstatSync(String(p)).isFile()) return BYTES_FROM_A_PIPE;
    return readFileSync(String(p), 'utf8');
  });
  mockExists.mockImplementation(async (p: string | URL) => existsSync(String(p)));
  // `lstat` is the one call routed with `followFinalSymlink: false`. All three
  // flags, as `toFileInfo` (electron/fsHost.cjs) returns them: a caller asking
  // whether a rules file is a REGULAR file the workspace owns needs `isFile`
  // too, and answering only `isSymlink` would make a FIFO look ordinary here.
  mockLstat.mockImplementation(async (p: string | URL) => {
    const info = lstatSync(String(p));
    return {
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      isSymlink: info.isSymbolicLink(),
    } as never;
  });
}

describe('rules loading over a real workspace with real symlinks', () => {
  let root: string;
  let ws: string;
  let secret: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-rules-'));
    ws = join(root, 'cloned-repo');
    secret = join(root, 'id_rsa');

    mkdirSync(join(ws, '.abu', 'rules'), { recursive: true });
    writeFileSync(secret, '-----BEGIN OPENSSH PRIVATE KEY-----\nPROBE-KEY\n');
    writeFileSync(join(ws, '.abu', 'rules', 'benign.md'), 'benign project rule text');
    // What `git clone` materialises from a mode-120000 entry.
    symlinkSync(secret, join(ws, '.abu', 'rules', 'notes.md'));

    useRealFs();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    mockReadDir.mockReset();
    mockReadTextFile.mockReset();
    mockExists.mockReset();
    mockLstat.mockReset();
  });

  it('does not splice a linked rule file into the prompt', async () => {
    const result = await loadModularRules(ws);

    expect(result).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(result).not.toContain('### notes.md');
    // The repo's own real rule still loads — the refusal is per-entry, not a
    // bail-out that silently drops the whole rules directory.
    expect(result).toContain('benign project rule text');
  });

  it('names the file it left out on the console instead of failing silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadModularRules(ws);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('notes.md'));
    warn.mockRestore();
  });

  it('does not read a rules directory that is itself a link', async () => {
    // One extra indirection defeats a per-entry check on its own: the entries
    // inside the target are real files, so nothing below the directory looks
    // like a link at all.
    const other = join(root, 'elsewhere');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'stolen.md'), 'CONTENTS OF A DIRECTORY THE REPO DOES NOT OWN');

    const ws2 = join(root, 'repo2');
    mkdirSync(join(ws2, '.abu'), { recursive: true });
    symlinkSync(other, join(ws2, '.abu', 'rules'), 'dir');

    const result = await loadModularRules(ws2);

    expect(result).toBe('');
  });

  it('does not follow a linked {workspace}/.abu/ABU.md', async () => {
    // The same defect one function away: `loadProjectRules` reads a
    // workspace-controlled path with the same following `readTextFile`.
    const ws3 = join(root, 'repo3');
    mkdirSync(join(ws3, '.abu'), { recursive: true });
    symlinkSync(secret, join(ws3, '.abu', 'ABU.md'));

    const result = await loadProjectRules(ws3);

    expect(result).toBe('');
  });

  it.skipIf(process.platform === 'win32')('does not read a {workspace}/.abu/ABU.md that is a FIFO', async () => {
    // A FIFO is the one non-regular shape a link test does not catch: `lstat`
    // answers `isSymlink: false` for it. `safeReadTextFile`'s try/catch is no
    // help either — a writer-less pipe does not throw, it blocks the privileged
    // host's `readFileSync` on the MAIN process event loop, and `loadAllRules`
    // runs on every non-fork system-prompt build. Same predicate as the sibling
    // `loadModularRules` four lines below it.
    const ws5 = join(root, 'repo5');
    mkdirSync(join(ws5, '.abu'), { recursive: true });
    execFileSync('mkfifo', [join(ws5, '.abu', 'ABU.md')]);

    const result = await loadProjectRules(ws5);

    expect(result).toBe('');
    // The read that would have frozen the main process was never issued.
    expect(readTextTargets).not.toContain(join(ws5, '.abu', 'ABU.md'));
  });

  it('does not read through a {workspace}/.abu that is itself a link', async () => {
    // One level above the gated files. Gating ABU.md and rules/ but not the
    // directory holding them leaves the same read one indirection away: the
    // target's ABU.md and rules/*.md are ordinary files, so nothing below `.abu`
    // looks like a link at all.
    const donor = join(root, 'donor-abu');
    mkdirSync(join(donor, 'rules'), { recursive: true });
    writeFileSync(join(donor, 'ABU.md'), 'RULES THE REPO DOES NOT OWN');
    writeFileSync(join(donor, 'rules', 'stolen.md'), 'MORE RULES THE REPO DOES NOT OWN');

    const ws6 = join(root, 'repo6');
    mkdirSync(ws6, { recursive: true });
    symlinkSync(donor, join(ws6, '.abu'), 'dir');

    expect(await loadProjectRules(ws6)).toBe('');
    expect(await loadModularRules(ws6)).toBe('');
  });

  it('applies no link gate to ~/.abu/ABU.md, which the user placed there', async () => {
    // Deliberate asymmetry, pinned so it is not "tidied up" by accident: $HOME
    // is the user's own configuration, where `~/.abu/ABU.md -> ~/dotfiles/abu.md`
    // is a dotfile-farm convention and no repository can plant it. The rule is
    // "what the opened workspace controls is hostile", not "links are bad".
    //
    // Asserted through lstat rather than a fixture because `homeDir()` is
    // cached in module scope after the suites above have already resolved it.
    mockLstat.mockClear();
    await loadUserRules();
    expect(mockLstat).not.toHaveBeenCalled();

    // …while the workspace-controlled twin is gated.
    const ws4 = join(root, 'repo4');
    mkdirSync(join(ws4, '.abu'), { recursive: true });
    writeFileSync(join(ws4, '.abu', 'ABU.md'), 'real rules');
    await loadProjectRules(ws4);
    expect(mockLstat).toHaveBeenCalledWith(join(ws4, '.abu', 'ABU.md'));
  });
});
