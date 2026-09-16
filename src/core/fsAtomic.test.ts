import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exists, remove, rename, mkdir } from '@tauri-apps/plugin-fs';

// ── Mocks ──────────────────────────────────────────────────────────
// Fully mock plugin-fs so we can drive a fake filesystem in-memory.
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn().mockResolvedValue(false),
  remove: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { atomicInstallDir } from './fsAtomic';

const mockExists = vi.mocked(exists);
const mockRemove = vi.mocked(remove);
const mockRename = vi.mocked(rename);
const mockMkdir = vi.mocked(mkdir);

const TARGET = '/Users/test/.abu/skills/dj-data-agent';
const WORK_DIR = '/Users/test/.abu/skill-staging';

describe('atomicInstallDir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExists.mockResolvedValue(false);
    mockRemove.mockResolvedValue(undefined as never);
    mockRename.mockResolvedValue(undefined as never);
    mockMkdir.mockResolvedValue(undefined as never);
  });

  it('installs into the target when it does not exist yet', async () => {
    let stagingSeen = '';
    await atomicInstallDir({
      targetDir: TARGET,
      workDir: WORK_DIR,
      write: async (stagingDir) => {
        stagingSeen = stagingDir;
      },
    });

    // staging dir lives under workDir and is named after the target
    expect(stagingSeen.startsWith(`${WORK_DIR}/dj-data-agent`)).toBe(true);
    // staging -> target swap happened
    expect(mockRename).toHaveBeenCalledWith(stagingSeen, TARGET);
  });

  it('rolls back when write() throws: staging is cleaned up and target is never touched', async () => {
    let stagingSeen = '';
    await expect(
      atomicInstallDir({
        targetDir: TARGET,
        workDir: WORK_DIR,
        write: async (stagingDir) => {
          stagingSeen = stagingDir;
          throw new Error('disk error');
        },
      }),
    ).rejects.toThrow('disk error');

    // staging cleaned up
    const removed = mockRemove.mock.calls.map((c) => String(c[0]));
    expect(removed).toContain(stagingSeen);
    // never renamed anything (no swap attempted)
    expect(mockRename).not.toHaveBeenCalled();
  });

  it('replaces an existing target with the newly written content', async () => {
    mockExists.mockImplementation(async (p: string | URL) => String(p) === TARGET);
    let stagingSeen = '';

    await atomicInstallDir({
      targetDir: TARGET,
      workDir: WORK_DIR,
      write: async (stagingDir) => {
        stagingSeen = stagingDir;
      },
    });

    const renames = mockRename.mock.calls.map((c) => [String(c[0]), String(c[1])]);
    // existing target moved aside to a backup dir first (name derived from target, under workDir)
    const backupCall = renames.find(([from]) => from === TARGET);
    expect(backupCall).toBeTruthy();
    expect(String(backupCall![1])).toContain(`${WORK_DIR}/__backup__dj-data-agent`);
    // then staging swapped into place
    expect(renames).toContainEqual([stagingSeen, TARGET]);
  });

  it('rolls back to the original content when target exists and write() throws (no data loss)', async () => {
    mockExists.mockImplementation(async (p: string | URL) => String(p) === TARGET);
    let stagingSeen = '';

    await expect(
      atomicInstallDir({
        targetDir: TARGET,
        workDir: WORK_DIR,
        write: async (stagingDir) => {
          stagingSeen = stagingDir;
          throw new Error('disk error');
        },
      }),
    ).rejects.toThrow('disk error');

    // Original target was never moved aside because write() failed before the swap phase.
    expect(mockRename).not.toHaveBeenCalled();
    // staging (which never got real content) is cleaned up
    const removed = mockRemove.mock.calls.map((c) => String(c[0]));
    expect(removed).toContain(stagingSeen);
  });

  it('restores the original target if the staging -> target swap rename fails (no data loss)', async () => {
    mockExists.mockImplementation(async (p: string | URL) => String(p) === TARGET);
    let backupSeen = '';
    mockRename.mockImplementation(async (from: string | URL, to: string | URL) => {
      if (String(to) === TARGET && String(from) !== backupSeen) {
        // this is the staging -> target swap attempt (as opposed to the restore call)
        if (String(from).includes(`${WORK_DIR}/dj-data-agent`)) {
          throw new Error('swap failed');
        }
      }
      return undefined as never;
    });

    await atomicInstallDir({
      targetDir: TARGET,
      workDir: WORK_DIR,
      write: async () => {},
    }).catch((e) => {
      expect(String(e.message)).toBe('swap failed');
    });

    // capture the backup dir from the first rename call (target -> backup)
    const firstRename = mockRename.mock.calls[0];
    backupSeen = String(firstRename[1]);
    expect(String(firstRename[0])).toBe(TARGET);
    expect(backupSeen).toContain(`${WORK_DIR}/__backup__dj-data-agent`);

    const renames = mockRename.mock.calls.map((c) => [String(c[0]), String(c[1])]);
    // backup was restored back onto the live target
    expect(renames).toContainEqual([backupSeen, TARGET]);
  });

  it('drops the backup dir after a successful overwrite (no leftover garbage)', async () => {
    mockExists.mockImplementation(async (p: string | URL) => String(p) === TARGET);

    await atomicInstallDir({
      targetDir: TARGET,
      workDir: WORK_DIR,
      write: async () => {},
    });

    const backupRename = mockRename.mock.calls.find(([from]) => String(from) === TARGET);
    const backupDir = String(backupRename![1]);
    const removed = mockRemove.mock.calls.map((c) => String(c[0]));
    expect(removed).toContain(backupDir);
    // the live target itself must never be removed directly (only renamed/backed up)
    expect(removed).not.toContain(TARGET);
  });

  it('cleans up a pre-existing stale staging dir before writing', async () => {
    // Simulate a leftover staging dir from a previous crashed install by making
    // exist() report true for anything under workDir that isn't the target.
    mockExists.mockImplementation(async (p: string | URL) => String(p).startsWith(WORK_DIR));

    await atomicInstallDir({
      targetDir: TARGET,
      workDir: WORK_DIR,
      write: async () => {},
    });

    const removed = mockRemove.mock.calls.map((c) => String(c[0]));
    expect(removed.some((p) => p.startsWith(`${WORK_DIR}/dj-data-agent`))).toBe(true);
  });

  it('defaults workDir to the parent of targetDir when not provided', async () => {
    let stagingSeen = '';
    await atomicInstallDir({
      targetDir: TARGET,
      write: async (stagingDir) => {
        stagingSeen = stagingDir;
      },
    });
    expect(stagingSeen.startsWith('/Users/test/.abu/skills/dj-data-agent')).toBe(true);
    // must NOT literally equal targetDir itself (would collide with the real target)
    expect(stagingSeen).not.toBe(TARGET);
    expect(mockMkdir).toHaveBeenCalledWith('/Users/test/.abu/skills', { recursive: true });
  });

  it('generates non-colliding staging dir names across concurrent calls for the same target', async () => {
    const seen: string[] = [];
    await Promise.all([
      atomicInstallDir({
        targetDir: TARGET,
        workDir: WORK_DIR,
        write: async (stagingDir) => {
          seen.push(stagingDir);
        },
      }),
      atomicInstallDir({
        targetDir: TARGET,
        workDir: WORK_DIR,
        write: async (stagingDir) => {
          seen.push(stagingDir);
        },
      }),
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});
