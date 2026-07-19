import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exists, readTextFile, stat } from '@tauri-apps/plugin-fs';

const snapshotVersionMock = vi.fn();
vi.mock('@/utils/canvasVersions', () => ({
  snapshotVersion: (...args: unknown[]) => snapshotVersionMock(...args),
}));

const getStateMock = vi.fn();
vi.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => getStateMock() },
}));

let mod: typeof import('./aiEditSnapshots');

describe('snapshotBeforeAiEdit', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(stat).mockResolvedValue({ size: 100 } as Awaited<ReturnType<typeof stat>>);
    vi.mocked(readTextFile).mockResolvedValue('disk content');
    getStateMock.mockReturnValue({ conversations: {} });
    mod = await import('./aiEditSnapshots');
  });

  it('snapshots on-disk content on first touch in a loop', async () => {
    await mod.snapshotBeforeAiEdit('/w/a.html', { loopId: 'loop1' });
    expect(snapshotVersionMock).toHaveBeenCalledTimes(1);
    expect(snapshotVersionMock).toHaveBeenCalledWith(
      '/w/a.html',
      'disk content',
      expect.objectContaining({ source: 'ai' })
    );
  });

  it('skips the second touch of the same file within the same loop', async () => {
    await mod.snapshotBeforeAiEdit('/w/a.html', { loopId: 'loop1' });
    await mod.snapshotBeforeAiEdit('/w/a.html', { loopId: 'loop1' });
    expect(snapshotVersionMock).toHaveBeenCalledTimes(1);
  });

  it('snapshots again for the same file in a different loop', async () => {
    await mod.snapshotBeforeAiEdit('/w/a.html', { loopId: 'loop1' });
    await mod.snapshotBeforeAiEdit('/w/a.html', { loopId: 'loop2' });
    expect(snapshotVersionMock).toHaveBeenCalledTimes(2);
  });

  it('attempts every time when loopId is missing (dedupe left to the store)', async () => {
    await mod.snapshotBeforeAiEdit('/w/a.html', {});
    await mod.snapshotBeforeAiEdit('/w/a.html', {});
    expect(snapshotVersionMock).toHaveBeenCalledTimes(2);
  });

  it('skips files that do not exist yet (no "before" state to capture)', async () => {
    vi.mocked(exists).mockResolvedValue(false);
    await mod.snapshotBeforeAiEdit('/w/new.html', { loopId: 'loop1' });
    expect(snapshotVersionMock).not.toHaveBeenCalled();
  });

  it('skips oversize files (> 5MB) without reading them', async () => {
    vi.mocked(stat).mockResolvedValue({ size: 6 * 1024 * 1024 } as Awaited<ReturnType<typeof stat>>);
    await mod.snapshotBeforeAiEdit('/w/huge.html', { loopId: 'loop1' });
    expect(snapshotVersionMock).not.toHaveBeenCalled();
    expect(vi.mocked(readTextFile)).not.toHaveBeenCalled();
  });

  it('uses knownContent without re-reading disk', async () => {
    await mod.snapshotBeforeAiEdit('/w/a.html', { loopId: 'loop1', knownContent: 'pre-read' });
    expect(vi.mocked(readTextFile)).not.toHaveBeenCalled();
    expect(snapshotVersionMock).toHaveBeenCalledWith('/w/a.html', 'pre-read', expect.anything());
  });

  it('skips oversize knownContent measured in real UTF-8 bytes (CJK undercount guard)', async () => {
    // 2M CJK chars ≈ 6MB UTF-8 (> 5MB cap) but .length is only 2M (< cap).
    const cjk = '中'.repeat(2 * 1024 * 1024);
    await mod.snapshotBeforeAiEdit('/w/cjk.html', { loopId: 'loop1', knownContent: cjk });
    expect(snapshotVersionMock).not.toHaveBeenCalled();
  });

  it('labels the snapshot with the latest non-system user message, truncated to 60 chars', async () => {
    getStateMock.mockReturnValue({
      conversations: {
        conv1: {
          messages: [
            { role: 'user', content: '旧消息' },
            { role: 'assistant', content: 'ok' },
            { role: 'user', content: 'A'.repeat(80) },
          ],
        },
      },
    });
    await mod.snapshotBeforeAiEdit('/w/a.html', { loopId: 'loop1', conversationId: 'conv1' });
    const meta = snapshotVersionMock.mock.calls[0][2] as { label?: string };
    expect(meta.label).toBe('A'.repeat(60) + '…');
  });

  it('never throws — snapshot failure is swallowed (fail-open)', async () => {
    snapshotVersionMock.mockRejectedValue(new Error('disk full'));
    await expect(mod.snapshotBeforeAiEdit('/w/a.html', { loopId: 'loop1' })).resolves.toBeUndefined();
  });

  it('never throws — stat failure is swallowed (fail-open)', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('EACCES'));
    await expect(mod.snapshotBeforeAiEdit('/w/a.html', { loopId: 'loop1' })).resolves.toBeUndefined();
  });
});
