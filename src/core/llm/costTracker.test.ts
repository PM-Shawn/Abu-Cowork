import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateTurnCost,
  formatCost,
  recordTurnCost,
  getConversationCost,
  getDailyCost,
  clearConversationCost,
} from './costTracker';

describe('costTracker', () => {
  // ── calculateTurnCost ──
  describe('calculateTurnCost', () => {
    it('calculates cost for Claude Sonnet 4', () => {
      const cost = calculateTurnCost('claude-sonnet-4-20250514', {
        inputTokens: 1000,
        outputTokens: 500,
      }, 'anthropic');
      // input: 1000 * 3/1M = 0.003, output: 500 * 15/1M = 0.0075
      expect(cost).toBeCloseTo(0.0105, 5);
    });

    it('accounts for cache read tokens', () => {
      // Anthropic: inputTokens = uncached portion only (excludes cache read/creation)
      const cost = calculateTurnCost('claude-sonnet-4-20250514', {
        inputTokens: 2000,      // uncached input
        outputTokens: 500,
        cacheReadInputTokens: 8000,
      }, 'anthropic');
      // input: 2000 * 3/1M = 0.006
      // output: 500 * 15/1M = 0.0075
      // cacheRead: 8000 * 0.3/1M = 0.0024
      expect(cost).toBeCloseTo(0.006 + 0.0075 + 0.0024, 5);
    });

    it('accounts for cache creation tokens', () => {
      const cost = calculateTurnCost('claude-sonnet-4-20250514', {
        inputTokens: 2000,      // uncached input
        outputTokens: 100,
        cacheCreationInputTokens: 3000,
      }, 'anthropic');
      // input: 2000 * 3/1M = 0.006
      // output: 100 * 15/1M = 0.0015
      // cacheCreation: 3000 * 3.75/1M = 0.01125
      expect(cost).toBeCloseTo(0.006 + 0.0015 + 0.01125, 5);
    });

    it('returns 0 for unknown models', () => {
      expect(calculateTurnCost('llama-3.1-70b', { inputTokens: 1000, outputTokens: 500 }, 'openai-compatible')).toBe(0);
    });

    it('gpt-4-turbo uses its own FALLBACK_PRICING entry, not the shorter gpt-4 prefix', () => {
      // gpt-4-turbo: input $10/M. Without length sort, bare 'gpt-4' ($30/M) would win.
      const cost = calculateTurnCost('gpt-4-turbo', { inputTokens: 1_000_000 }, 'openai-compatible');
      // 1M tokens * $10/M = $10
      expect(cost).toBeCloseTo(10, 2);
    });

    it('returns 0 for empty usage', () => {
      expect(calculateTurnCost('claude-sonnet-4', {}, 'anthropic')).toBe(0);
    });

    it('handles Opus pricing correctly', () => {
      const cost = calculateTurnCost('claude-opus-4-20250514', {
        inputTokens: 1000,
        outputTokens: 1000,
      }, 'anthropic');
      // input: 1000 * 15/1M = 0.015, output: 1000 * 75/1M = 0.075
      expect(cost).toBeCloseTo(0.09, 5);
    });

    it('handles GPT-4o pricing', () => {
      const cost = calculateTurnCost('gpt-4o-2024-08-06', {
        inputTokens: 1000,
        outputTokens: 1000,
      }, 'openai-compatible');
      // input: 1000 * 2.5/1M = 0.0025, output: 1000 * 10/1M = 0.01
      expect(cost).toBeCloseTo(0.0125, 5);
    });

    it('handles DeepSeek pricing', () => {
      const cost = calculateTurnCost('deepseek-chat', {
        inputTokens: 10000,
        outputTokens: 5000,
      }, 'openai-compatible');
      // Price sourced from models.dev (DeepSeek V3.2 price cut), not the stale fallback.
      // input: 10000 * 0.14/1M = 0.0014, output: 5000 * 0.28/1M = 0.0014
      expect(cost).toBeCloseTo(0.0028, 4);
    });

    // overlay/deepseek.json deliberately omits `pricing` for the vision route so it
    // inherits deepseek-v4-flash's numbers by id prefix (official docs price the two
    // identically). Pin that: if findPricing's prefix scan ever changes, the vision
    // model would silently fall through to $0 and every turn would report free.
    it('deepseek-v4-flash-vision-exp inherits deepseek-v4-flash pricing by id prefix', () => {
      const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
      const vision = calculateTurnCost('deepseek-v4-flash-vision-exp', usage, 'openai-compatible');
      const flash = calculateTurnCost('deepseek-v4-flash', usage, 'openai-compatible');
      expect(flash).toBeGreaterThan(0);
      expect(vision).toBeCloseTo(flash, 6);
    });

    it('handles zero uncached input with cache tokens', () => {
      // All input from cache — inputTokens = 0 (uncached), cache fields populated
      const cost = calculateTurnCost('claude-sonnet-4', {
        inputTokens: 0,
        outputTokens: 50,
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 0,
      }, 'anthropic');
      // input: 0, output: 50 * 15/1M = 0.00075, cacheRead: 1000 * 0.3/1M = 0.0003
      expect(cost).toBeCloseTo(0.00075 + 0.0003, 5);
    });

    it('charges the cached part of an OpenAI-compatible prompt once, at the cache price', () => {
      // OpenAI 兼容协议的 inputTokens 是整段输入，其中 8000 命中了缓存。
      const cost = calculateTurnCost('gpt-4o-2024-08-06', {
        inputTokens: 10_000,
        outputTokens: 1000,
        cacheReadInputTokens: 8000,
      }, 'openai-compatible');
      // input: (10000 - 8000) * 2.5/1M = 0.005
      // output: 1000 * 10/1M = 0.01
      // cacheRead: 8000 * 1.25/1M = 0.01
      expect(cost).toBeCloseTo(0.005 + 0.01 + 0.01, 5);
    });

    it('prices the same turn the same way under either protocol', () => {
      // 同一次请求：2000 没有命中缓存，8000 命中缓存。两种协议只是报法不同。
      const anthropic = calculateTurnCost('gpt-4o-2024-08-06', {
        inputTokens: 2000,
        outputTokens: 1000,
        cacheReadInputTokens: 8000,
      }, 'anthropic');
      const openAiCompatible = calculateTurnCost('gpt-4o-2024-08-06', {
        inputTokens: 10_000,
        outputTokens: 1000,
        cacheReadInputTokens: 8000,
      }, 'openai-compatible');
      expect(openAiCompatible).toBeCloseTo(anthropic, 8);
    });

    it('returns 0 when an OpenAI-compatible provider reports more cached tokens than prompt tokens', () => {
      // 数字互相矛盾，没有命中缓存的部分无法确定，不给出估算。
      const cost = calculateTurnCost('gpt-4o-2024-08-06', {
        inputTokens: 1000,
        outputTokens: 1000,
        cacheReadInputTokens: 1200,
      }, 'openai-compatible');
      expect(cost).toBe(0);
    });
  });

  // ── formatCost ──
  describe('formatCost', () => {
    it('formats zero', () => {
      expect(formatCost(0)).toBe('$0');
    });

    it('formats tiny costs with 3 decimals', () => {
      expect(formatCost(0.001)).toBe('$0.001');
      expect(formatCost(0.009)).toBe('$0.009');
    });

    it('formats small costs with 2 decimals', () => {
      expect(formatCost(0.08)).toBe('$0.08');
      expect(formatCost(0.99)).toBe('$0.99');
    });

    it('formats large costs with 2 decimals', () => {
      expect(formatCost(1.23)).toBe('$1.23');
      expect(formatCost(99.5)).toBe('$99.50');
    });
  });

  // ── Session accumulator ──
  describe('session accumulator', () => {
    beforeEach(() => {
      clearConversationCost('conv-1');
      clearConversationCost('conv-2');
    });

    it('records and retrieves conversation cost', () => {
      recordTurnCost('conv-1', 'claude-sonnet-4', { inputTokens: 1000, outputTokens: 500 }, 'anthropic');
      const cost = getConversationCost('conv-1');
      expect(cost).toBeGreaterThan(0);
    });

    it('accumulates multiple turns', () => {
      recordTurnCost('conv-1', 'claude-sonnet-4', { inputTokens: 1000, outputTokens: 500 }, 'anthropic');
      const cost1 = getConversationCost('conv-1');
      recordTurnCost('conv-1', 'claude-sonnet-4', { inputTokens: 2000, outputTokens: 1000 }, 'anthropic');
      const cost2 = getConversationCost('conv-1');
      expect(cost2).toBeGreaterThan(cost1);
    });

    it('tracks conversations independently', () => {
      recordTurnCost('conv-1', 'claude-sonnet-4', { inputTokens: 1000, outputTokens: 500 }, 'anthropic');
      recordTurnCost('conv-2', 'claude-opus-4', { inputTokens: 1000, outputTokens: 500 }, 'anthropic');
      expect(getConversationCost('conv-1')).not.toBe(getConversationCost('conv-2'));
    });

    it('returns 0 for unknown conversation', () => {
      expect(getConversationCost('nonexistent')).toBe(0);
    });

    it('clears conversation cost', () => {
      recordTurnCost('conv-1', 'claude-sonnet-4', { inputTokens: 1000, outputTokens: 500 }, 'anthropic');
      clearConversationCost('conv-1');
      expect(getConversationCost('conv-1')).toBe(0);
    });

    it('tracks daily cost', () => {
      const before = getDailyCost();
      recordTurnCost('conv-1', 'claude-sonnet-4', { inputTokens: 1000, outputTokens: 500 }, 'anthropic');
      expect(getDailyCost()).toBeGreaterThan(before);
    });

    it('returns 0 cost for unknown models', () => {
      const returned = recordTurnCost('conv-1', 'local-llama', { inputTokens: 1000, outputTokens: 500 }, 'openai-compatible');
      expect(returned).toBe(0);
    });
  });

  describe('pricing sourced from generated data', () => {
    it('uses exact models.dev price for opus 4.8 (input $5/M)', () => {
      const cost = calculateTurnCost('claude-opus-4-8', { inputTokens: 1_000_000 }, 'anthropic');
      expect(cost).toBeCloseTo(5, 5);
    });
    it('still falls back to family prefix for un-snapshotted dated variants', () => {
      const cost = calculateTurnCost('claude-opus-4-8-some-future-suffix', { inputTokens: 1_000_000 }, 'anthropic');
      expect(cost).toBeGreaterThan(0);
    });
  });

  describe('findPricing — OpenRouter vendor prefix stripping', () => {
    it('strips vendor/ prefix so anthropic/claude-opus-4-8 resolves the same price as bare id', () => {
      const withPrefix = calculateTurnCost('anthropic/claude-opus-4-8', { inputTokens: 1_000_000 }, 'anthropic');
      const bare = calculateTurnCost('claude-opus-4-8', { inputTokens: 1_000_000 }, 'anthropic');
      // Both should resolve the opus-4-8 generated price ($5/M input)
      expect(withPrefix).toBeCloseTo(5, 5);
      expect(withPrefix).toBeCloseTo(bare, 8);
    });

    it('prefix lookup is case-insensitive', () => {
      const lower = calculateTurnCost('claude-opus-4-8', { inputTokens: 1_000_000 }, 'anthropic');
      const upper = calculateTurnCost('Claude-Opus-4-8', { inputTokens: 1_000_000 }, 'anthropic');
      expect(upper).toBeCloseTo(lower, 8);
    });
  });
});
