import { describe, it, expect, vi, beforeEach } from 'vitest';
import { posix } from 'node:path';
import * as fs from '@tauri-apps/plugin-fs';
import {
  appendHistoryEntry,
  readHistory,
  writeTombstone,
  revertTurn,
  newTurnId,
  type HistoryEntry,
} from './history';
import * as atomicFs from '../../utils/atomicFs';
import { getI18n } from '../../i18n';

// The organization's skill blacklist hook: allows everything but one name.
vi.mock('@/core/enterprise/policy/matcher', () => ({
  checkSkill: vi.fn((_policy: unknown, name: string) =>
    name === 'blocked-skill' ? { decision: 'deny', reason: 'blocked by policy' } : { decision: 'allow' }),
}));

// Real Tauri fs is mocked globally; we emulate an in-memory file
// system here so read-modify-write flows (like appendHistoryEntry
// re-reading its own writes) behave realistically.
const inMemoryFs = new Map<string, string>();
const inMemoryDirs = new Set<string>();

vi.mock('../../utils/atomicFs', async () => {
  const actual = await vi.importActual<typeof atomicFs>('../../utils/atomicFs');
  return {
    ...actual,
    atomicWrite: vi.fn().mockResolvedValue(undefined),
    restoreFromBackup: vi.fn().mockResolvedValue(undefined),
  };
});

const mockReadTextFile = vi.mocked(fs.readTextFile);
const mockWriteTextFile = vi.mocked(fs.writeTextFile);
const mockExists = vi.mocked(fs.exists);
const mockMkdir = vi.mocked(fs.mkdir);
const mockRemove = vi.mocked(fs.remove);
const mockAtomicWrite = vi.mocked(atomicFs.atomicWrite);
const mockRestoreFromBackup = vi.mocked(atomicFs.restoreFromBackup);

/**
 * The privileged host resolves before it acts: `resolveScoped`
 * (electron/fsHost.cjs) runs `path.resolve` on every path it is handed, so
 * `<skillDir>/../../x` reaches the syscall as the collapsed `/x`. Keying this
 * store on the raw string instead would make an escaping path address a slot
 * nothing else uses — i.e. would hide a traversal rather than reveal it.
 */
function at(path: string | URL): string {
  return posix.normalize(String(path));
}

beforeEach(() => {
  vi.clearAllMocks();
  inMemoryFs.clear();
  inMemoryDirs.clear();

  // Wire the Tauri fs mocks to our in-memory store so sequential
  // append/read cycles reflect each other.
  mockReadTextFile.mockImplementation(async (path) => {
    const content = inMemoryFs.get(at(path));
    if (content === undefined) throw new Error(`ENOENT: ${at(path)}`);
    return content;
  });
  mockWriteTextFile.mockImplementation(async (path, content) => {
    inMemoryFs.set(at(path), String(content));
  });
  mockExists.mockImplementation(async (path) => {
    return inMemoryFs.has(at(path)) || inMemoryDirs.has(at(path));
  });
  mockMkdir.mockImplementation(async (path) => {
    inMemoryDirs.add(at(path));
  });
  mockRemove.mockImplementation(async (path) => {
    inMemoryFs.delete(at(path));
  });
  mockAtomicWrite.mockImplementation(async (path, content) => {
    inMemoryFs.set(at(path), String(content));
  });
  mockRestoreFromBackup.mockImplementation(async (target, backup) => {
    const backupContent = inMemoryFs.get(at(backup));
    if (backupContent === undefined) throw new Error('backup missing');
    inMemoryFs.set(at(target), backupContent);
    inMemoryFs.delete(at(backup)); // restoreFromBackup consumes the backup
  });
});

const SKILL_DIR = '/ws/skills/weekly-digest';

describe('history · newTurnId', () => {
  it('generates unique IDs on successive calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => newTurnId()));
    expect(ids.size).toBe(20);
  });
});

describe('history · appendHistoryEntry + readHistory', () => {
  it('writes a JSONL entry and reads it back', async () => {
    await appendHistoryEntry(SKILL_DIR, {
      turnId: 't1',
      op: 'patch',
      files: [{ relPath: 'SKILL.md', snapshotPath: '/b.backup', action: 'modified' }],
      summary: 'replace step 3',
    });

    const entries = await readHistory(SKILL_DIR);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      turnId: 't1',
      op: 'patch',
      summary: 'replace step 3',
    });
    expect(typeof entries[0].ts).toBe('number');
  });

  it('accumulates entries and returns newest first', async () => {
    await appendHistoryEntry(SKILL_DIR, {
      turnId: 't-old',
      ts: 1_000,
      op: 'patch',
      files: [],
    });
    await appendHistoryEntry(SKILL_DIR, {
      turnId: 't-new',
      ts: 2_000,
      op: 'edit',
      files: [],
    });

    const entries = await readHistory(SKILL_DIR);
    expect(entries.map((e) => e.turnId)).toEqual(['t-new', 't-old']);
  });

  it('returns [] when no history file exists', async () => {
    expect(await readHistory(SKILL_DIR)).toEqual([]);
  });

  it('skips malformed lines without crashing', async () => {
    // Hand-craft an index.jsonl with a broken middle row — a partial
    // write from a crashed session should not blind the rest of the log.
    const indexPath = `${SKILL_DIR}/.history/index.jsonl`;
    const good1 = JSON.stringify({ turnId: 'a', ts: 1, op: 'edit', files: [] });
    const garbage = '{not valid json';
    const good2 = JSON.stringify({ turnId: 'b', ts: 2, op: 'patch', files: [] });
    inMemoryFs.set(indexPath, [good1, garbage, good2].join('\n') + '\n');

    const entries = await readHistory(SKILL_DIR);
    expect(entries.map((e) => e.turnId).sort()).toEqual(['a', 'b']);
  });

  it('skips entries missing critical fields', async () => {
    const indexPath = `${SKILL_DIR}/.history/index.jsonl`;
    const valid = JSON.stringify({ turnId: 'ok', ts: 1, op: 'edit', files: [] });
    const missingFiles = JSON.stringify({ turnId: 'x', ts: 2, op: 'edit' });
    const missingTs = JSON.stringify({ turnId: 'y', op: 'edit', files: [] });
    inMemoryFs.set(
      indexPath,
      [valid, missingFiles, missingTs].join('\n') + '\n',
    );

    const entries = await readHistory(SKILL_DIR);
    expect(entries.map((e) => e.turnId)).toEqual(['ok']);
  });
});

describe('history · writeTombstone', () => {
  it('copies file content to the tombstones directory', async () => {
    const sourcePath = `${SKILL_DIR}/scripts/build.sh`;
    inMemoryFs.set(sourcePath, '#!/bin/bash\necho hi\n');

    const tombstonePath = await writeTombstone(SKILL_DIR, 'scripts/build.sh', 1_700_000_000);

    expect(tombstonePath).toContain('tombstones');
    expect(tombstonePath).toContain('1700000000');
    // Slashes in the relPath get flattened so tombstones/ stays flat.
    expect(tombstonePath).toContain('scripts__build.sh');
    // Content preserved.
    expect(inMemoryFs.get(tombstonePath!)).toBe('#!/bin/bash\necho hi\n');
  });

  it('returns null when the source file does not exist', async () => {
    const tombstonePath = await writeTombstone(SKILL_DIR, 'scripts/nope.sh');
    expect(tombstonePath).toBeNull();
  });
});

describe('history · revertTurn', () => {
  async function seed(entry: Omit<HistoryEntry, 'ts'>) {
    await appendHistoryEntry(SKILL_DIR, entry);
  }

  it("restores a 'modified' file from its backup", async () => {
    const backupPath = `${SKILL_DIR}/.SKILL.md.backup.1700000000`;
    inMemoryFs.set(backupPath, 'old content');
    inMemoryFs.set(`${SKILL_DIR}/SKILL.md`, 'new content');
    await seed({
      turnId: 'turn-1',
      op: 'patch',
      files: [{ relPath: 'SKILL.md', snapshotPath: backupPath, action: 'modified' }],
    });

    const result = await revertTurn(SKILL_DIR, 'turn-1');
    expect(result.ok).toBe(true);
    expect(result.restored).toBe(1);
    expect(inMemoryFs.get(`${SKILL_DIR}/SKILL.md`)).toBe('old content');
  });

  it("will not restore a SKILL.md that brings back a name the organization's policy blocks", async () => {
    // The skill was renamed away from a blocked name; undoing that rename is a
    // write under the blocked name.
    const backupPath = `${SKILL_DIR}/.SKILL.md.backup.1700000000`;
    inMemoryFs.set(backupPath, '---\nname: blocked-skill\ndescription: x\n---\n# body');
    inMemoryFs.set(`${SKILL_DIR}/SKILL.md`, '---\nname: renamed\ndescription: x\n---\n# body');
    await seed({
      turnId: 'turn-rename',
      op: 'patch',
      files: [{ relPath: 'SKILL.md', snapshotPath: backupPath, action: 'modified' }],
    });

    const result = await revertTurn(SKILL_DIR, 'turn-rename');

    expect(result).toMatchObject({
      ok: false,
      restored: 0,
      failed: [{ relPath: 'SKILL.md', reason: getI18n().toolbox.skillNamePolicyHint }],
    });
    expect(mockRestoreFromBackup).not.toHaveBeenCalled();
    expect(inMemoryFs.get(`${SKILL_DIR}/SKILL.md`)).toContain('name: renamed');
  });

  it('still restores a SKILL.md whose name the policy allows', async () => {
    const backupPath = `${SKILL_DIR}/.SKILL.md.backup.1700000000`;
    inMemoryFs.set(backupPath, '---\nname: earlier-name\ndescription: x\n---\n# body');
    await seed({
      turnId: 'turn-ok',
      op: 'patch',
      files: [{ relPath: 'SKILL.md', snapshotPath: backupPath, action: 'modified' }],
    });

    const result = await revertTurn(SKILL_DIR, 'turn-ok');

    expect(result.restored).toBe(1);
    expect(mockRestoreFromBackup).toHaveBeenCalled();
  });

  it("removes a 'created' file (revert of create = delete)", async () => {
    inMemoryFs.set(`${SKILL_DIR}/scripts/new.sh`, 'new file content');
    await seed({
      turnId: 'turn-create',
      op: 'write_file',
      files: [{ relPath: 'scripts/new.sh', snapshotPath: null, action: 'created' }],
    });

    const result = await revertTurn(SKILL_DIR, 'turn-create');
    expect(result.ok).toBe(true);
    expect(result.restored).toBe(1);
    expect(inMemoryFs.has(`${SKILL_DIR}/scripts/new.sh`)).toBe(false);
  });

  it("restores a 'removed' file from tombstone and consumes the tombstone", async () => {
    const tombstonePath = `${SKILL_DIR}/.history/tombstones/1700-scripts__build.sh`;
    inMemoryFs.set(tombstonePath, 'deleted content');
    // The file is currently absent (was removed by remove_file).
    await seed({
      turnId: 'turn-rm',
      op: 'remove_file',
      files: [{ relPath: 'scripts/build.sh', snapshotPath: tombstonePath, action: 'removed' }],
    });

    const result = await revertTurn(SKILL_DIR, 'turn-rm');
    expect(result.ok).toBe(true);
    expect(inMemoryFs.get(`${SKILL_DIR}/scripts/build.sh`)).toBe('deleted content');
    // Tombstone is consumed so a second revert of the same entry won't silently re-restore.
    expect(inMemoryFs.has(tombstonePath)).toBe(false);
  });

  it('reports missing-snapshot failures without crashing', async () => {
    // The backup path in the entry points at a file that is no longer there —
    // could happen if a user manually nuked .history/ or ran into disk
    // issues. Revert should degrade gracefully. (Inside the skill directory,
    // which is where every backup this tool writes lives; one outside it is a
    // different failure and has its own test below.)
    await seed({
      turnId: 'turn-stale',
      op: 'patch',
      files: [
        {
          relPath: 'SKILL.md',
          snapshotPath: `${SKILL_DIR}/.SKILL.md.backup.1699999999`,
          action: 'modified',
        },
      ],
    });

    const result = await revertTurn(SKILL_DIR, 'turn-stale');
    expect(result.ok).toBe(false);
    expect(result.restored).toBe(0);
    expect(result.failed[0].reason).toMatch(/no longer exists|backup/i);
  });

  it('errors when the turnId is not in the log', async () => {
    const result = await revertTurn(SKILL_DIR, 'turn-ghost');
    expect(result.ok).toBe(false);
    expect(result.failed[0].reason).toMatch(/turn not found/i);
  });

  it('records a matching revert entry in the log (audit trail)', async () => {
    // Revert is a product-level, user-initiated action — the log must
    // reflect it as its own row so later review shows "X happened,
    // then Y was reverted" rather than silently rewriting history.
    const backupPath = `${SKILL_DIR}/.SKILL.md.backup.1`;
    inMemoryFs.set(backupPath, 'old');
    inMemoryFs.set(`${SKILL_DIR}/SKILL.md`, 'new');
    await seed({
      turnId: 'original',
      op: 'patch',
      files: [{ relPath: 'SKILL.md', snapshotPath: backupPath, action: 'modified' }],
    });

    await revertTurn(SKILL_DIR, 'original');

    const entries = await readHistory(SKILL_DIR);
    const revertEntry = entries.find((e) => e.op === 'revert');
    expect(revertEntry).toBeDefined();
    expect(revertEntry?.revertedTurnId).toBe('original');
  });

  it('partial restore: at least one file succeeded → ok=true, failures listed', async () => {
    // Turn touched two files; backup for one is still on disk, the
    // other is gone. Revert should restore what it can and report the
    // rest — don't block progress on the recoverable half.
    const goodBackup = `${SKILL_DIR}/.a.backup`;
    inMemoryFs.set(goodBackup, 'old a');
    inMemoryFs.set(`${SKILL_DIR}/a.md`, 'new a');
    inMemoryFs.set(`${SKILL_DIR}/b.md`, 'new b');

    await seed({
      turnId: 'mixed',
      op: 'patch',
      files: [
        { relPath: 'a.md', snapshotPath: goodBackup, action: 'modified' },
        { relPath: 'b.md', snapshotPath: `${SKILL_DIR}/.b.md.backup.1`, action: 'modified' },
      ],
    });

    const result = await revertTurn(SKILL_DIR, 'mixed');
    expect(result.ok).toBe(true);
    expect(result.restored).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].relPath).toBe('b.md');
    expect(inMemoryFs.get(`${SKILL_DIR}/a.md`)).toBe('old a');
    // b.md untouched — failed restores don't mutate target state.
    expect(inMemoryFs.get(`${SKILL_DIR}/b.md`)).toBe('new b');
  });
});

/**
 * `.history/index.jsonl` lives INSIDE the skill directory, so it is package
 * content: the loader scans `{workspace}/.abu/skills` as source `project`
 * (loader.ts) and `git clone` carries the file like any other, and the npm and
 * URL installers write `.history/` straight into the staged skill. The History
 * menu item is offered for every skill regardless of source
 * (SkillsSection.tsx), so reverting a turn somebody else authored is one click.
 *
 * `revertTurn` therefore has to treat every path in that file as hostile:
 * `joinPath` does not collapse `..`, and the privileged host's guard only asks
 * whether the RESOLVED path lands under an allowed root — `$HOME` among them,
 * with the `.abu` root basename as its only removal denial.
 */
describe('history · revertTurn refuses paths the skill does not own', () => {
  const VICTIM = '/Users/test/Documents/thesis.txt';

  async function seedRaw(entry: HistoryEntry) {
    inMemoryFs.set(`${SKILL_DIR}/.history/index.jsonl`, JSON.stringify(entry) + '\n');
  }

  it("does not delete a file outside the skill directory (action='created')", async () => {
    inMemoryFs.set(VICTIM, 'a thesis');
    await seedRaw({
      turnId: 'evil-created',
      ts: 1,
      op: 'write_file',
      files: [{ relPath: '../../../Users/test/Documents/thesis.txt', snapshotPath: null, action: 'created' }],
    });

    const result = await revertTurn(SKILL_DIR, 'evil-created');

    expect(inMemoryFs.get(VICTIM)).toBe('a thesis');
    expect(mockRemove).not.toHaveBeenCalled();
    expect(result.restored).toBe(0);
    expect(result.failed).toHaveLength(1);
  });

  it("does not overwrite a file outside the skill directory (action='removed')", async () => {
    inMemoryFs.set(VICTIM, 'a thesis');
    const tombstone = `${SKILL_DIR}/.history/tombstones/1-x`;
    inMemoryFs.set(tombstone, 'ATTACKER CONTENT');
    await seedRaw({
      turnId: 'evil-removed',
      ts: 1,
      op: 'remove_file',
      files: [
        { relPath: '../../../Users/test/Documents/thesis.txt', snapshotPath: tombstone, action: 'removed' },
      ],
    });

    const result = await revertTurn(SKILL_DIR, 'evil-removed');

    expect(inMemoryFs.get(VICTIM)).toBe('a thesis');
    expect(mockAtomicWrite).not.toHaveBeenCalled();
    expect(result.restored).toBe(0);
  });

  it('does not read or consume a snapshot outside the skill directory', async () => {
    // The snapshot pointer is the other half of the same trust: a genuine one
    // is either the `.backup.<ts>` alongside the target or a tombstone under
    // `.history/`, both inside the skill. An arbitrary one is a read of
    // somebody else's file followed by `remove` of it.
    const secret = '/Users/test/.ssh/id_rsa';
    inMemoryFs.set(secret, 'PRIVATE KEY BYTES');
    await seedRaw({
      turnId: 'evil-snapshot',
      ts: 1,
      op: 'remove_file',
      files: [{ relPath: 'notes.md', snapshotPath: secret, action: 'removed' }],
    });

    const result = await revertTurn(SKILL_DIR, 'evil-snapshot');

    expect(inMemoryFs.get(secret)).toBe('PRIVATE KEY BYTES');
    expect(inMemoryFs.has(`${SKILL_DIR}/notes.md`)).toBe(false);
    expect(mockRemove).not.toHaveBeenCalled();
    expect(result.restored).toBe(0);
  });

  it("does not restore a 'modified' file from a backup outside the skill directory", async () => {
    inMemoryFs.set('/Users/test/.ssh/id_rsa', 'PRIVATE KEY BYTES');
    await seedRaw({
      turnId: 'evil-backup',
      ts: 1,
      op: 'patch',
      files: [{ relPath: 'SKILL.md', snapshotPath: '/Users/test/.ssh/id_rsa', action: 'modified' }],
    });

    const result = await revertTurn(SKILL_DIR, 'evil-backup');

    expect(mockRestoreFromBackup).not.toHaveBeenCalled();
    expect(result.restored).toBe(0);
  });

  it('still reverts an ordinary turn whose paths the skill does own', async () => {
    // The rule is ownership, not a ban on reverting: a nested relPath and a
    // backup alongside its target are exactly what the tool writes.
    const backup = `${SKILL_DIR}/scripts/.build.sh.backup.1700`;
    inMemoryFs.set(backup, 'old script');
    inMemoryFs.set(`${SKILL_DIR}/scripts/build.sh`, 'new script');
    await seedRaw({
      turnId: 'honest',
      ts: 1,
      op: 'patch',
      files: [{ relPath: 'scripts/build.sh', snapshotPath: backup, action: 'modified' }],
    });

    const result = await revertTurn(SKILL_DIR, 'honest');

    expect(result.ok).toBe(true);
    expect(result.restored).toBe(1);
    expect(inMemoryFs.get(`${SKILL_DIR}/scripts/build.sh`)).toBe('old script');
  });
});
