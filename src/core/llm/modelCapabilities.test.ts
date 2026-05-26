import { describe, it, expect } from 'vitest';
import {
  resolveCapabilities,
  computeReasoningParams,
  isReasoningStarvation,
  CONTENT_FLOOR_TOKENS,
} from './modelCapabilities';

describe('modelCapabilities', () => {
  describe('resolveCapabilities — reasoning classification', () => {
    it('classifies qwen3.7-max (dated variant) as a qwen reasoning model with 65536 output', () => {
      const caps = resolveCapabilities('qwen3.7-max-2026-05-17');
      expect(caps.thinking).toBe('qwen');
      expect(caps.maxOutputTokens).toBe(65536);
    });

    it('classifies qwen3-max as a qwen reasoning model', () => {
      expect(resolveCapabilities('qwen3-max').thinking).toBe('qwen');
    });

    it('keeps qwen2.5-72b-instruct as non-reasoning with 8192 output', () => {
      const caps = resolveCapabilities('qwen2.5-72b-instruct');
      expect(caps.thinking).toBe(false);
      expect(caps.maxOutputTokens).toBe(8192);
    });

    it('keeps qwen-max as non-reasoning 8192 (probe-corrected)', () => {
      const caps = resolveCapabilities('qwen-max');
      expect(caps.thinking).toBe(false);
      expect(caps.maxOutputTokens).toBe(8192);
    });

    it('marks deepseek-r1 reasoning as uncontrollable', () => {
      expect(resolveCapabilities('deepseek-r1').thinking).toBe('uncontrollable');
      expect(resolveCapabilities('deepseek-reasoner').thinking).toBe('uncontrollable');
    });
  });

  describe('computeReasoningParams — content floor', () => {
    it('qwen: reserves the content floor below max_tokens via thinking_budget', () => {
      const caps = resolveCapabilities('qwen3.7-max');
      const p = computeReasoningParams(caps, 32768);
      // reasoning model uses its full ceiling regardless of the requested budget
      expect(p.maxTokens).toBe(65536);
      expect(p.thinkingBudget).toBe(65536 - CONTENT_FLOOR_TOKENS);
      // content always has room
      expect(p.maxTokens - p.thinkingBudget!).toBeGreaterThanOrEqual(CONTENT_FLOOR_TOKENS);
    });

    it('non-reasoning: clamps to the smaller of user budget and model ceiling', () => {
      const caps = resolveCapabilities('qwen2.5-72b-instruct'); // 8192
      const p = computeReasoningParams(caps, 32768);
      expect(p.maxTokens).toBe(8192);
      expect(p.thinkingBudget).toBeUndefined();
      expect(p.reasoningEffort).toBeUndefined();
    });

    it('anthropic: enables thinking and keeps a 16384 floor', () => {
      const caps = resolveCapabilities('claude-sonnet-4-6');
      const p = computeReasoningParams(caps, 32768);
      expect(p.enableThinking).toBe(true);
      expect(p.thinkingBudget).toBe(10000);
      expect(p.maxTokens).toBeGreaterThanOrEqual(16384);
    });

    it('uncontrollable: gives full ceiling, no budget knob', () => {
      const caps = resolveCapabilities('deepseek-r1');
      const p = computeReasoningParams(caps, 32768);
      expect(p.thinkingBudget).toBeUndefined();
      expect(p.reasoningEffort).toBeUndefined();
      expect(p.maxTokens).toBe(caps.maxOutputTokens);
    });

    it('never lets thinking_budget drop below the 1024 minimum on tiny budgets', () => {
      const p = computeReasoningParams(
        { vision: false, thinking: 'qwen', toolResultImages: 'none', documentBlock: false, maxOutputTokens: 4096, contextWindow: 32768 },
        4096,
      );
      expect(p.thinkingBudget).toBe(1024);
    });
  });

  describe('isReasoningStarvation', () => {
    it('true when truncated with no content and no tool calls', () => {
      expect(isReasoningStarvation('max_tokens', 0, 0)).toBe(true);
      expect(isReasoningStarvation('length', 0, 0)).toBe(true);
    });

    it('false when content was produced', () => {
      expect(isReasoningStarvation('max_tokens', 120, 0)).toBe(false);
    });

    it('false when a tool call was produced', () => {
      expect(isReasoningStarvation('max_tokens', 0, 1)).toBe(false);
    });

    it('false on normal end_turn', () => {
      expect(isReasoningStarvation('end_turn', 0, 0)).toBe(false);
    });
  });
});
