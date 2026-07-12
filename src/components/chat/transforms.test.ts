import { describe, it, expect } from 'vitest';
import { wrapSvgAsHtml } from './transforms';

describe('wrapSvgAsHtml', () => {
  const viewBoxOnlySvg = '<svg viewBox="0 0 900 720"><rect width="900" height="720" fill="var(--w-bg)"/></svg>';
  const wrapped = wrapSvgAsHtml(viewBoxOnlySvg);

  it('does not use 100vh (banned viewport-height sizing — the widget iframe auto-sizes to content)', () => {
    expect(wrapped).not.toContain('100vh');
  });

  it('gives a viewBox-only svg an explicit width rule so it does not collapse', () => {
    expect(wrapped).toMatch(/svg\s*\{[^}]*width\s*:\s*100%/);
  });

  it('caps the svg to a sane max-width and lets height scale via aspect ratio', () => {
    expect(wrapped).toMatch(/svg\s*\{[^}]*max-width\s*:\s*900px/);
    expect(wrapped).toMatch(/svg\s*\{[^}]*height\s*:\s*auto/);
  });

  it('uses a transparent background so the design-system themed body bg shows through', () => {
    expect(wrapped).toMatch(/body\s*\{[^}]*background\s*:\s*transparent/);
    expect(wrapped).not.toContain('background:#fff');
    expect(wrapped).not.toContain('background: #fff');
  });

  it('preserves the original svg code unmodified', () => {
    expect(wrapped).toContain(viewBoxOnlySvg);
  });
});
