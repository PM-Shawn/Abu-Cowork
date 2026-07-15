import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useFeedbackDraftStore, type ScreenshotDraft } from './feedbackDraftStore';

function makeShot(id: string): ScreenshotDraft {
  return { id, name: `${id}.png`, bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png', previewUrl: `blob:${id}` };
}

describe('feedbackDraftStore', () => {
  beforeEach(() => {
    useFeedbackDraftStore.setState({
      description: '',
      selectedConversationIds: [],
      touchedSelection: false,
      screenshots: [],
    });
  });

  it('setDescription updates the draft', () => {
    useFeedbackDraftStore.getState().setDescription('hello');
    expect(useFeedbackDraftStore.getState().description).toBe('hello');
  });

  describe('setSelectedConversationIds', () => {
    it('marks the selection touched when opts.touched is true', () => {
      useFeedbackDraftStore.getState().setSelectedConversationIds(['a', 'b'], { touched: true });
      const s = useFeedbackDraftStore.getState();
      expect(s.selectedConversationIds).toEqual(['a', 'b']);
      expect(s.touchedSelection).toBe(true);
    });

    it('leaves touched=false when following the active conversation', () => {
      useFeedbackDraftStore.getState().setSelectedConversationIds(['active'], { touched: false });
      expect(useFeedbackDraftStore.getState().touchedSelection).toBe(false);
    });

    it('preserves the existing touched flag when opts is omitted', () => {
      useFeedbackDraftStore.getState().setSelectedConversationIds(['a'], { touched: true });
      useFeedbackDraftStore.getState().setSelectedConversationIds(['a', 'b']);
      expect(useFeedbackDraftStore.getState().touchedSelection).toBe(true);
    });
  });

  describe('setScreenshots', () => {
    it('accepts a plain array', () => {
      useFeedbackDraftStore.getState().setScreenshots([makeShot('a')]);
      expect(useFeedbackDraftStore.getState().screenshots.map((s) => s.id)).toEqual(['a']);
    });

    it('accepts a functional updater applied against the latest state (atomic merge)', () => {
      useFeedbackDraftStore.getState().setScreenshots([makeShot('a')]);
      // Two "concurrent" appends both use the updater form — the second must
      // see the first's result, not a stale snapshot, so neither is dropped.
      useFeedbackDraftStore.getState().setScreenshots((prev) => [...prev, makeShot('b')]);
      useFeedbackDraftStore.getState().setScreenshots((prev) => [...prev, makeShot('c')]);
      expect(useFeedbackDraftStore.getState().screenshots.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    });
  });

  it('clearDraft revokes every screenshot blob URL and resets all fields', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const shots = [makeShot('one'), makeShot('two')];
    useFeedbackDraftStore.setState({
      description: 'wip',
      selectedConversationIds: ['x'],
      touchedSelection: true,
      screenshots: shots,
    });

    useFeedbackDraftStore.getState().clearDraft();

    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith('blob:one');
    expect(revoke).toHaveBeenCalledWith('blob:two');
    const s = useFeedbackDraftStore.getState();
    expect(s.description).toBe('');
    expect(s.selectedConversationIds).toEqual([]);
    expect(s.touchedSelection).toBe(false);
    expect(s.screenshots).toEqual([]);
    revoke.mockRestore();
  });
});
