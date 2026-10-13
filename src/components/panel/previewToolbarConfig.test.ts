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
  it('a read-only preview keeps every button but version history', () => {
    for (const [type, filePath] of [['markdown', '/w/notes.md'], ['html', '/w/page.html'], ['code', '/w/main.ts'], ['text', '/w/notes.txt']] as const) {
      expect(getToolbarButtons(type, filePath, { readOnly: true })).toEqual({
        ...getToolbarButtons(type, filePath),
        versionHistory: false,
      });
    }
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
    ['code', '/w/build.zsh'],
    ['code', '/w/tool.ts'],
    ['pdf', '/w/report.pdf'],
    ['image', 'data:image/png;base64,AAAA'],
  ] as const)('is on for a previewed %s file: %s', (type, path) => {
    expect(offersOpenInApp(type, path)).toBe(true);
  });
  it.each(['/w/build.sh', '/w/tool.py', '/w/tool.js', '/w/tool.rb', 'C:\\w\\tool.py'])('is off for %s, previewed code the system would run', (path) => {
    expect(offersOpenInApp('code', path)).toBe(false);
  });
});

describe('getToolbarButtons for code', () => {
  it('code the system shows in an editor keeps openInApp', () => {
    for (const filePath of ['/w/main.ts', '/w/main.rs', '/w/config.json', '/w/build.zsh', '/w/query.sql']) {
      expect(getToolbarButtons('code', filePath).openInApp).toBe(true);
    }
  });
  it('code the system would run gets no openInApp, and keeps the rest', () => {
    for (const filePath of ['/w/job.sh', '/w/job.py', '/w/job.js', '/w/job.rb', 'C:\\w\\job.py']) {
      const b = getToolbarButtons('code', filePath);
      expect(b.openInApp).toBe(false);
      expect(b.fullscreen).toBe(true);
      expect(b.versionHistory).toBe(true);
    }
  });
});
