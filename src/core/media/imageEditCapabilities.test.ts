import { describe, expect, it } from 'vitest';
import { imageEditCapabilities } from './imageEditCapabilities';

const seedream = { vendor: 'volcengine' as const, model: 'doubao-seedream-5.0-lite', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3/images/generations' };

describe('image editing capabilities', () => {
  it('supports Seedream source and annotated-reference editing at the configured official endpoints', () => {
    for (const baseUrl of [seedream.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3/images/generations']) {
      expect(imageEditCapabilities({ ...seedream, baseUrl })).toMatchObject({
        whole: true, comments: true, markup: true, region: false, markupTransport: 'reference',
        maxPixels: 36_000_000, canQuery: false, canCancel: false,
      });
    }
  });

  it('requires a known model, provider and endpoint together', () => {
    for (const backend of [
      null, { ...seedream, vendor: 'custom' as const }, { ...seedream, model: 'unverified-image-model' },
      { ...seedream, baseUrl: 'https://ark.cn-beijing.volces.com.example.com/api/v3/images/generations' },
      { ...seedream, baseUrl: `${seedream.baseUrl}?route=external` },
      { ...seedream, baseUrl: 'not a URL' },
      { ...seedream, baseUrl: 'http://ark.cn-beijing.volces.com/api/v3/images/generations' },
    ]) expect(imageEditCapabilities(backend).whole).toBe(false);
  });

  it('supports the Flash model with its own request profile', () => {
    for (const model of ['doubao-seedream-5.0-flash', 'doubao-seedream-5-0-flash-260915']) {
      expect(imageEditCapabilities({ ...seedream, model })).toMatchObject({
        whole: true, comments: true, markup: true, region: false, markupTransport: 'reference',
        profileVersion: 'seedream-5-flash-reference-2026-10-30',
      });
    }
  });

  it('enables native overlays and masks only for the verified OpenAI model profile', () => {
    expect(imageEditCapabilities({ vendor: 'openai', model: 'gpt-image-2.5-flare', baseUrl: 'https://api.openai.com/v1' }))
      .toMatchObject({ whole: true, markupTransport: 'overlay', region: true });
    expect(imageEditCapabilities({ vendor: 'openai', model: 'gpt-image-2.5-flare', baseUrl: 'https://images.example/v1' }).whole).toBe(false);
  });
});
