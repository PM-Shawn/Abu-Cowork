/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { buildFullHtml, buildReceiverHtml } from './HtmlWidgetBlock';

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
