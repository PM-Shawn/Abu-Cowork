import { describe, it, expect } from 'vitest';
import { getToolbarButtons } from './previewToolbarConfig';

describe('getToolbarButtons', () => {
  it('html/md get view-toggle + version history', () => {
    expect(getToolbarButtons('html', '/w/page.html').viewToggle).toBe(true);
    expect(getToolbarButtons('markdown', '/w/notes.md').versionHistory).toBe(true);
  });
  it('image/pdf/xlsx: no view-toggle, no history, but fullscreen + openInApp', () => {
    for (const [t, filePath] of [['image', '/w/chart.png'], ['pdf', '/w/report.pdf'], ['xlsx', '/w/budget.xlsx']] as const) {
      const b = getToolbarButtons(t, filePath);
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
  it('unsupported gets no toolbar buttons', () => {
    const b = getToolbarButtons('unsupported', '/w/archive.zip');
    expect(b.fullscreen).toBe(false);
    expect(b.openInApp).toBe(false);
  });
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
