import { describe, expect, it, vi } from 'vitest';
import { archivePluginOperation, runPluginOperation, type PluginOperationResult } from './operationBridge';

const runtime = { enabled: true, servers: {}, disabledSkills: {}, disabledAgents: {} };
const restored: PluginOperationResult = { id: 'op', key: 'demo@market', phase: 'restored', runtime };
const committed: PluginOperationResult = { ...restored, phase: 'committed' };
function fixture() {
  const ports = {
    begin: vi.fn(async () => ({ id: 'op' })), stage: vi.fn(async () => 'new'),
    commit: vi.fn(async () => committed), apply: vi.fn(async (_result: PluginOperationResult) => {}),
    recover: vi.fn(async (): Promise<PluginOperationResult | null> => restored),
    acknowledge: vi.fn(async () => {}), unchanged: vi.fn(async () => {}),
  };
  return ports;
}
describe('durable plugin operation protocol', () => {
  it('stages, durably commits, applies runtime and only then acknowledges', async () => {
    const p = fixture();
    expect(await runPluginOperation(p)).toBe('new');
    expect(p.apply).toHaveBeenCalledWith(committed);
    expect(p.acknowledge.mock.invocationCallOrder[0]).toBeGreaterThan(p.apply.mock.invocationCallOrder[0]);
    expect(p.recover).not.toHaveBeenCalled();
  });
  it.each(['begin', 'stage', 'commit'] as const)('recovers when %s fails, including a lost begin response', async phase => {
    const p = fixture(); p[phase].mockRejectedValueOnce(new Error('interrupted'));
    await expect(runPluginOperation(p)).rejects.toThrow('interrupted');
    expect(p.apply).toHaveBeenCalledWith(restored);
    expect(p.acknowledge).toHaveBeenCalledWith('op');
  });
  it('uses the durable outcome when a commit response is lost', async () => {
    const p = fixture(); p.commit.mockRejectedValueOnce(new Error('response lost')); p.recover.mockResolvedValue(committed);
    expect(await runPluginOperation(p)).toBe('new');
    expect(p.apply).toHaveBeenCalledWith(committed);
  });
  it('keeps a journal pending if runtime restoration fails', async () => {
    const p = fixture(); p.stage.mockRejectedValueOnce(new Error('copy failed')); p.apply.mockRejectedValueOnce(new Error('storage full'));
    await expect(runPluginOperation(p)).rejects.toThrow('storage full');
    expect(p.acknowledge).not.toHaveBeenCalled();
  });
  it('restores unchanged preferences if begin was refused before creating a journal', async () => {
    const p = fixture(); p.begin.mockRejectedValueOnce(new Error('conflict')); p.recover.mockResolvedValue(null);
    await expect(runPluginOperation(p)).rejects.toThrow('conflict');
    expect(p.unchanged).toHaveBeenCalledOnce();
  });
  it('does not report failure or undo consent when acknowledgement response is lost', async () => {
    const p = fixture(); p.acknowledge.mockRejectedValueOnce(new Error('response lost')); p.recover.mockResolvedValue(null);
    expect(await runPluginOperation(p)).toBe('new');
    expect(p.unchanged).not.toHaveBeenCalled();
  });
});

/**
 * When the journal cannot be decrypted the user's only way forward is to move
 * it aside. That has to go through the host (the renderer has no filesystem),
 * and it has to carry the fingerprint the host reported — archiving by "the
 * current journal" would race a journal that was replaced in between.
 */
describe('archiving an unreadable journal', () => {
  const shell = () => globalThis as typeof globalThis & { __ABU_SHELL__?: unknown };

  it('archives the journal the user was shown and returns the surviving backups', async () => {
    const original = shell().__ABU_SHELL__;
    const outcome = { archivedPath: '/plugins/journal/active-1.enc.bak', backupPaths: ['/backups/weather-1'] };
    const host = vi.fn(async () => outcome);
    shell().__ABU_SHELL__ = { pluginOperation: host };
    try {
      await expect(archivePluginOperation('journal-identity')).resolves.toEqual(outcome);
      expect(host).toHaveBeenCalledExactlyOnceWith('archive', { fingerprint: 'journal-identity' });
    } finally { shell().__ABU_SHELL__ = original; }
  });

  it('refuses outside the desktop host rather than reporting a silent success', async () => {
    const original = shell().__ABU_SHELL__;
    shell().__ABU_SHELL__ = undefined;
    try {
      await expect(archivePluginOperation('journal-identity')).rejects.toThrow(/Electron desktop host/);
    } finally { shell().__ABU_SHELL__ = original; }
  });
});
