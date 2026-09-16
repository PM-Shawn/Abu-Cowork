/**
 * Checkpoints are keyed by CONVERSATION, but a run's fire-and-forget teardown
 * can outlive its own visible terminal (see agentLoopRunner.ts's
 * `RunSession.terminalPublished`). By then the next turn may already own the
 * conversation, so an unconditional clear would strip the live turn of its
 * crash recovery. These tests pin the loop-scoped variant that closes that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, readTextFile, readDir, remove } from '@tauri-apps/plugin-fs';
import { findOrphanedCheckpoints, clearCheckpointForLoop, type Checkpoint } from './checkpoint';

const existsMock = vi.mocked(exists);
const readTextFileMock = vi.mocked(readTextFile);
const removeMock = vi.mocked(remove);

function checkpoint(loopId: string): Checkpoint {
  return {
    conversationId: 'conv-1',
    loopId,
    turnCount: 1,
    lastMessageId: 'msg-1',
    status: 'llm_calling',
    timestamp: 0,
  };
}

describe('clearCheckpointForLoop', () => {
  beforeEach(() => {
    existsMock.mockReset().mockResolvedValue(true);
    readTextFileMock.mockReset().mockResolvedValue('');
    removeMock.mockReset().mockResolvedValue(undefined);
  });

  it('removes the checkpoint while it still belongs to the loop', async () => {
    readTextFileMock.mockResolvedValue(JSON.stringify(checkpoint('loop-1')));

    await clearCheckpointForLoop('conv-1', 'loop-1');

    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a checkpoint written by a newer loop alone', async () => {
    readTextFileMock.mockResolvedValue(JSON.stringify(checkpoint('loop-2')));

    await clearCheckpointForLoop('conv-1', 'loop-1');

    expect(removeMock).not.toHaveBeenCalled();
  });

  it('does nothing when no checkpoint file exists', async () => {
    existsMock.mockResolvedValue(false);

    await clearCheckpointForLoop('conv-1', 'loop-1');

    expect(readTextFileMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('leaves an unreadable checkpoint for the startup orphan scan instead of throwing', async () => {
    readTextFileMock.mockResolvedValue('{ not json');

    await expect(clearCheckpointForLoop('conv-1', 'loop-1')).resolves.toBeUndefined();
    expect(removeMock).not.toHaveBeenCalled();
  });
});

describe('checkpoint recovery validation (F8)', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(10_000_000);
    existsMock.mockReset().mockResolvedValue(true);
    removeMock.mockReset().mockResolvedValue(undefined);
    vi.mocked(readDir).mockResolvedValue([{ name: 'conv-1', isDirectory: true, isFile: false, isSymlink: false }]);
  });
  afterEach(() => vi.useRealTimers());
  it.each([
    { conversationId: 'conv-2' }, { conversationId: '../conv-2' },
    { timestamp: 10_000_001 }, { timestamp: '9999999' }, { timestamp: null },
    { timestamp: -1 }, { timestamp: 1 }, { loopId: '' }, { turnCount: -1 }, { status: 'corrupt' },
  ])('cleans the actual scanned path and never resumes malformed state: %j', async (override) => {
    readTextFileMock.mockResolvedValue(JSON.stringify({ ...checkpoint('loop-1'), timestamp: 9_999_999, ...override }));
    expect(await findOrphanedCheckpoints()).toEqual([]);
    expect(removeMock).toHaveBeenCalledWith(expect.stringMatching(/\/conv-1\/checkpoint\.json$/));
    expect(removeMock).not.toHaveBeenCalledWith(expect.stringMatching(/\/conv-2\/checkpoint\.json$/));
  });
  it('keeps a recent valid checkpoint owned by the scanned conversation', async () => {
    const cp = { ...checkpoint('loop-1'), timestamp: 9_999_999 };
    readTextFileMock.mockResolvedValue(JSON.stringify(cp));
    expect(await findOrphanedCheckpoints()).toEqual([cp]);
    expect(removeMock).not.toHaveBeenCalled();
  });
});
