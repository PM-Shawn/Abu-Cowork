import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import type { ImageEditRequest, MediaArtifact, MediaFileRef } from '@/types/media';
import { imageVersions } from './imageVersions';

const source: MediaFileRef = { originalPath: '/source.png', captureId: 'capture-1', contentDigest: 'a'.repeat(64) };
const request: ImageEditRequest = {
  schemaVersion: 1, id: 'request-1', messageId: 'message-1', scope: 'local', conversationId: 'conversation-1',
  sourceArtifactId: 'source-1', sourceCaptureId: 'capture-1', sourceDigest: 'a'.repeat(64), prompt: 'Green background',
  comments: [], markup: [], region: [], backendId: 'images', capabilityVersion: '1',
  attachmentRefs: [{ kind: 'source', fileRef: source, mimeType: 'image/png', width: 100, height: 100, byteLength: 100 }],
};
const result: MediaArtifact = {
  schemaVersion: 1, id: 'result-1', messageId: 'message-2', conversationId: 'conversation-1', kind: 'image', mimeType: 'image/png',
  fileRef: { originalPath: '/result.png', contentDigest: 'b'.repeat(64) }, byteLength: 100, groupId: 'request-1', order: 0,
  parentArtifactId: 'source-1', editRequestId: 'request-1',
};
const messages: Message[] = [
  { id: request.messageId, role: 'user', content: request.prompt, timestamp: 1, imageEditRequest: request },
  { id: result.messageId, role: 'assistant', content: '', timestamp: 2, mediaArtifacts: [result] },
];

describe('image versions', () => {
  it('connects successive inherited edits through artifact identity when capture paths differ', () => {
    const nextSource = { originalPath: '/child/outputs/capture-2.png', captureId: 'capture-2', contentDigest: 'b'.repeat(64) };
    const nextRequest = { ...request, id: 'request-2', messageId: 'message-3', sourceArtifactId: result.id,
      sourceCaptureId: 'capture-2', sourceDigest: 'b'.repeat(64), attachmentRefs: [{ ...request.attachmentRefs[0], fileRef: nextSource }] };
    const nextResult = { ...result, id: 'result-2', messageId: 'message-4', editRequestId: nextRequest.id,
      parentArtifactId: result.id, fileRef: { originalPath: '/child/outputs/result-2.png', contentDigest: 'c'.repeat(64) } };
    const inherited: Message[] = [...messages,
      { id: nextRequest.messageId, role: 'user', content: nextRequest.prompt, timestamp: 3, imageEditRequest: nextRequest },
      { id: nextResult.messageId, role: 'assistant', content: '', timestamp: 4, mediaArtifacts: [nextResult] },
    ].map(message => ({ ...message, inheritedFromBranch: true }));
    const versions = imageVersions(inherited, nextResult.fileRef);
    expect(versions.versions).toEqual([source, result.fileRef, nextSource, nextResult.fileRef]);
    expect(versions.parent).toEqual(nextSource);
  });

  it('retains different captures of the same path and the current unsent version', () => {
    const current = { ...source, captureId: 'capture-2', contentDigest: 'c'.repeat(64) };
    expect(imageVersions(messages, current).versions).toEqual([source, result.fileRef, current]);
  });

  it('compares a result against the exact capture submitted for that result', () => {
    const history = imageVersions(messages, result.fileRef);
    expect(history.parent).toEqual(source);
    expect(history.versions).toEqual([source, result.fileRef]);
  });

  it('keeps unrelated image results out of the current history', () => {
    const other = { ...result, id: 'unrelated', messageId: 'message-3', fileRef: { originalPath: '/unrelated.png' }, editRequestId: 'other-request' };
    expect(imageVersions([...messages, { id: other.messageId, role: 'assistant', content: '', timestamp: 3, mediaArtifacts: [other] }], result.fileRef).versions).toEqual([source, result.fileRef]);
  });
});
