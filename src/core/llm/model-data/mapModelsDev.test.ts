import { describe, it, expect } from 'vitest';
import { mapModelsDevModel } from './mapModelsDev';
import type { ModelsDevModel } from './schema';

const OPUS: ModelsDevModel = {
  id: 'claude-opus-4-8', family: 'claude-opus', attachment: true, reasoning: true,
  modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  limit: { context: 1000000, output: 128000 },
  cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
};

describe('mapModelsDevModel', () => {
  it('maps objective fields and leaves Abu-private fields undefined', () => {
    const r = mapModelsDevModel(OPUS, 'anthropic');
    expect(r).toMatchObject({
      id: 'claude-opus-4-8', family: 'claude-opus', vision: true,
      // Claude models are capped at 200k here so abu-overrides (merged later) can still beat the cap.
      contextWindow: 200000, maxOutputTokens: 128000, outputCeiling: 128000, reasoning: true, pdfInput: true,
      providers: ['anthropic'],
      pricing: { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 },
    });
    expect(r.thinking).toBeUndefined();
    expect(r.toolResultImages).toBeUndefined();
  });

  it('vision is true when modalities.input has image even if attachment is absent', () => {
    const r = mapModelsDevModel({ id: 'm', modalities: { input: ['text', 'image'] }, limit: { context: 1, output: 1 } }, 'openai');
    expect(r.vision).toBe(true);
  });

  it('attachment:true without image modality does NOT set vision:true', () => {
    const r = mapModelsDevModel(
      { id: 'file-only-model', attachment: true, modalities: { input: ['text'] }, limit: { context: 128000, output: 8192 } },
      'openai'
    );
    expect(r.vision).toBe(false);
  });

  it('missing cache fields default to 0; no pricing block when cost absent', () => {
    const r = mapModelsDevModel({ id: 'm', limit: { context: 1, output: 1 }, cost: { input: 1, output: 2 } }, 'x');
    expect(r.pricing).toEqual({ input: 1, output: 2, cacheRead: 0, cacheCreation: 0 });
    const r2 = mapModelsDevModel({ id: 'n', limit: { context: 1, output: 1 } }, 'x');
    expect(r2.pricing).toBeUndefined();
  });
});
