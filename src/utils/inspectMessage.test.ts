import { describe, it, expect } from 'vitest';
import { isValidInspectSelection, type InspectSelectionCheckParams } from './inspectMessage';

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

  it('rejects an oversized payload (> 64KB serialized)', () => {
    const oversized = { ...validPayload, outerHTML: 'x'.repeat(70 * 1024) };
    expect(
      isValidInspectSelection(mkParams({ data: { type: 'abu-preview-inspect:selected', nonce: NONCE, payload: oversized } })),
    ).toBe(false);
  });

  it('accepts a payload right at the boundary', () => {
    // Pad outerHTML so serialized payload lands under 64KB.
    const boundaryPayload = { ...validPayload, outerHTML: 'x'.repeat(100) };
    expect(
      isValidInspectSelection(mkParams({ data: { type: 'abu-preview-inspect:selected', nonce: NONCE, payload: boundaryPayload } })),
    ).toBe(true);
  });
});
