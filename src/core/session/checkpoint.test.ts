/**
 * Checkpoints are keyed by CONVERSATION, but a run's fire-and-forget teardown
 * can outlive its own visible terminal (see agentLoopRunner.ts's
 * `RunSession.terminalPublished`). By then the next turn may already own the
 * conversation, so an unconditional clear would strip the live turn of its
 * crash recovery. These tests pin the loop-scoped variant that closes that.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, readTextFile, remove } from '@tauri-apps/plugin-fs';
import { clearCheckpointForLoop, type Checkpoint } from './checkpoint';

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
