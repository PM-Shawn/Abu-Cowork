import { describe, it, expect } from 'vitest';
import { buildGeneratedSource, recordsToCapabilities, recordsToPricing } from './gen-model-data';
import type { ModelRecord } from '../src/core/llm/model-data/schema';

const recs: ModelRecord[] = [
  { id: 'claude-opus-4-8', family: 'claude-opus', vision: true, contextWindow: 1000000,
    maxOutputTokens: 128000, reasoning: true, pdfInput: true, providers: ['anthropic'],
    thinking: 'anthropic', toolResultImages: 'native', documentBlock: true,
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 } },
  { id: 'doubao-seed-2.0-pro', vision: true, contextWindow: 256000, maxOutputTokens: 32768,
    reasoning: false, pdfInput: false, providers: ['volcengine'],
    thinking: false, toolResultImages: 'workaround', documentBlock: false },
];

describe('gen-model-data builders', () => {
  it('recordsToCapabilities emits the ModelCapabilities shape keyed by id', () => {
    const caps = recordsToCapabilities(recs);
    expect(caps['claude-opus-4-8']).toEqual({
      vision: true, thinking: 'anthropic', toolResultImages: 'native',
      documentBlock: true, maxOutputTokens: 128000, contextWindow: 1000000,
    });
  });

  it('recordsToPricing emits [id, pricing] only for records that have pricing, longest id first', () => {
    const pricing = recordsToPricing(recs);
    expect(pricing).toEqual([['claude-opus-4-8', { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 }]]);
  });

  it('buildGeneratedSource produces a do-not-edit banner and valid exports', () => {
    const src = buildGeneratedSource(recs);
    expect(src).toContain('DO NOT EDIT');
    expect(src).toContain('export const GENERATED_KNOWN_MODELS');
    expect(src).toContain('export const GENERATED_MODEL_PRICING');
    expect(src).toContain('export const GENERATED_PROVIDER_MODELS');
    expect(src).toContain("'claude-opus-4-8'");
  });
});
