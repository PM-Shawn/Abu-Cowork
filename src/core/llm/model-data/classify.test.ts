import { describe, it, expect } from 'vitest';
import { classifyThinking, classifyToolResultImages, classifyDocumentBlock } from './classify';

describe('classifyThinking', () => {
  it('non-reasoning models are false regardless of family', () => {
    expect(classifyThinking({ id: 'claude-haiku-4-5', family: 'claude-haiku', reasoning: false })).toBe(false);
  });
  it('reasoning claude → anthropic protocol', () => {
    expect(classifyThinking({ id: 'claude-opus-4-8', family: 'claude-opus', reasoning: true })).toBe('anthropic');
  });
  it('reasoning gpt-5 / o-series → openai-reasoning', () => {
    expect(classifyThinking({ id: 'gpt-5.4', family: 'gpt', reasoning: true })).toBe('openai-reasoning');
    expect(classifyThinking({ id: 'o3', family: 'o3', reasoning: true })).toBe('openai-reasoning');
  });
  it('reasoning qwen3.x-max → qwen budget protocol', () => {
    expect(classifyThinking({ id: 'qwen3-max', family: 'qwen', reasoning: true })).toBe('qwen');
  });
  it('deepseek reasoner → uncontrollable', () => {
    expect(classifyThinking({ id: 'deepseek-reasoner', family: 'deepseek', reasoning: true })).toBe('uncontrollable');
  });
  it('unknown reasoning family → uncontrollable (safe: reasons, no knob)', () => {
    expect(classifyThinking({ id: 'mystery-r1', family: 'mystery', reasoning: true })).toBe('uncontrollable');
  });
});

describe('classifyToolResultImages', () => {
  it('claude → native', () => {
    expect(classifyToolResultImages('claude-opus-4-8', 'claude-opus')).toBe('native');
  });
  it('local/llama/gemma/mistral → none', () => {
    expect(classifyToolResultImages('llama3.3', 'llama')).toBe('none');
    expect(classifyToolResultImages('gemma3', 'gemma')).toBe('none');
  });
  it('cloud openai-compatible vendors → workaround', () => {
    expect(classifyToolResultImages('gpt-4o', 'gpt')).toBe('workaround');
    expect(classifyToolResultImages('qwen3-max', 'qwen')).toBe('workaround');
  });
});

describe('classifyDocumentBlock', () => {
  it('claude family supports document blocks', () => {
    expect(classifyDocumentBlock('claude-opus-4-8')).toBe(true);
  });
  it('non-claude does not', () => {
    expect(classifyDocumentBlock('gpt-4o')).toBe(false);
  });
});
