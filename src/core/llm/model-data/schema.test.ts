import { describe, it, expect } from 'vitest';
import { PROVIDER_ALLOWLIST, type ModelRecord } from './schema';

describe('model-data schema', () => {
  it('allowlist contains the providers Abu ships, keyed by models.dev id', () => {
    expect(PROVIDER_ALLOWLIST).toContain('anthropic');
    expect(PROVIDER_ALLOWLIST).toContain('openai');
    expect(PROVIDER_ALLOWLIST).toContain('deepseek');
    expect(PROVIDER_ALLOWLIST).toContain('moonshotai');
    expect(PROVIDER_ALLOWLIST).toContain('zhipuai');
    expect(PROVIDER_ALLOWLIST).toContain('alibaba');
    expect(PROVIDER_ALLOWLIST).not.toContain('moark');
  });

  it('ModelRecord shape is assignable', () => {
    const r: ModelRecord = {
      id: 'x', vision: true, contextWindow: 1000, maxOutputTokens: 100,
      reasoning: false, pdfInput: false,
    };
    expect(r.id).toBe('x');
  });
});
