import { describe, it, expect } from 'vitest';
import { resolveImageVendor } from './vendorResolve';

describe('resolveImageVendor', () => {
  it('resolves Volcengine Ark hosts (chat /api/v3 base)', () => {
    expect(resolveImageVendor('https://ark.cn-beijing.volces.com/api/v3')).toBe('volcengine');
  });

  it('resolves Volcengine Ark hosts (Agent Plan /api/plan/v3 base)', () => {
    expect(resolveImageVendor('https://ark.cn-beijing.volces.com/api/plan/v3')).toBe('volcengine');
  });

  it('resolves a bare "volces" host without the "ark" subdomain', () => {
    expect(resolveImageVendor('https://open.volces.com/api/v3')).toBe('volcengine');
  });

  it('resolves SiliconFlow hosts', () => {
    expect(resolveImageVendor('https://api.siliconflow.cn/v1')).toBe('siliconflow');
  });

  it('resolves Zhipu (bigmodel) hosts', () => {
    expect(resolveImageVendor('https://open.bigmodel.cn/api/paas/v4')).toBe('zhipu');
  });

  it('resolves api.openai.com', () => {
    expect(resolveImageVendor('https://api.openai.com')).toBe('openai');
    expect(resolveImageVendor('https://api.openai.com/v1')).toBe('openai');
  });

  it('falls back to custom for unknown/aggregator hosts', () => {
    expect(resolveImageVendor('https://oneapi.qunhequnhe.com/v1')).toBe('custom');
  });

  it('falls back to custom for empty/undefined input', () => {
    expect(resolveImageVendor(undefined)).toBe('custom');
    expect(resolveImageVendor(null)).toBe('custom');
    expect(resolveImageVendor('')).toBe('custom');
  });

  it('does not false-positive match "ark" as a substring of an unrelated host', () => {
    // "markdown-api.example.com" contains the substring "ark" but must not
    // be misread as a Volcengine Ark host.
    expect(resolveImageVendor('https://markdown-api.example.com/v1')).toBe('custom');
  });

  it('handles a bare host with no scheme', () => {
    expect(resolveImageVendor('ark.cn-beijing.volces.com/api/v3')).toBe('volcengine');
  });

  describe('stored vendor precedence (F5 regression)', () => {
    it('trusts an explicitly-stored non-custom vendor over host inference, even when the host would resolve differently', () => {
      // e.g. a Volcengine Seedream endpoint reached via a corporate proxy —
      // the host has no 'volces'/'ark' in it, so host inference alone would
      // silently resolve to 'custom' and skip Seedream's min-pixel floor.
      expect(resolveImageVendor('https://gateway.internal.example.com/v1', 'volcengine')).toBe('volcengine');
    });

    it('does not let a stored "custom" vendor override host inference (custom is the default/unset value, not an authoritative choice)', () => {
      expect(resolveImageVendor('https://ark.cn-beijing.volces.com/api/v3', 'custom')).toBe('volcengine');
    });

    it('falls back to host inference when no vendor is stored', () => {
      expect(resolveImageVendor('https://ark.cn-beijing.volces.com/api/v3', undefined)).toBe('volcengine');
    });
  });
});
