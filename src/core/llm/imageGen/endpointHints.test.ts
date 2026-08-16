import { describe, it, expect } from 'vitest';
import { isVolcengineChatEndpoint, VOLCENGINE_IMAGE_BASE_URL } from './endpointHints';

describe('isVolcengineChatEndpoint', () => {
  it('matches the V41-migrated shape: ark chat endpoint with vendor left as custom', () => {
    // Exactly what the V41 migration produced from a legacy chat-endpoint
    // config — vendor inferred from the ark host, /api/coding/ path.
    expect(isVolcengineChatEndpoint('https://ark.cn-beijing.volces.com/api/coding/v3', 'custom')).toBe(true);
  });

  it('matches with an explicit volcengine vendor', () => {
    expect(isVolcengineChatEndpoint('https://ark.cn-beijing.volces.com/api/coding/v3', 'volcengine')).toBe(true);
  });

  it('matches with no vendor at all (host inference)', () => {
    expect(isVolcengineChatEndpoint('https://ark.cn-beijing.volces.com/api/coding/v3')).toBe(true);
  });

  it('matches a /api/coding path behind a proxy host when vendor is explicitly volcengine (F5 shape)', () => {
    expect(isVolcengineChatEndpoint('https://llm-gateway.corp.example.com/api/coding/v3', 'volcengine')).toBe(true);
  });

  it('matches a trailing /api/coding with no version segment', () => {
    expect(isVolcengineChatEndpoint('https://ark.cn-beijing.volces.com/api/coding', 'volcengine')).toBe(true);
  });

  it('does NOT match the correct image endpoints (/api/v3, Agent Plan /api/plan/v3)', () => {
    expect(isVolcengineChatEndpoint(VOLCENGINE_IMAGE_BASE_URL, 'volcengine')).toBe(false);
    expect(isVolcengineChatEndpoint('https://ark.cn-beijing.volces.com/api/plan/v3', 'volcengine')).toBe(false);
  });

  it('does NOT match non-volcengine backends even with a /api/coding path', () => {
    // Vendor resolves to 'custom' — could be any gateway; only warn when we
    // actually know it's Volcengine.
    expect(isVolcengineChatEndpoint('https://llm-gateway.corp.example.com/api/coding/v3', 'custom')).toBe(false);
    expect(isVolcengineChatEndpoint('https://api.openai.com/api/coding/v3', 'openai')).toBe(false);
  });

  it('returns false for empty/undefined baseUrl', () => {
    expect(isVolcengineChatEndpoint('', 'volcengine')).toBe(false);
    expect(isVolcengineChatEndpoint(undefined, 'volcengine')).toBe(false);
    expect(isVolcengineChatEndpoint(null, 'volcengine')).toBe(false);
  });
});
