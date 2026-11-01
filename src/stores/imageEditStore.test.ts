import { afterEach, expect, it, vi } from 'vitest';
import { findImageEditEntry, useImageEditStore, type ImageEditEntry } from './imageEditStore';

const entry: ImageEditEntry = {
  key: 'first', composerKey: 'conversation', originalPath: '/image.png', history: { past: [], future: [] },
  draft: { scope: 'local', conversationId: 'conversation', sourceArtifactId: 'image', sourceCaptureId: 'capture',
    sourceDigest: 'a'.repeat(64), activeTool: 'prompt', prompt: '', comments: [], markup: [], region: [],
    source: { kind: 'source', fileRef: { originalPath: '/image.png', captureId: 'capture' }, mimeType: 'image/png', byteLength: 10, width: 100, height: 100 } },
};

afterEach(() => { useImageEditStore.setState({ entries: {}, active: {}, pending: {} }); vi.unstubAllGlobals(); });

it('keeps independent drafts, history and capture ownership when cancelling or clearing', async () => {
  const mediaOperation = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('__ABU_SHELL__', { mediaOperation });
  const store = useImageEditStore.getState();
  store.activate(entry);
  store.selectTool('first', 'comments');
  store.setPrompt('first', 'Keep the label');
  const comment = { id: 'one', point: { x: 0.5, y: 0.5 }, text: 'Keep' };
  store.changeLayer('first', 'comments', [comment]);
  store.travel('first', 'undo');
  expect(useImageEditStore.getState().entries.first.draft.comments).toEqual([]);
  store.travel('first', 'redo');
  expect(findImageEditEntry(useImageEditStore.getState(), 'conversation', '/image.png', 'capture')?.draft.comments).toEqual([comment]);
  store.activate({ ...entry, key: 'second', composerKey: 'other' });
  await store.cancel('conversation');
  expect(useImageEditStore.getState().entries.first).toBeUndefined();
  expect(useImageEditStore.getState().entries.second).toBeDefined();
  await store.clear('other');
  expect(useImageEditStore.getState().entries).toEqual({});
  expect(mediaOperation).toHaveBeenCalledTimes(2);
  expect(() => store.setPrompt('missing', 'text')).toThrow('Image draft is unavailable');
  expect(() => store.selectTool('missing', 'region')).toThrow('Image draft is unavailable');
  expect(() => store.changeLayer('missing', 'comments', [])).toThrow('Image draft is unavailable');
  expect(() => store.travel('missing', 'undo')).toThrow('Image draft is unavailable');
});
