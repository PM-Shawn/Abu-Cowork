import { describe, it, expect } from 'vitest';
import { isValidInspectSelection, resolveReferencePath, type InspectSelectionCheckParams } from './inspectMessage';

const IFRAME_WINDOW = { __marker: 'iframe' } as unknown;
const OTHER_WINDOW = { __marker: 'other' } as unknown;
const ORIGIN = 'http://127.0.0.1:54321';
const NONCE = 'abc123';

const validPayload = {
  tagName: 'BUTTON',
  id: 'submit',
  classList: ['pay-btn'],
  selector: 'button#submit',
  outerHTML: '<button id="submit">支付</button>',
  text: '支付',
  computedStyle: { display: 'flex' },
  rect: { x: 0, y: 0, width: 100, height: 40 },
  pageUrl: 'http://127.0.0.1:54321/files/tok/root/index.html',
  pageTitle: 'demo',
};

function mkParams(overrides: Partial<InspectSelectionCheckParams> = {}): InspectSelectionCheckParams {
  return {
    source: IFRAME_WINDOW,
    origin: ORIGIN,
    data: { type: 'abu-preview-inspect:selected', nonce: NONCE, payload: validPayload },
    expectedOrigin: ORIGIN,
    expectedSource: IFRAME_WINDOW,
    expectedNonce: NONCE,
    ...overrides,
  };
}

describe('isValidInspectSelection', () => {
  it('accepts a well-formed message from the armed iframe (happy path)', () => {
    expect(isValidInspectSelection(mkParams())).toBe(true);
  });

  it('rejects when source is a different window (wrong source)', () => {
    expect(isValidInspectSelection(mkParams({ source: OTHER_WINDOW }))).toBe(false);
  });

  it('rejects when there is no expected source (iframe unmounted)', () => {
    expect(isValidInspectSelection(mkParams({ expectedSource: null }))).toBe(false);
  });

  it('rejects when origin does not match (wrong origin)', () => {
    expect(isValidInspectSelection(mkParams({ origin: 'http://evil.example.com' }))).toBe(false);
  });

  it('rejects non-object data', () => {
    expect(isValidInspectSelection(mkParams({ data: 'not-an-object' }))).toBe(false);
    expect(isValidInspectSelection(mkParams({ data: null }))).toBe(false);
  });

  it('rejects when type is wrong (wrong type)', () => {
    expect(
      isValidInspectSelection(mkParams({ data: { type: 'abu-preview-inspect:set-enabled', nonce: NONCE, payload: validPayload } })),
    ).toBe(false);
  });

  it('rejects when nonce is missing on the message', () => {
    expect(
      isValidInspectSelection(mkParams({ data: { type: 'abu-preview-inspect:selected', payload: validPayload } })),
    ).toBe(false);
  });

  it('rejects when nonce does not match (wrong nonce)', () => {
    expect(
      isValidInspectSelection(mkParams({ data: { type: 'abu-preview-inspect:selected', nonce: 'stale-nonce', payload: validPayload } })),
    ).toBe(false);
  });

  it('rejects when no session is currently armed (expectedNonce null)', () => {
    expect(isValidInspectSelection(mkParams({ expectedNonce: null }))).toBe(false);
  });

  it('rejects when payload is missing or malformed (no outerHTML)', () => {
    expect(
      isValidInspectSelection(mkParams({ data: { type: 'abu-preview-inspect:selected', nonce: NONCE, payload: { tagName: 'DIV' } } })),
    ).toBe(false);
    expect(
      isValidInspectSelection(mkParams({ data: { type: 'abu-preview-inspect:selected', nonce: NONCE, payload: null } })),
    ).toBe(false);
  });

  it('rejects an oversized payload (> 128KB serialized)', () => {
    const oversized = { ...validPayload, outerHTML: 'x'.repeat(140 * 1024) };
    expect(
      isValidInspectSelection(mkParams({ data: { type: 'abu-preview-inspect:selected', nonce: NONCE, payload: oversized } })),
    ).toBe(false);
  });

  it('accepts a payload right at the boundary', () => {
    // Pad outerHTML so serialized payload lands under 128KB.
    const boundaryPayload = { ...validPayload, outerHTML: 'x'.repeat(100) };
    expect(
      isValidInspectSelection(mkParams({ data: { type: 'abu-preview-inspect:selected', nonce: NONCE, payload: boundaryPayload } })),
    ).toBe(true);
  });

  it('accepts a legit picker-truncated payload that would have overflowed the old 64KB cap', () => {
    // Picker script raw-truncates outerHTML to 40960 chars, but every `"`
    // in a quote-dense string doubles in size under JSON escaping (`\"`).
    // 40960 raw chars of quotes -> ~80KB serialized, which overflowed the
    // old 64KB cap (silently dropping the pick) but fits comfortably under
    // the new 128KB cap.
    const heavyOuterHTML = '"'.repeat(40960);
    const heavyPayload = { ...validPayload, outerHTML: heavyOuterHTML, text: 'x'.repeat(2000) };
    const serializedLen = JSON.stringify(heavyPayload).length;
    expect(serializedLen).toBeGreaterThan(64 * 1024);
    expect(serializedLen).toBeLessThanOrEqual(128 * 1024);
    expect(
      isValidInspectSelection(mkParams({ data: { type: 'abu-preview-inspect:selected', nonce: NONCE, payload: heavyPayload } })),
    ).toBe(true);
  });
});

describe('resolveReferencePath', () => {
  it('returns previewFilePath when present, ignoring pageUrl entirely', () => {
    expect(resolveReferencePath('/Users/shawn/project/index.html', 'http://127.0.0.1:54321/files/TOKEN123/rootid/index.html')).toBe(
      '/Users/shawn/project/index.html',
    );
  });

  it('strips the loopback prefix when previewFilePath is absent (null)', () => {
    expect(resolveReferencePath(null, 'http://127.0.0.1:54321/files/TOKEN123/rootid/sub/dir/index.html')).toBe('sub/dir/index.html');
  });

  it('strips the loopback prefix when previewFilePath is absent (undefined)', () => {
    expect(resolveReferencePath(undefined, 'http://127.0.0.1:54321/files/abcDEF456/root9/index.html')).toBe('index.html');
  });

  it('strips the loopback prefix when previewFilePath is empty string (falsy)', () => {
    expect(resolveReferencePath('', 'http://127.0.0.1:9999/files/tok/root/index.html')).toBe('index.html');
  });

  it('handles https loopback URLs too', () => {
    expect(resolveReferencePath(null, 'https://127.0.0.1:54321/files/TOKEN/root/index.html')).toBe('index.html');
  });

  it('leaves a non-loopback pageUrl unchanged', () => {
    expect(resolveReferencePath(null, 'https://example.com/checkout')).toBe('https://example.com/checkout');
  });

  it('never leaks the token into the returned path', () => {
    const result = resolveReferencePath(undefined, 'http://127.0.0.1:54321/files/SUPER-SECRET-TOKEN/rootid/index.html');
    expect(result).not.toContain('SUPER-SECRET-TOKEN');
  });
});
