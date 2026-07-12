import { describe, it, expect, beforeEach } from 'vitest';
import { usePreviewStore } from './previewStore';

describe('previewStore', () => {
  beforeEach(() => {
    usePreviewStore.setState({ previewFilePath: null, chatWidth: null, reloadNonce: 0 });
  });

  it('starts with reloadNonce at 0', () => {
    expect(usePreviewStore.getState().reloadNonce).toBe(0);
  });

  describe('refreshPreview', () => {
    it('increments reloadNonce', () => {
      usePreviewStore.getState().refreshPreview();
      expect(usePreviewStore.getState().reloadNonce).toBe(1);
    });

    it('increments on every call, coalescing nothing (each call is a distinct signal)', () => {
      const { refreshPreview } = usePreviewStore.getState();
      refreshPreview();
      refreshPreview();
      refreshPreview();
      expect(usePreviewStore.getState().reloadNonce).toBe(3);
    });

    it('does not touch previewFilePath or chatWidth', () => {
      usePreviewStore.setState({ previewFilePath: '/a/b.html', chatWidth: 320 });
      usePreviewStore.getState().refreshPreview();
      expect(usePreviewStore.getState().previewFilePath).toBe('/a/b.html');
      expect(usePreviewStore.getState().chatWidth).toBe(320);
    });
  });

  describe('openPreview', () => {
    it('sets previewFilePath', () => {
      usePreviewStore.getState().openPreview('/a/b.html');
      expect(usePreviewStore.getState().previewFilePath).toBe('/a/b.html');
    });

    it('leaves reloadNonce untouched when switching to a different file', () => {
      usePreviewStore.getState().refreshPreview();
      expect(usePreviewStore.getState().reloadNonce).toBe(1);
      usePreviewStore.getState().openPreview('/a/b.html');
      expect(usePreviewStore.getState().reloadNonce).toBe(1);
    });

    it('re-opening the same path is a no-op for reloadNonce (caller must call refreshPreview explicitly)', () => {
      usePreviewStore.getState().openPreview('/a/b.html');
      usePreviewStore.getState().openPreview('/a/b.html');
      expect(usePreviewStore.getState().reloadNonce).toBe(0);
    });
  });

  describe('closePreview', () => {
    it('clears previewFilePath and chatWidth but preserves reloadNonce', () => {
      usePreviewStore.setState({ previewFilePath: '/a/b.html', chatWidth: 320 });
      usePreviewStore.getState().refreshPreview();
      usePreviewStore.getState().closePreview();
      expect(usePreviewStore.getState().previewFilePath).toBeNull();
      expect(usePreviewStore.getState().chatWidth).toBeNull();
      expect(usePreviewStore.getState().reloadNonce).toBe(1);
    });
  });
});
