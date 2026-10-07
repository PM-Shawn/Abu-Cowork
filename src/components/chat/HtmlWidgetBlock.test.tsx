/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { DesignSystemProvider } from '@/components/ds/provider';
import HtmlWidgetBlock, { buildFullHtml, buildReceiverHtml } from './HtmlWidgetBlock';

describe('buildReceiverHtml — initial theme stamp (P3)', () => {
  it('stamps class="dark" on <body> when isDark is true (avoids first-paint flash)', () => {
    const html = buildReceiverHtml(true);
    expect(html).toContain('<body class="dark">');
  });

  it('leaves <body> without a dark class when isDark is false', () => {
    const html = buildReceiverHtml(false);
    expect(html).toContain('<body>');
    expect(html).not.toContain('<body class="dark">');
  });

  it('still wires the P3 receiver-side globals (sendPrompt, onerror, unhandledrejection)', () => {
    const html = buildReceiverHtml(false);
    expect(html).toContain('window.sendPrompt');
    expect(html).toContain('window.onerror');
    expect(html).toContain('unhandledrejection');
  });

  it('records errors and only posts widget:error inside the blank-fallback path (C2 — no eager posting)', () => {
    const html = buildReceiverHtml(false);
    // Error handlers record into abuCapturedError rather than posting eagerly.
    expect(html).toContain('abuCapturedError');
    expect(html).toContain('abuRecordErr');
    // The only widget:error post sits behind the abuApplyBlankFallback() guard.
    const blankIdx = html.indexOf('abuApplyBlankFallback()');
    const errorPostIdx = html.indexOf("type:'widget:error'");
    expect(blankIdx).toBeGreaterThan(-1);
    expect(errorPostIdx).toBeGreaterThan(blankIdx);
  });
});

describe('buildFullHtml — fullscreen wrapper', () => {
  it('injects the design system into the FRAGMENT-wrap branch', () => {
    // A widget styled inline with .w-*/--w-* must render identically
    // fullscreen — the wrap has to ship the same design CSS as RECEIVER_HTML.
    const html = buildFullHtml('<div class="w-card">hi</div>');
    expect(html).toContain('.w-card {');
    expect(html).toContain('--w-primary:');
  });

  it('leaves the full-DOCUMENT passthrough branch alone (author owns styling)', () => {
    // Complete documents render verbatim; our classes don't apply there, so we
    // must NOT inject the design system into them.
    const doc = '<!DOCTYPE html><html><head></head><body><p>x</p></body></html>';
    const out = buildFullHtml(doc);
    expect(out).not.toContain('.w-card {');
    expect(out).not.toContain('--w-primary:');
  });
});

// The frame is a document of its own: a variable of the host page does not exist in it. The base
// styles give the frame's own variables (the names widget authors use) literal values, light by
// default and dark under the `dark` class the host stamps on <body>.
describe.each([
  ['the inline frame', () => buildReceiverHtml(false)],
  ['the enlarged fragment', () => buildFullHtml('<p>fixture widget</p>')],
])('base styles of %s', (_name, build) => {
  it('do not read the text color of the host page', () => {
    expect(build()).not.toContain('var(--abu-text-primary)');
  });

  it('do not read the accent color of the host page', () => {
    expect(build()).not.toContain('var(--abu-clay)');
  });

  it('do not read the muted fill of the host page', () => {
    expect(build()).not.toContain('var(--abu-bg-muted)');
  });

  it('do not read the pressed fill of the host page', () => {
    expect(build()).not.toContain('var(--abu-bg-pressed)');
  });

  it('do not define a variable through itself', () => {
    expect(build()).not.toContain('--abu-text-muted: var(--abu-text-muted)');
  });

  it('keep every variable name widget authors use, with the light values', () => {
    const html = build();
    expect(html).toContain('--abu-primary: #0a84ff;');
    expect(html).toContain('--abu-text: #1d1d1f;');
    expect(html).toContain('--abu-text-muted: #66666b;');
    expect(html).toContain('--abu-bg: #fff;');
    expect(html).toContain('--abu-bg-secondary: #f5f5f7;');
    expect(html).toContain('--abu-border: rgba(0, 0, 0, 0.14);');
    expect(html).toContain('--abu-font: system-ui, -apple-system, sans-serif;');
  });

  it('give the same names the dark values under the dark class', () => {
    const dark = /\.dark \{([^}]*--abu-primary:[^}]*)\}/.exec(build())?.[1] ?? '';
    expect(dark).toContain('--abu-primary: #409cff;');
    expect(dark).toContain('--abu-text: #f5f5f7;');
    expect(dark).toContain('--abu-text-muted: #98989d;');
    expect(dark).toContain('--abu-bg: #1c1c1e;');
    expect(dark).toContain('--abu-bg-secondary: #2a2a2d;');
    expect(dark).toContain('--abu-border: rgba(255, 255, 255, 0.16);');
  });

  it('still draw buttons and sliders from those names', () => {
    const html = build();
    expect(html).toContain('border: 1px solid var(--abu-border); border-radius: 6px;');
    expect(html).toContain('background: var(--abu-bg); color: var(--abu-text);');
    expect(html).toContain('button:hover { background: var(--abu-bg-secondary); }');
    expect(html).toContain('input[type="range"] { accent-color: var(--abu-primary); }');
  });
});

describe('the inline frame', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.documentElement.classList.remove('dark');
  });

  async function renderWidget() {
    render(<DesignSystemProvider><HtmlWidgetBlock code="<p>fixture widget</p>" /></DesignSystemProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    return document.querySelector('iframe')!;
  }

  it('may run scripts and nothing else', async () => {
    const frame = await renderWidget();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('is stamped light while the host page is light', async () => {
    const frame = await renderWidget();
    expect(frame.srcdoc).toBe(buildReceiverHtml(false));
  });

  it('is stamped dark while the host page carries the dark class', async () => {
    document.documentElement.classList.add('dark');
    const frame = await renderWidget();
    expect(frame.srcdoc).toBe(buildReceiverHtml(true));
  });

  it('keeps its content policy', async () => {
    const frame = await renderWidget();
    expect(frame.srcdoc).toContain("default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com");
  });
});
