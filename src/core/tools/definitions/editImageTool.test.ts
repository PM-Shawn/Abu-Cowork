import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaJobRecord } from '@/types/media';
import { editImageTool } from './editImageTool';
import { useChatStore } from '@/stores/chatStore';
import { acceptMediaJobRecord, detachImageEdits, refreshMediaJobs, useMediaJobStore } from '@/core/media/mediaJobs';

function record(generationState: MediaJobRecord['job']['generationState'], error?: string): MediaJobRecord {
  return {
    request: {
      schemaVersion: 1, id: 'request-1', messageId: 'message-1', scope: 'local', conversationId: 'conversation-1',
      sourceArtifactId: 'source-1', sourceCaptureId: 'capture-1', sourceDigest: 'a'.repeat(64), prompt: 'Make it green',
      comments: [], markup: [], region: [],
      attachmentRefs: [{ kind: 'source', fileRef: { originalPath: '/source.png', captureId: 'capture-1', contentDigest: 'a'.repeat(64) }, mimeType: 'image/png', width: 100, height: 100, byteLength: 100 }],
      backendId: 'images', capabilityVersion: '1',
    },
    job: {
      schemaVersion: 1, id: 'job-1', requestId: 'request-1', scope: 'local', conversationId: 'conversation-1',
      attempt: 1, generationState, waitState: 'waiting', sequence: 1, outputArtifactIds: [], error,
    },
    artifacts: [],
  };
}

describe('image edit tool result', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useChatStore.setState({ conversations: {} });
    useMediaJobStore.setState({ records: {} });
  });

  it('keeps inherited requests out of refresh, detach and late job events', async () => {
    const saved = record('completed');
    const mediaOperation = vi.fn();
    vi.stubGlobal('__ABU_SHELL__', { mediaOperation });
    useChatStore.setState({ conversations: { 'conversation-1': {
      id: 'conversation-1', title: 'Branch', createdAt: 1, updatedAt: 1, status: 'idle', messages: [{
        id: saved.request.messageId, role: 'user', content: saved.request.prompt, timestamp: 1,
        inheritedFromBranch: true, imageEditRequest: saved.request,
      }],
    } } });
    await refreshMediaJobs('conversation-1');
    await detachImageEdits('conversation-1');
    acceptMediaJobRecord(saved);
    expect(mediaOperation).not.toHaveBeenCalled();
    expect(useMediaJobStore.getState().records).toEqual({});
  });

  it.each([
    ['failed', 'Image service returned HTTP 401'],
    ['unknown', 'The operation timed out'],
    ['save_failed', 'Insufficient space for the image'],
  ] as const)('preserves the reason for %s without submitting another request', async (state, error) => {
    const mediaOperation = vi.fn().mockResolvedValue(record(state, error));
    vi.stubGlobal('__ABU_SHELL__', { mediaOperation });
    const result = await editImageTool.execute({ request_id: 'request-1' }, { conversationId: 'conversation-1' });
    expect(result).toContain(error);
    expect(result).toContain('Explain this cause to the user');
    expect(result).toContain('do not submit it again');
    expect(mediaOperation).toHaveBeenCalledExactlyOnceWith('execute-edit', { conversationId: 'conversation-1', requestId: 'request-1' });
  });

  it('reports a pending request without an invented failure reason', async () => {
    vi.stubGlobal('__ABU_SHELL__', { mediaOperation: vi.fn().mockResolvedValue(record('running')) });
    const result = await editImageTool.execute({ request_id: 'request-1' }, { conversationId: 'conversation-1' });
    expect(result).toContain('Image edit status: running.');
    expect(result).not.toContain('Reason:');
  });
});
