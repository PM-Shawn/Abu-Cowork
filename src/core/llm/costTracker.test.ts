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
      });
      // input: 1000 * 3/1M = 0.003, output: 500 * 15/1M = 0.0075
      expect(cost).toBeCloseTo(0.0105, 5);
    });

    it('accounts for cache read tokens', () => {
      // Anthropic: inputTokens = uncached portion only (excludes cache read/creation)
      const cost = calculateTurnCost('claude-sonnet-4-20250514', {
        inputTokens: 2000,      // uncached input
        outputTokens: 500,
        cacheReadInputTokens: 8000,
      });
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
      });
      // input: 2000 * 3/1M = 0.006
      // output: 100 * 15/1M = 0.0015
      // cacheCreation: 3000 * 3.75/1M = 0.01125
      expect(cost).toBeCloseTo(0.006 + 0.0015 + 0.01125, 5);
    });

    it('returns 0 for unknown models', () => {
      expect(calculateTurnCost('llama-3.1-70b', { inputTokens: 1000, outputTokens: 500 })).toBe(0);
    });

    it('returns 0 for empty usage', () => {
      expect(calculateTurnCost('claude-sonnet-4', {})).toBe(0);
    });

    it('handles Opus pricing correctly', () => {
      const cost = calculateTurnCost('claude-opus-4-20250514', {
        inputTokens: 1000,
        outputTokens: 1000,
      });
      // input: 1000 * 15/1M = 0.015, output: 1000 * 75/1M = 0.075
      expect(cost).toBeCloseTo(0.09, 5);
    });

    it('handles GPT-4o pricing', () => {
      const cost = calculateTurnCost('gpt-4o-2024-08-06', {
        inputTokens: 1000,
        outputTokens: 1000,
      });
      // input: 1000 * 2.5/1M = 0.0025, output: 1000 * 10/1M = 0.01
      expect(cost).toBeCloseTo(0.0125, 5);
    });

    it('handles DeepSeek pricing', () => {
      const cost = calculateTurnCost('deepseek-chat', {
        inputTokens: 10000,
        outputTokens: 5000,
      });
      // input: 10000 * 0.27/1M = 0.0027, output: 5000 * 1.1/1M = 0.0055
      expect(cost).toBeCloseTo(0.0082, 4);
    });

    it('handles zero uncached input with cache tokens', () => {
      // All input from cache — inputTokens = 0 (uncached), cache fields populated
      const cost = calculateTurnCost('claude-sonnet-4', {
        inputTokens: 0,
        outputTokens: 50,
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 0,
      });
      // input: 0, output: 50 * 15/1M = 0.00075, cacheRead: 1000 * 0.3/1M = 0.0003
      expect(cost).toBeCloseTo(0.00075 + 0.0003, 5);
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
      recordTurnCost('conv-1', 'claude-sonnet-4', { inputTokens: 1000, outputTokens: 500 });
      const cost = getConversationCost('conv-1');
      expect(cost).toBeGreaterThan(0);
    });

    it('accumulates multiple turns', () => {
      recordTurnCost('conv-1', 'claude-sonnet-4', { inputTokens: 1000, outputTokens: 500 });
      const cost1 = getConversationCost('conv-1');
      recordTurnCost('conv-1', 'claude-sonnet-4', { inputTokens: 2000, outputTokens: 1000 });
      const cost2 = getConversationCost('conv-1');
      expect(cost2).toBeGreaterThan(cost1);
    });

    it('tracks conversations independently', () => {
      recordTurnCost('conv-1', 'claude-sonnet-4', { inputTokens: 1000, outputTokens: 500 });
      recordTurnCost('conv-2', 'claude-opus-4', { inputTokens: 1000, outputTokens: 500 });
      expect(getConversationCost('conv-1')).not.toBe(getConversationCost('conv-2'));
    });

    it('returns 0 for unknown conversation', () => {
      expect(getConversationCost('nonexistent')).toBe(0);
    });

    it('clears conversation cost', () => {
      recordTurnCost('conv-1', 'claude-sonnet-4', { inputTokens: 1000, outputTokens: 500 });
      clearConversationCost('conv-1');
      expect(getConversationCost('conv-1')).toBe(0);
    });

    it('tracks daily cost', () => {
      const before = getDailyCost();
      recordTurnCost('conv-1', 'claude-sonnet-4', { inputTokens: 1000, outputTokens: 500 });
      expect(getDailyCost()).toBeGreaterThan(before);
    });

    it('returns 0 cost for unknown models', () => {
      const returned = recordTurnCost('conv-1', 'local-llama', { inputTokens: 1000, outputTokens: 500 });
      expect(returned).toBe(0);
    });
  });
});
