import { describe, expect, it } from 'vitest';
import type { ImageEditDraft } from '@/types/media';
import { canSendImageDraft, changeImageLayer, imagePointFromClient, selectImageTool, setImageAspectRatioPrompt, travelImageHistory } from '@/core/media/imageDraft';

const draft: ImageEditDraft = {
  scope: 'local', conversationId: 'conversation-1', sourceArtifactId: 'source-1', sourceCaptureId: 'capture-1',
  sourceDigest: 'a'.repeat(64), activeTool: 'prompt', prompt: 'Keep the package.', comments: [], markup: [], region: [],
  source: { kind: 'source', fileRef: { originalPath: '/coffee.png' }, mimeType: 'image/png', byteLength: 1024, width: 1000, height: 1000 },
};

describe('image edit draft', () => {
  it('replaces complete ratio instructions and keeps other user text', () => {
    const template = 'Set the aspect ratio to {ratio}';
    const square = setImageAspectRatioPrompt(draft.prompt, '1:1', template);
    expect(square).toBe('Keep the package.\nSet the aspect ratio to 1:1');
    expect(setImageAspectRatioPrompt(square, '16:9', template)).toBe('Keep the package.\nSet the aspect ratio to 16:9');
    expect(setImageAspectRatioPrompt(square, '1:1', template)).toBe(square);
    expect(setImageAspectRatioPrompt('Set the aspect ratio to 1:1 if possible', '4:3', template))
      .toBe('Set the aspect ratio to 1:1 if possible\nSet the aspect ratio to 4:3');
    expect(setImageAspectRatioPrompt('', '1:1', template)).toBe('Set the aspect ratio to 1:1');
  });

  it('allows written comments alone and tool changes preserve all layers', () => {
    const withComment = { ...draft, prompt: '', comments: [{ id: 'comment-1', point: { x: 0.5, y: 0.5 }, text: 'Keep this' }] };
    expect(canSendImageDraft(withComment)).toBe(true);
    expect(canSendImageDraft({ ...withComment, comments: [] })).toBe(false);
    expect(selectImageTool(withComment, 'region')).toEqual({ ...withComment, activeTool: 'region' });
  });

  it('undoes and redoes layer changes without changing the source or prompt', () => {
    const stroke = { id: 'stroke-1', erase: false, width: 0.02, points: [{ x: 0.1, y: 0.2 }] };
    const changed = changeImageLayer(draft, { past: [], future: [] }, 'region', [stroke]);
    const cleared = changeImageLayer(changed.draft, changed.history, 'region', []);
    const undone = travelImageHistory(cleared.draft, cleared.history, 'undo');
    expect(undone.draft.region).toEqual([stroke]);
    expect(undone.draft.source).toBe(draft.source);
    expect(undone.draft.prompt).toBe(draft.prompt);
    const redone = travelImageHistory(undone.draft, undone.history, 'redo');
    expect(redone.draft.region).toEqual([]);
    expect(travelImageHistory(draft, { past: [], future: [] }, 'undo').draft).toBe(draft);
    expect(changeImageLayer(undone.draft, undone.history, 'region', []).history.future).toEqual([]);
  });
});

describe('image coordinates', () => {
  it.each([0, 90, 180, 270])('keeps every source corner at rotation %i with zoom and scroll', (rotation) => {
    const view = { centerX: 300, centerY: 200, width: 160, height: 90, zoom: 2, rotation };
    for (const point of [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]) {
      const angle = rotation * Math.PI / 180;
      const dx = (point.x - 0.5) * view.width * view.zoom;
      const dy = (point.y - 0.5) * view.height * view.zoom;
      const result = imagePointFromClient({
        x: view.centerX + dx * Math.cos(angle) - dy * Math.sin(angle),
        y: view.centerY + dx * Math.sin(angle) + dy * Math.cos(angle),
      }, view);
      expect(result!.x).toBeCloseTo(point.x);
      expect(result!.y).toBeCloseTo(point.y);
    }
  });

  it('refuses whitespace outside the source image and invalid geometry', () => {
    const view = { centerX: 100, centerY: 100, width: 100, height: 100, zoom: 1, rotation: 0 };
    expect(imagePointFromClient({ x: 49, y: 100 }, view)).toBeNull();
    expect(imagePointFromClient({ x: 100, y: 100 }, view)).toEqual({ x: 0.5, y: 0.5 });
    expect(() => imagePointFromClient({ x: 100, y: 100 }, { ...view, zoom: 0 })).toThrow();
    expect(() => imagePointFromClient({ x: Infinity, y: 100 }, view)).toThrow();
  });
});
