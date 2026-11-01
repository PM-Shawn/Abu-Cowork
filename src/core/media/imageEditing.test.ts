// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { activateImageEditing, restoreImageEditing } from './imageEditing';
import { findImageEditEntry, useImageEditStore } from '@/stores/imageEditStore';
import { clearComposerDraft, getComposerDraftKey, readComposerDraft, writeComposerDraft } from '@/stores/composerDraftStore';
import type { ImageEditRequest } from '@/types/media';

const composerKey = getComposerDraftKey('conversation-1', 'local');
const request: ImageEditRequest = {
  schemaVersion: 1, id: 'request-1', messageId: 'message-1', scope: 'local', conversationId: 'conversation-1',
  sourceArtifactId: 'source-1', sourceCaptureId: 'capture-1', sourceDigest: 'a'.repeat(64), prompt: 'Make it green',
  comments: [{ id: 'comment-1', point: { x: 0.5, y: 0.5 }, text: 'Keep the label' }], markup: [], region: [],
  attachmentRefs: [{ kind: 'source', fileRef: { originalPath: '/source.png', captureId: 'capture-1', contentDigest: 'a'.repeat(64) }, mimeType: 'image/png', width: 100, height: 100, byteLength: 100 }],
  backendId: 'images', capabilityVersion: '1',
};

describe('restoring image instructions', () => {
  beforeEach(() => {
    useImageEditStore.setState({ entries: {}, active: {}, pending: {} });
    clearComposerDraft(composerKey);
  });

  it('keeps edits and undo history when the same request is opened again', () => {
    expect(restoreImageEditing(request, composerKey, 'local')).toBe('/source.png');
    const key = useImageEditStore.getState().active[composerKey];
    useImageEditStore.getState().changeLayer(key, 'comments', [{ ...request.comments[0], text: 'Keep the entire package' }]);
    writeComposerDraft(composerKey, { ...readComposerDraft(composerKey), text: 'Make it blue' });
    restoreImageEditing(request, composerKey, 'local');
    const entry = useImageEditStore.getState().entries[key];
    expect(entry.draft.prompt).toBe('Make it blue');
    expect(entry.draft.comments[0].text).toBe('Keep the entire package');
    expect(entry.history.past).toHaveLength(1);
    expect(readComposerDraft(composerKey).text).toBe('Make it blue');
    expect(request.comments[0].text).toBe('Keep the label');
  });

  it('keeps the current draft when instructions from another request are opened', () => {
    restoreImageEditing(request, composerKey, 'local');
    const firstKey = useImageEditStore.getState().active[composerKey];
    writeComposerDraft(composerKey, { ...readComposerDraft(composerKey), text: 'First changes' });
    restoreImageEditing({ ...request, id: 'request-2', prompt: 'Second changes' }, composerKey, 'local');
    expect(useImageEditStore.getState().active[composerKey]).toBe(firstKey);
    expect(readComposerDraft(composerKey).text).toBe('First changes');
    expect(Object.keys(useImageEditStore.getState().entries)).toHaveLength(1);
  });

  it('preserves the preview-created draft and its layers when an old request is opened', () => {
    restoreImageEditing(request, composerKey, 'local');
    const entry = useImageEditStore.getState().entries[useImageEditStore.getState().active[composerKey]];
    const key = `${composerKey}\0/source.png\0capture-new`;
    useImageEditStore.setState({ entries: { [key]: { ...entry, key } }, active: { [composerKey]: key } });
    useImageEditStore.getState().changeLayer(key, 'comments', [{ ...request.comments[0], text: 'New annotation' }]);
    writeComposerDraft(composerKey, { ...readComposerDraft(composerKey), text: 'New instructions' });
    const before = useImageEditStore.getState();
    expect(restoreImageEditing(request, composerKey, 'local')).toBe('/source.png');
    expect(useImageEditStore.getState()).toBe(before);
    expect(readComposerDraft(composerKey).text).toBe('New instructions');
  });

  it('reactivates an inactive captured image with its comments, history and saved prompt', async () => {
    restoreImageEditing(request, composerKey, 'local');
    const firstKey = useImageEditStore.getState().active[composerKey];
    useImageEditStore.getState().changeLayer(firstKey, 'comments', [{ ...request.comments[0], text: 'Keep this package' }]);
    const first = useImageEditStore.getState().entries[firstKey];
    const second = { ...first, key: `${composerKey}\0/second.png`, originalPath: '/second.png', draft: {
      ...first.draft, sourceCaptureId: 'capture-2', source: { ...first.draft.source, fileRef: {
        originalPath: '/second.png', captureId: 'capture-2', contentDigest: 'b'.repeat(64),
      } }, comments: [], prompt: 'Second image',
    } };
    useImageEditStore.getState().activate(second);
    writeComposerDraft(composerKey, { ...readComposerDraft(composerKey), text: 'Keep the overhead view' });

    expect(await activateImageEditing({ composerKey, conversationId: 'conversation-1', scope: 'local',
      filePath: first.originalPath, fileRef: first.draft.source.fileRef, tool: 'comments' })).toBe(true);

    const state = useImageEditStore.getState();
    expect(state.active[composerKey]).toBe(firstKey);
    expect(Object.keys(state.entries)).toHaveLength(2);
    expect(state.entries[firstKey].draft.comments).toEqual(first.draft.comments);
    expect(state.entries[firstKey].history).toBe(first.history);
    expect(state.entries[firstKey].draft.activeTool).toBe('comments');
    expect(readComposerDraft(composerKey).text).toBe('Make it green');
    expect(state.entries[second.key].draft.prompt).toBe('Keep the overhead view');
  });

  it('matches the requested source version within its composer scope', () => {
    restoreImageEditing(request, composerKey, 'local');
    const first = useImageEditStore.getState().entries[useImageEditStore.getState().active[composerKey]];
    const newer = { ...first, key: `${first.key}-new`, draft: { ...first.draft, sourceCaptureId: 'capture-2' } };
    useImageEditStore.getState().activate(newer);
    const state = useImageEditStore.getState();
    expect(findImageEditEntry(state, composerKey, '/source.png', 'capture-1')).toBe(first);
    expect(findImageEditEntry(state, composerKey, '/source.png')).toBe(newer);
    expect(findImageEditEntry(state, composerKey, '/source.png', 'missing')).toBeUndefined();
    expect(findImageEditEntry(state, getComposerDraftKey('conversation-2', 'local'), '/source.png')).toBeUndefined();
    expect(findImageEditEntry(state, getComposerDraftKey('conversation-1', 'another-scope'), '/source.png')).toBeUndefined();
  });
});
