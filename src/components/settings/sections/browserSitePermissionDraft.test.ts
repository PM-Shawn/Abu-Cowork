import { describe, expect, it } from 'vitest';
import { analyzeBrowserSitePermissionDraft } from './browserSitePermissionDraft';

describe('analyzeBrowserSitePermissionDraft', () => {
  it('uses the gate normalizer and keeps exact scheme and non-default port scope', () => {
    expect(analyzeBrowserSitePermissionDraft(
      'https://EXAMPLE.com.:8443/reports?q=1#top',
      'allowed',
      {},
    )).toMatchObject({
      issue: null,
      normalizedOrigin: 'https://example.com:8443',
      changesExisting: false,
    });
    expect(analyzeBrowserSitePermissionDraft('http://example.com', 'allowed', {}))
      .toMatchObject({ issue: null, normalizedOrigin: 'http://example.com' });
  });

  it.each([
    'https://user:pass@example.com/path',
    'https://user:pass@',
    'https://user:pass @exa mple.com',
  ])('recognizes credential-bearing input without returning the sensitive address: %s', (raw) => {
    expect(analyzeBrowserSitePermissionDraft(raw, 'allowed', {})).toEqual({
      issue: 'credentials',
      normalizedOrigin: null,
      existingVerdict: undefined,
      changesExisting: false,
    });
  });

  it('checks high-risk paths before their path is removed by normalization', () => {
    expect(analyzeBrowserSitePermissionDraft(
      'https://shop.example.com/account/checkout',
      'allowed',
      {},
    )).toMatchObject({
      issue: 'high-risk',
      normalizedOrigin: 'https://shop.example.com',
    });
    expect(analyzeBrowserSitePermissionDraft(
      'https://shop.example.com/account/checkout',
      'denied',
      {},
    )).toMatchObject({ issue: null, normalizedOrigin: 'https://shop.example.com' });
  });

  it('treats an exact same-tier record as a zero-write duplicate before high-risk refusal', () => {
    expect(analyzeBrowserSitePermissionDraft(
      'https://www.bankofamerica.com',
      'allowed',
      { 'https://www.bankofamerica.com': 'allowed' },
    )).toEqual({
      issue: 'duplicate',
      normalizedOrigin: 'https://www.bankofamerica.com',
      existingVerdict: 'allowed',
      changesExisting: false,
    });
  });

  it('marks an exact origin with a different tier as an edit', () => {
    expect(analyzeBrowserSitePermissionDraft(
      'https://example.com/some/page',
      'denied',
      { 'https://example.com': 'allowed' },
    )).toEqual({
      issue: null,
      normalizedOrigin: 'https://example.com',
      existingVerdict: 'allowed',
      changesExisting: true,
    });
  });
});
