import { beforeEach, describe, expect, it, vi } from 'vitest';

const promoteStreamSnapshotsMock = vi.fn<(convId: string) => Promise<number>>();
const flushAndGetLedgerWatermarkMock = vi.fn<(convId: string) => Promise<number>>();
const hasArmedStreamSnapshotMock = vi.fn<(convId: string) => boolean>();

vi.mock('./conversationStorage', () => ({
  promoteStreamSnapshots: (convId: string) => promoteStreamSnapshotsMock(convId),
  flushAndGetLedgerWatermark: (convId: string) => flushAndGetLedgerWatermarkMock(convId),
  hasArmedStreamSnapshot: (convId: string) => hasArmedStreamSnapshotMock(convId),
}));

const { LedgerHistoryPointError, takeLedgerHistoryPoint } = await import('./ledgerHistoryPoint');

describe('takeLedgerHistoryPoint (#549 P2a)', () => {
  beforeEach(() => {
    promoteStreamSnapshotsMock.mockReset();
    promoteStreamSnapshotsMock.mockResolvedValue(0);
    flushAndGetLedgerWatermarkMock.mockReset();
    flushAndGetLedgerWatermarkMock.mockResolvedValue(4096);
    hasArmedStreamSnapshotMock.mockReset();
    hasArmedStreamSnapshotMock.mockReturnValue(false);
  });

  it('costs one round when nothing arms while the point is taken', async () => {
    promoteStreamSnapshotsMock.mockResolvedValue(1);

    await expect(takeLedgerHistoryPoint('conv-1')).resolves.toEqual({
      ledgerWatermark: 4096,
      promotedSnapshotEntries: 1,
    });

    expect(promoteStreamSnapshotsMock.mock.calls).toEqual([['conv-1']]);
    expect(flushAndGetLedgerWatermarkMock.mock.calls).toEqual([['conv-1']]);
    expect(hasArmedStreamSnapshotMock.mock.calls).toEqual([['conv-1']]);
  });

  it('covers a revision armed between the promotion and the watermark in the next round', async () => {
    promoteStreamSnapshotsMock.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    flushAndGetLedgerWatermarkMock.mockResolvedValueOnce(4096).mockResolvedValueOnce(8192);
    hasArmedStreamSnapshotMock.mockReturnValueOnce(true).mockReturnValue(false);

    await expect(takeLedgerHistoryPoint('conv-1')).resolves.toEqual({
      ledgerWatermark: 8192,
      promotedSnapshotEntries: 2,
    });

    expect(promoteStreamSnapshotsMock).toHaveBeenCalledTimes(2);
    expect(flushAndGetLedgerWatermarkMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after three rounds of a conversation that keeps arming revisions', async () => {
    promoteStreamSnapshotsMock.mockResolvedValue(1);
    hasArmedStreamSnapshotMock.mockReturnValue(true);

    const point = takeLedgerHistoryPoint('conv-1');

    await expect(point).rejects.toBeInstanceOf(LedgerHistoryPointError);
    await expect(point).rejects.toMatchObject({ name: 'LedgerHistoryPointError', conversationId: 'conv-1' });
    expect(promoteStreamSnapshotsMock).toHaveBeenCalledTimes(3);
    expect(flushAndGetLedgerWatermarkMock).toHaveBeenCalledTimes(3);
  });

  it('propagates a rejected promotion without taking a watermark', async () => {
    promoteStreamSnapshotsMock.mockRejectedValue(new Error('disk full'));

    await expect(takeLedgerHistoryPoint('conv-1')).rejects.toThrow('disk full');
    expect(flushAndGetLedgerWatermarkMock).not.toHaveBeenCalled();
  });
});
