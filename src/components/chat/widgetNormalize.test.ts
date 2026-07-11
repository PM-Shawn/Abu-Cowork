import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  buildPreviewNeutralizeCss,
  ensureDoctype,
  isFullDocument,
  WIDGET_PREVIEW_PHASE_CLASS,
} from './widgetNormalize';

const FIXTURE_PATH = path.resolve(__dirname, '__fixtures__/whitescreen-glm52-portfolio.html');
const fixture = fs.readFileSync(FIXTURE_PATH, 'utf-8');

describe('buildPreviewNeutralizeCss', () => {
  it('is universal (no class-name substring heuristics), scoped to the preview-phase body class', () => {
    const css = buildPreviewNeutralizeCss();
    expect(css).toContain(`body.${WIDGET_PREVIEW_PHASE_CLASS} *`);
    expect(css).not.toContain('[class*=');
  });

  it('forces opacity/visibility and freezes animation/transition', () => {
    const css = buildPreviewNeutralizeCss();
    expect(css).toContain('opacity: 1 !important');
    expect(css).toContain('visibility: visible !important');
    expect(css).toContain('animation: none !important');
    expect(css).toContain('transition: none !important');
  });

  it('does not touch transform (reveal pairs transform WITH opacity; translate-centering must survive)', () => {
    expect(buildPreviewNeutralizeCss()).not.toContain('transform');
  });

  it('includes a body self-rule (body{opacity:0} page-fade patterns — body.x * does not match body)', () => {
    const css = buildPreviewNeutralizeCss();
    expect(css).toMatch(new RegExp(`body\\.${WIDGET_PREVIEW_PHASE_CLASS}\\s*\\{[^}]*opacity: 1 !important`));
    expect(css).toMatch(new RegExp(`body\\.${WIDGET_PREVIEW_PHASE_CLASS}\\s*\\{[^}]*visibility: visible !important`));
  });

  it('never touches display (Tailwind .hidden etc. must keep working)', () => {
    expect(buildPreviewNeutralizeCss()).not.toContain('display');
  });
});

describe('isFullDocument', () => {
  it('detects the full-document fixture', () => {
    expect(isFullDocument(fixture)).toBe(true);
  });

  it('is false for a plain fragment', () => {
    expect(isFullDocument('<div class="card"><p>Hello</p></div>')).toBe(false);
  });

  it('is false for a fragment that merely contains style/script tags', () => {
    expect(isFullDocument('<style>.a{}</style><div>hi</div><script>1</script>')).toBe(false);
  });

  it('requires both an opening and a closing html tag', () => {
    expect(isFullDocument('<html><body><p>streaming, not closed yet</p>')).toBe(false);
  });

  it("ignores '<html>' wrapped in HTML comments (fragment must keep the base-style wrap)", () => {
    expect(isFullDocument('<!-- <html><body>example</body></html> --><div>real fragment</div>')).toBe(false);
  });
});

describe('ensureDoctype', () => {
  it('prepends a doctype to a doctype-less document (avoids quirks mode fullscreen)', () => {
    const out = ensureDoctype('<html><body><p>x</p></body></html>');
    expect(out).toMatch(/^<!DOCTYPE html>/);
    expect(out).toContain('<html><body><p>x</p></body></html>');
  });

  it('leaves a document that already has a doctype unchanged', () => {
    expect(ensureDoctype(fixture)).toBe(fixture);
  });

  it('accepts leading whitespace and case-insensitive doctype', () => {
    const code = '  \n<!doctype HTML><html><body>x</body></html>';
    expect(ensureDoctype(code)).toBe(code);
  });
});
