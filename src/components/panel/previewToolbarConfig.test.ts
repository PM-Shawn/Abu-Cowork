import { describe, it, expect } from 'vitest';
import { getToolbarButtons } from './previewToolbarConfig';

describe('getToolbarButtons', () => {
  it('html/md get view-toggle + version history', () => {
    expect(getToolbarButtons('html').viewToggle).toBe(true);
    expect(getToolbarButtons('markdown').versionHistory).toBe(true);
  });
  it('image/pdf/xlsx: no view-toggle, no history, but fullscreen + openInApp', () => {
    for (const t of ['image', 'pdf', 'xlsx'] as const) {
      const b = getToolbarButtons(t);
      expect(b.viewToggle).toBe(false);
      expect(b.versionHistory).toBe(false);
      expect(b.fullscreen).toBe(true);
      expect(b.openInApp).toBe(true);
    }
  });
  it('code/text get history (editable) but no view-toggle', () => {
    expect(getToolbarButtons('code').versionHistory).toBe(true);
    expect(getToolbarButtons('code').viewToggle).toBe(false);
  });
  it('unsupported gets no toolbar buttons', () => {
    const b = getToolbarButtons('unsupported');
    expect(b.fullscreen).toBe(false);
    expect(b.openInApp).toBe(false);
  });
});
