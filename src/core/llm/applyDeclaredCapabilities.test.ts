import { describe, it, expect } from 'vitest';
import { applyDeclaredCapabilities } from './applyDeclaredCapabilities';
import type { ModelCapabilities } from './modelCapabilities';

const base: ModelCapabilities = {
  vision: true, thinking: false, toolResultImages: 'none',
  documentBlock: false, maxOutputTokens: 4096, contextWindow: 128000,
};

describe('applyDeclaredCapabilities', () => {
  it('undefined declared → returns caps unchanged', () => {
    expect(applyDeclaredCapabilities(base, undefined)).toEqual(base);
  });
  it('supportsImages=false → vision false', () => {
    expect(applyDeclaredCapabilities(base, { supportsImages: false }).vision).toBe(false);
  });
  it('supportsReasoning=false → thinking false', () => {
    expect(applyDeclaredCapabilities(base, { supportsReasoning: false }).thinking).toBe(false);
  });
  it('supportsReasoning=true on non-reasoning model → thinking openai-reasoning', () => {
    expect(applyDeclaredCapabilities(base, { supportsReasoning: true }).thinking).toBe('openai-reasoning');
  });
  it('does not mutate input', () => {
    const copy = { ...base };
    applyDeclaredCapabilities(base, { supportsImages: false });
    expect(base).toEqual(copy);
  });
});
