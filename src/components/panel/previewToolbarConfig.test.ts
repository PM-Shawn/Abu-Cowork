import { describe, it, expect } from 'vitest';
import { getToolbarButtons, offersOpenInApp } from './previewToolbarConfig';

describe('getToolbarButtons', () => {
  it('html/md get view-toggle + version history', () => {
    expect(getToolbarButtons('html', '/w/page.html').viewToggle).toBe(true);
    expect(getToolbarButtons('markdown', '/w/notes.md').versionHistory).toBe(true);
  });
  it('image/pdf/xlsx: no view-toggle, no history, but fullscreen + openInApp', () => {
    for (const t of ['image', 'pdf', 'xlsx'] as const) {
      const b = getToolbarButtons(t, `/w/file.${t}`);
      expect(b.viewToggle).toBe(false);
      expect(b.versionHistory).toBe(false);
      expect(b.fullscreen).toBe(true);
      expect(b.openInApp).toBe(true);
    }
  });
  it('code/text get history (editable) but no view-toggle', () => {
    expect(getToolbarButtons('code', '/w/main.ts').versionHistory).toBe(true);
    expect(getToolbarButtons('code', '/w/main.ts').viewToggle).toBe(false);
  });
  it('unsupported gets openInApp only', () => {
    expect(getToolbarButtons('unsupported', '/w/report.doc')).toEqual({
      viewToggle: false,
      fullscreen: false,
      openInApp: true,
      versionHistory: false,
    });
  });
  it('unsupported gets no button at all for a file the system would run', () => {
    expect(getToolbarButtons('unsupported', '/w/setup.command')).toEqual({
      viewToggle: false,
      fullscreen: false,
      openInApp: false,
      versionHistory: false,
    });
  });
});

describe('offersOpenInApp', () => {
  it.each(['/w/setup.command', 'C:\\w\\setup.EXE', '/w/Tool.app', '/w/build'])('is off for %s, which has no preview', (path) => {
    expect(offersOpenInApp('unsupported', path)).toBe(false);
  });
  it.each(['/w/report.doc', '/w/letter.rtf', '/w/notes.pages'])('is on for %s, which has no preview', (path) => {
    expect(offersOpenInApp('unsupported', path)).toBe(true);
  });
  it.each([
    ['code', '/w/build.sh'],
    ['code', '/w/tool.py'],
    ['code', '/w/tool.js'],
    ['pdf', '/w/report.pdf'],
    ['image', 'data:image/png;base64,AAAA'],
  ] as const)('is on for a previewed %s file: %s', (type, path) => {
    expect(offersOpenInApp(type, path)).toBe(true);
  });
});
