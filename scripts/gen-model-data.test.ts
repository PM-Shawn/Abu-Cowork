import { describe, it, expect } from 'vitest';
import { buildGeneratedSource, recordsToCapabilities, recordsToPricing } from './gen-model-data';
import type { ModelRecord } from '../src/core/llm/model-data/schema';

const recs: ModelRecord[] = [
  { id: 'claude-opus-4-8', family: 'claude-opus', vision: true, contextWindow: 1000000,
    maxOutputTokens: 128000, outputCeiling: 128000, reasoning: true, pdfInput: true, providers: ['anthropic'],
    thinking: 'anthropic', toolResultImages: 'native', documentBlock: true,
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 } },
  { id: 'doubao-seed-2.0-pro', vision: true, contextWindow: 256000, maxOutputTokens: 32768,
    outputCeiling: 32768, reasoning: false, pdfInput: false, providers: ['volcengine'],
    thinking: false, toolResultImages: 'workaround', documentBlock: false },
];

describe('gen-model-data builders', () => {
  it('recordsToCapabilities emits the ModelCapabilities shape keyed by id', () => {
    const caps = recordsToCapabilities(recs);
    expect(caps['claude-opus-4-8']).toEqual({
      vision: true, thinking: 'anthropic', toolResultImages: 'native',
      documentBlock: true, maxOutputTokens: 32768, outputCeiling: 128000, contextWindow: 200000,
    });
  });

  it('recordsToPricing emits [id, pricing] only for records that have pricing, longest id first', () => {
    const pricing = recordsToPricing(recs);
    expect(pricing).toEqual([['claude-opus-4-8', { input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 }]]);
  });

  it('caps the request budget: uncontrollable→32768, others→min(ceiling,128000), ceiling preserved', () => {
    const caps = recordsToCapabilities([
      { id: 'deepseek-reasoner', vision: false, contextWindow: 1000000, maxOutputTokens: 384000,
        outputCeiling: 384000, reasoning: true, pdfInput: false, thinking: 'uncontrollable',
        toolResultImages: 'none', documentBlock: false },
      { id: 'gpt-5.4', vision: true, contextWindow: 400000, maxOutputTokens: 128000,
        outputCeiling: 128000, reasoning: true, pdfInput: false, thinking: 'openai-reasoning',
        toolResultImages: 'workaround', documentBlock: false },
      { id: 'qwen3.7-max', vision: false, contextWindow: 1000000, maxOutputTokens: 65536,
        outputCeiling: 65536, reasoning: true, pdfInput: false, thinking: 'qwen',
        toolResultImages: 'workaround', documentBlock: false },
    ]);
    expect(caps['deepseek-reasoner'].maxOutputTokens).toBe(32768);
    expect(caps['deepseek-reasoner'].outputCeiling).toBe(384000);
    expect(caps['gpt-5.4'].maxOutputTokens).toBe(128000);
    expect(caps['qwen3.7-max'].maxOutputTokens).toBe(65536);
  });

  it('buildGeneratedSource produces a do-not-edit banner and valid exports', () => {
    const src = buildGeneratedSource(recs);
    expect(src).toContain('DO NOT EDIT');
    expect(src).toContain('export const GENERATED_KNOWN_MODELS');
    expect(src).toContain('export const GENERATED_MODEL_PRICING');
    expect(src).toContain("'claude-opus-4-8'");
  });
});
