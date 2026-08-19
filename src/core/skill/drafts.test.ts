import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  readTextFile,
  readDir,
  exists,
  mkdir,
  remove,
} from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';

// rename isn't in the global mock — stub here before the module-under-test imports it.
vi.mock('@tauri-apps/plugin-fs', async () => {
  const actual = await vi.importActual<typeof import('@tauri-apps/plugin-fs')>(
    '@tauri-apps/plugin-fs',
  );
  return {
    ...actual,
    readTextFile: vi.fn().mockResolvedValue(''),
    readDir: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(false),
    mkdir: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    BaseDirectory: { AppData: 0, Home: 1 },
  };
});

// Pull rename out after the mock is registered (can't import it at top).
import * as fs from '@tauri-apps/plugin-fs';
const renameMock = vi.mocked(fs.rename);

import {
  writeDraft,
  writeSkillDirect,
  readDraft,
  listDrafts,
  acceptDraft,
  rejectDraft,
  cleanExpiredDrafts,
  emptyExpiredTrash,
} from './drafts';

const mockReadTextFile = vi.mocked(readTextFile);
const mockReadDir = vi.mocked(readDir);
const mockExists = vi.mocked(exists);
const mockMkdir = vi.mocked(mkdir);
const mockRemove = vi.mocked(remove);
const mockInvoke = vi.mocked(invoke);

const WS = '/Users/testuser/projects/myapp';
// sanitizePath('/Users/testuser/projects/myapp') → '-Users-testuser-projects-myapp'
const DRAFTS = '/Users/testuser/.abu/projects/-Users-testuser-projects-myapp/skills/drafts';
const SKILLS = '/Users/testuser/.abu/projects/-Users-testuser-projects-myapp/skills';

/**
 * Track an in-memory VFS so exists/readTextFile/readDir see consistent state
 * across one test. Each test seeds it via `seedVfs`.
 */
interface VfsFile { kind: 'file'; content: string }
interface VfsDir { kind: 'dir' }
type VfsEntry = VfsFile | VfsDir;

function makeVfs() {
  const entries = new Map<string, VfsEntry>();

  function seed(path: string, content?: string) {
    entries.set(path, content === undefined ? { kind: 'dir' } : { kind: 'file', content });
  }

  function install() {
    mockExists.mockImplementation(async (p: string) => entries.has(p));
    mockReadTextFile.mockImplementation(async (p: string) => {
      const e = entries.get(p);
      if (!e || e.kind !== 'file') throw new Error(`ENOENT ${p}`);
      return e.content;
    });
    mockReadDir.mockImplementation(async (p: string) => {
      const prefix = p.endsWith('/') ? p : p + '/';
      const children = new Map<string, 'file' | 'dir'>();
      for (const [k, v] of entries) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (!rest) continue;
        const name = rest.split('/')[0];
        const isLeaf = !rest.includes('/');
        if (isLeaf) {
          children.set(name, v.kind);
        } else {
          // intermediate — surface as dir
          if (!children.has(name)) children.set(name, 'dir');
        }
      }
      return Array.from(children.entries()).map(([name, kind]) => ({
        name,
        isFile: kind === 'file',
        isDirectory: kind === 'dir',
        isSymlink: false,
      })) as Awaited<ReturnType<typeof readDir>>;
    });
    mockMkdir.mockImplementation(async (p: string) => {
      entries.set(p, { kind: 'dir' });
    });
    mockRemove.mockImplementation(async (p: string) => {
      // remove entry + any descendants
      for (const k of Array.from(entries.keys())) {
        if (k === p || k.startsWith(p + '/')) entries.delete(k);
      }
    });
    renameMock.mockImplementation(async (from: string, to: string) => {
      const moves: Array<[string, string]> = [];
      for (const k of Array.from(entries.keys())) {
        if (k === from) moves.push([k, to]);
        else if (k.startsWith(from + '/')) moves.push([k, to + k.slice(from.length)]);
      }
      for (const [oldK, newK] of moves) {
        const v = entries.get(oldK)!;
        entries.delete(oldK);
        entries.set(newK, v);
      }
    });
    // atomicWrite invokes 'atomic_write_text' — capture the content so readTextFile can find it.
    mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'atomic_write_text') {
        const { path, content } = args as { path: string; content: string };
        entries.set(path, { kind: 'file', content });
        return undefined;
      }
      return undefined;
    });
  }

  return { seed, install, entries };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('drafts · writeDraft', () => {
  it('creates draft dir, SKILL.md, and sidecar meta', async () => {
    const vfs = makeVfs();
    vfs.install();

    const record = await writeDraft(
      'daily-report',
      '---\nname: daily-report\ndescription: d\n---\n# body',
      { action: 'create', triggerReason: '6 tool calls succeeded', proactivity: 'companion' },
      WS,
    );

    expect(record.skillName).toBe('daily-report');
    expect(record.skillDir).toBe(`${DRAFTS}/daily-report`);
    expect(record.skillMdPath).toBe(`${DRAFTS}/daily-report/SKILL.md`);
    expect(record.action).toBe('create');
    expect(record.triggerReason).toBe('6 tool calls succeeded');
    expect(record.expiresAt - record.createdAt).toBe(72 * 60 * 60 * 1000);

    // Both files were written via atomic_write_text
    const writes = mockInvoke.mock.calls.filter(([c]) => c === 'atomic_write_text');
    expect(writes).toHaveLength(2);
    const paths = writes.map(([, args]) => (args as { path: string }).path).sort();
    expect(paths).toEqual([
      `${DRAFTS}/daily-report/.abu-draft-meta.json`,
      `${DRAFTS}/daily-report/SKILL.md`,
    ]);
  });

  it('TTL depends on proactivity preset', async () => {
    const vfs = makeVfs();
    vfs.install();

    const shy = await writeDraft('s', '---\n---\n', { action: 'create', proactivity: 'shy' }, WS);
    const butler = await writeDraft('b', '---\n---\n', { action: 'create', proactivity: 'butler' }, WS);

    expect(shy.expiresAt - shy.createdAt).toBe(7 * 24 * 60 * 60 * 1000);
    expect(butler.expiresAt - butler.createdAt).toBe(24 * 60 * 60 * 1000);
  });

  it('ttlMs override wins over proactivity default', async () => {
    const vfs = makeVfs();
    vfs.install();

    const custom = await writeDraft(
      'x',
      '---\n---\n',
      { action: 'create', proactivity: 'companion', ttlMs: 1000 },
      WS,
    );
    expect(custom.expiresAt - custom.createdAt).toBe(1000);
  });
});

describe('drafts · writeSkillDirect', () => {
  it('writes to workspace-auto skills/{name}/SKILL.md bypassing drafts/', async () => {
    const vfs = makeVfs();
    vfs.install();

    const result = await writeSkillDirect(
      'daily-report',
      '---\nname: daily-report\n---\n# body',
      WS,
    );

    expect(result.skillMdPath).toBe(`${SKILLS}/daily-report/SKILL.md`);
    expect(result.skillDir).toBe(`${SKILLS}/daily-report`);
    // Crucially, path must NOT contain /drafts/
    expect(result.skillMdPath).not.toContain('/drafts/');
  });

  it('writes SKILL.md without creating a sidecar', async () => {
    const vfs = makeVfs();
    vfs.install();

    await writeSkillDirect('x', '---\n---\nbody', WS);

    const writes = mockInvoke.mock.calls.filter(([c]) => c === 'atomic_write_text');
    expect(writes).toHaveLength(1); // only SKILL.md, no sidecar
    expect((writes[0][1] as { path: string }).path).toMatch(/SKILL\.md$/);
  });

  it('creates parent skill directory recursively', async () => {
    const vfs = makeVfs();
    vfs.install();

    await writeSkillDirect('deep-skill', '---\n---\n', WS);

    // mkdir should have been called to establish the skill dir.
    expect(mockMkdir).toHaveBeenCalledWith(
      `${SKILLS}/deep-skill`,
      { recursive: true },
    );
  });
});

describe('drafts · listDrafts', () => {
  it('returns empty when drafts dir does not exist', async () => {
    const vfs = makeVfs();
    vfs.install();
    expect(await listDrafts(WS)).toEqual([]);
  });

  it('reads sidecars and sorts by createdAt desc', async () => {
    const vfs = makeVfs();
    vfs.seed(DRAFTS);
    vfs.seed(`${DRAFTS}/a`);
    vfs.seed(`${DRAFTS}/a/SKILL.md`, '---\nname: a\n---\nA');
    vfs.seed(
      `${DRAFTS}/a/.abu-draft-meta.json`,
      JSON.stringify({ action: 'create', triggerReason: 'A', createdAt: 100, expiresAt: 200 }),
    );
    vfs.seed(`${DRAFTS}/b`);
    vfs.seed(`${DRAFTS}/b/SKILL.md`, '---\nname: b\n---\nB');
    vfs.seed(
      `${DRAFTS}/b/.abu-draft-meta.json`,
      JSON.stringify({ action: 'create', triggerReason: 'B', createdAt: 200, expiresAt: 300 }),
    );
    vfs.install();

    const drafts = await listDrafts(WS);
    expect(drafts.map((d) => d.skillName)).toEqual(['b', 'a']); // newer first
  });

  it('skips the .trash directory and hidden dirs', async () => {
    const vfs = makeVfs();
    vfs.seed(DRAFTS);
    vfs.seed(`${DRAFTS}/.trash`);
    vfs.seed(`${DRAFTS}/.trash/old-123`);
    vfs.seed(`${DRAFTS}/.trash/old-123/SKILL.md`, '---\n---');
    vfs.seed(`${DRAFTS}/real`);
    vfs.seed(`${DRAFTS}/real/SKILL.md`, '---\n---\n');
    vfs.install();

    const drafts = await listDrafts(WS);
    expect(drafts.map((d) => d.skillName)).toEqual(['real']);
  });

  it('surfaces legacy drafts with fallback metadata when sidecar missing', async () => {
    const vfs = makeVfs();
    vfs.seed(DRAFTS);
    vfs.seed(`${DRAFTS}/legacy`);
    vfs.seed(`${DRAFTS}/legacy/SKILL.md`, '---\n---\n');
    vfs.install();

    const drafts = await listDrafts(WS);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].triggerReason).toContain('legacy');
    expect(drafts[0].expiresAt).toBeGreaterThan(drafts[0].createdAt);
  });

  it('skips directories without SKILL.md', async () => {
    const vfs = makeVfs();
    vfs.seed(DRAFTS);
    vfs.seed(`${DRAFTS}/incomplete`);
    // no SKILL.md
    vfs.install();

    expect(await listDrafts(WS)).toEqual([]);
  });
});

describe('drafts · readDraft', () => {
  it('returns null when draft not found', async () => {
    const vfs = makeVfs();
    vfs.install();
    expect(await readDraft('missing', WS)).toBeNull();
  });

  it('returns record with sidecar values', async () => {
    const vfs = makeVfs();
    vfs.seed(`${DRAFTS}/x`);
    vfs.seed(`${DRAFTS}/x/SKILL.md`, '---\n---\n');
    vfs.seed(
      `${DRAFTS}/x/.abu-draft-meta.json`,
      JSON.stringify({ action: 'create', triggerReason: 'hi', createdAt: 1, expiresAt: 2 }),
    );
    vfs.install();

    const d = await readDraft('x', WS);
    expect(d?.triggerReason).toBe('hi');
    expect(d?.createdAt).toBe(1);
  });
});

describe('drafts · acceptDraft', () => {
  it('moves draft dir to workspace-auto and strips sidecar', async () => {
    const vfs = makeVfs();
    vfs.seed(`${DRAFTS}/good`);
    vfs.seed(`${DRAFTS}/good/SKILL.md`, '---\n---\nbody');
    vfs.seed(`${DRAFTS}/good/.abu-draft-meta.json`, '{}');
    vfs.install();

    const { targetDir } = await acceptDraft('good', WS);
    expect(targetDir).toBe(`${SKILLS}/good`);

    // Sidecar removed before rename
    expect(mockRemove).toHaveBeenCalledWith(`${DRAFTS}/good/.abu-draft-meta.json`);
    // Rename to final location
    expect(renameMock).toHaveBeenCalledWith(`${DRAFTS}/good`, `${SKILLS}/good`);
  });

  it('refuses when a workspace-auto skill with the same name already exists', async () => {
    const vfs = makeVfs();
    vfs.seed(`${DRAFTS}/dup`);
    vfs.seed(`${DRAFTS}/dup/SKILL.md`, '---\n---\n');
    vfs.seed(`${SKILLS}/dup`);
    vfs.seed(`${SKILLS}/dup/SKILL.md`, '---\n---\n');
    vfs.install();

    await expect(acceptDraft('dup', WS)).rejects.toThrow(/already exists/);
    expect(renameMock).not.toHaveBeenCalled();
  });

  it('throws when the draft does not exist', async () => {
    const vfs = makeVfs();
    vfs.install();
    await expect(acceptDraft('ghost', WS)).rejects.toThrow(/not found/);
  });
});

describe('drafts · rejectDraft', () => {
  it('moves draft dir into .trash with timestamp suffix', async () => {
    const vfs = makeVfs();
    vfs.seed(`${DRAFTS}/bad`);
    vfs.seed(`${DRAFTS}/bad/SKILL.md`, '---\n---\n');
    vfs.install();

    const { trashDir } = await rejectDraft('bad', WS);
    expect(trashDir).toMatch(new RegExp(`^${DRAFTS}/\\.trash/bad-\\d+$`));
    expect(renameMock).toHaveBeenCalledWith(`${DRAFTS}/bad`, trashDir);
  });

  it('throws when draft missing', async () => {
    const vfs = makeVfs();
    vfs.install();
    await expect(rejectDraft('ghost', WS)).rejects.toThrow(/not found/);
  });
});

describe('drafts · cleanExpiredDrafts', () => {
  it('moves expired drafts to trash and leaves fresh ones alone', async () => {
    // Deterministic clock (TESTING.md §3) — cleanExpiredDrafts() reads Date.now()
    // directly (no injectable clock), so the seed must match production's read.
    vi.useFakeTimers();
    try {
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);
      const vfs = makeVfs();
      vfs.seed(DRAFTS);
      vfs.seed(`${DRAFTS}/old`);
      vfs.seed(`${DRAFTS}/old/SKILL.md`, '---\n---\n');
      vfs.seed(
        `${DRAFTS}/old/.abu-draft-meta.json`,
        JSON.stringify({ action: 'create', triggerReason: '', createdAt: now - 1e8, expiresAt: now - 1000 }),
      );
      vfs.seed(`${DRAFTS}/fresh`);
      vfs.seed(`${DRAFTS}/fresh/SKILL.md`, '---\n---\n');
      vfs.seed(
        `${DRAFTS}/fresh/.abu-draft-meta.json`,
        JSON.stringify({ action: 'create', triggerReason: '', createdAt: now, expiresAt: now + 1e6 }),
      );
      vfs.install();

      const swept = await cleanExpiredDrafts(WS);
      expect(swept).toBe(1);
      // old was renamed to trash
      const renames = renameMock.mock.calls.map((c) => c[0]);
      expect(renames).toContain(`${DRAFTS}/old`);
      expect(renames).not.toContain(`${DRAFTS}/fresh`);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('drafts · emptyExpiredTrash', () => {
  it('removes trash entries older than 7 days', async () => {
    // Deterministic clock (TESTING.md §3) — emptyExpiredTrash() reads Date.now()
    // directly (no injectable clock), so the seed must match production's read.
    vi.useFakeTimers();
    try {
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);
      const vfs = makeVfs();
      const oldTs = now - 8 * 24 * 60 * 60 * 1000;
      const freshTs = now - 1 * 24 * 60 * 60 * 1000;
      const trashRoot = `${DRAFTS}/.trash`;
      vfs.seed(trashRoot);
      vfs.seed(`${trashRoot}/old-${oldTs}`);
      vfs.seed(`${trashRoot}/fresh-${freshTs}`);
      vfs.install();

      const removed = await emptyExpiredTrash(WS);
      expect(removed).toBe(1);
      expect(mockRemove).toHaveBeenCalledWith(`${trashRoot}/old-${oldTs}`, { recursive: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns 0 when trash is absent', async () => {
    const vfs = makeVfs();
    vfs.install();
    expect(await emptyExpiredTrash(WS)).toBe(0);
  });
});
