import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exists, readTextFile, stat } from '@tauri-apps/plugin-fs';

const snapshotVersionMock = vi.fn();
vi.mock('@/utils/canvasVersions', () => ({
  snapshotVersion: (...args: unknown[]) => snapshotVersionMock(...args),
  // Real implementation (not a mock) — aiEditSnapshots.ts now imports this
  // shared helper instead of keeping its own private copy (2d dedup).
  normalizePath: (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, ''),
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
    // vi.clearAllMocks() clears call history but NOT a previously-set
    // permanent implementation (mockRejectedValue/mockResolvedValue) — a
    // couple of tests below set snapshotVersionMock to permanently reject to
    // exercise the fail-open path, which would otherwise leak into later
    // tests since this mock is a module-level const shared across the whole
    // file. mockReset() clears any such leftover implementation so every
    // test starts from the same resolved-by-default baseline.
    snapshotVersionMock.mockReset();
    snapshotVersionMock.mockResolvedValue(undefined);
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

  it('passes oversize knownContent straight through to snapshotVersion (cap enforcement moved to the store)', async () => {
    // 2M CJK chars ≈ 6MB UTF-8 (> 5MB cap) but .length is only 2M (< cap) —
    // this module no longer re-checks size for knownContent; snapshotVersion()
    // in canvasVersions.ts is now the single place that enforces the cap.
    const cjk = '中'.repeat(2 * 1024 * 1024);
    await mod.snapshotBeforeAiEdit('/w/cjk.html', { loopId: 'loop1', knownContent: cjk });
    expect(snapshotVersionMock).toHaveBeenCalledTimes(1);
    expect(snapshotVersionMock).toHaveBeenCalledWith('/w/cjk.html', cjk, expect.anything());
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

  describe('retry after transient failure', () => {
    it('retries on the next call after a transient snapshotVersion failure (does not stay marked forever)', async () => {
      snapshotVersionMock.mockRejectedValueOnce(new Error('disk full'));
      snapshotVersionMock.mockResolvedValueOnce(undefined);

      await mod.snapshotBeforeAiEdit('/w/a.html', { loopId: 'loop1' });
      await mod.snapshotBeforeAiEdit('/w/a.html', { loopId: 'loop1' });

      // The failed first attempt must not permanently mark the path as
      // touched — the second call is a real retry, not a dedupe no-op.
      expect(snapshotVersionMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry an intentional skip (missing file) — stays marked for the rest of the turn', async () => {
      vi.mocked(exists).mockResolvedValue(false);

      await mod.snapshotBeforeAiEdit('/w/new.html', { loopId: 'loop1' });
      await mod.snapshotBeforeAiEdit('/w/new.html', { loopId: 'loop1' });

      // Second call short-circuits at markTouched (already marked) and never
      // reaches the exists() check again.
      expect(vi.mocked(exists)).toHaveBeenCalledTimes(1);
      expect(snapshotVersionMock).not.toHaveBeenCalled();
    });
  });

  describe('LRU eviction of tracked loops', () => {
    it('evicts the least-recently-touched loop, not the oldest-created one', async () => {
      for (let i = 1; i <= 8; i++) {
        await mod.snapshotBeforeAiEdit('/w/lru.html', { loopId: `loop${i}` });
      }
      snapshotVersionMock.mockClear();

      // Re-touch loop1 (still a dedupe no-op for this same file) — this must
      // bump its recency so it is not the next eviction candidate.
      await mod.snapshotBeforeAiEdit('/w/lru.html', { loopId: 'loop1' });
      expect(snapshotVersionMock).not.toHaveBeenCalled();

      // A 9th distinct loop pushes the tracked set over MAX_TRACKED_LOOPS
      // (8), evicting the least-recently-touched entry — loop2, since loop1
      // was just bumped and loop3..loop8 are newer than loop2.
      await mod.snapshotBeforeAiEdit('/w/lru.html', { loopId: 'loop9' });

      snapshotVersionMock.mockClear();
      // loop1 is still tracked — its touch remains a dedupe no-op.
      await mod.snapshotBeforeAiEdit('/w/lru.html', { loopId: 'loop1' });
      expect(snapshotVersionMock).not.toHaveBeenCalled();

      // loop2 was evicted — its next touch is treated as a fresh first
      // touch, producing a new snapshot.
      await mod.snapshotBeforeAiEdit('/w/lru.html', { loopId: 'loop2' });
      expect(snapshotVersionMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('knownContent skips the exists() check', () => {
    it('does not call exists() when knownContent is provided', async () => {
      await mod.snapshotBeforeAiEdit('/w/known.html', { loopId: 'loop1', knownContent: 'already read' });
      expect(vi.mocked(exists)).not.toHaveBeenCalled();
      expect(snapshotVersionMock).toHaveBeenCalledWith('/w/known.html', 'already read', expect.anything());
    });
  });
});
