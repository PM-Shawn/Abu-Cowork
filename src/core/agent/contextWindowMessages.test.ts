import { describe, it, expect } from 'vitest';
import zhCN from '@/i18n/locales/zh-CN';
import enUS from '@/i18n/locales/en-US';
import type { ProviderInstance } from '@/types/provider';
import { resolveCapabilities } from '../llm/modelCapabilities';
import { resolveRequestBudget } from '../llm/requestBudget';
import { computeInputBudget } from '../context/contextManager';
import {
  contextTooSmallMessage,
  contextTooSmallMessageWithNumbers,
  formatTokenCount,
  planOllamaNumCtx,
  OLLAMA_NUM_CTX_MIN,
  OLLAMA_NUM_CTX_MAX,
} from './contextWindowMessages';

describe('contextTooSmallMessage', () => {
  it('uses the sentence from the concept table for a cloud model', () => {
    expect(contextTooSmallMessage(zhCN.chat, null))
      .toBe('这个模型一次能记住的内容太少，放不下阿布需要的说明。可以换一个能记得更多的模型。');
  });

  it('names the local service where the length can be raised', () => {
    expect(contextTooSmallMessage(zhCN.chat, 'lmstudio'))
      .toBe('这个模型一次能记住的内容太少，放不下阿布需要的说明。可以换一个能记得更多的模型，或者在 LM Studio 里把上下文长度调大。');
    expect(contextTooSmallMessage(zhCN.chat, 'ollama')).toContain('或者在 Ollama 里把上下文长度调大。');
    expect(contextTooSmallMessage(zhCN.chat, 'custom-local')).toContain('或者在 LM Studio / Ollama 里把上下文长度调大。');
  });

  it('has an English counterpart', () => {
    expect(contextTooSmallMessage(enUS.chat, 'ollama')).toContain('in Ollama');
  });
});

describe('contextTooSmallMessageWithNumbers', () => {
  it('states the needed and window token counts (cloud wording)', () => {
    const text = contextTooSmallMessageWithNumbers(zhCN.chat, null, 31000, 24064);
    expect(text).toContain('约需 31K tokens');
    expect(text).toContain('只有 24K');
  });

  it('tells the local service the exact length to raise to', () => {
    const text = contextTooSmallMessageWithNumbers(zhCN.chat, 'ollama', 32768, 23900);
    expect(text).toContain('调到至少 32K');
    expect(text).toContain('Ollama');
  });

  it('has an English counterpart with the numbers', () => {
    const text = contextTooSmallMessageWithNumbers(enUS.chat, 'lmstudio', 31000, 8192);
    expect(text).toContain('about 31K tokens');
    expect(text).toContain('only 8K');
  });
});

describe('formatTokenCount', () => {
  it('formats the UI length notations', () => {
    expect(formatTokenCount(8192)).toBe('8K');
    expect(formatTokenCount(131072)).toBe('128K');
    expect(formatTokenCount(128000)).toBe('128K');
    expect(formatTokenCount(23900)).toBe('24K');
    expect(formatTokenCount(1048576)).toBe('1M');
  });
});

describe('planOllamaNumCtx', () => {
  const limits = { min: OLLAMA_NUM_CTX_MIN, max: OLLAMA_NUM_CTX_MAX };
  const inputBudget = (windowSize: number) => computeInputBudget(windowSize, 4096).inputBudget;

  it('adds headroom above the fixed cost and aligns to 1024', () => {
    const planned = planOllamaNumCtx(31_000, 24_000, limits, inputBudget)!;
    expect(planned % 1024).toBe(0);
    expect(inputBudget(planned)).toBeGreaterThanOrEqual(37_000);
    expect(inputBudget(planned - 1024)).toBeLessThan(37_000);
  });

  it('keeps at least 4k of headroom even when the spent budget was tiny', () => {
    const planned = planOllamaNumCtx(31_000, 1_000, limits, inputBudget)!;
    expect(inputBudget(planned)).toBeGreaterThanOrEqual(35_096);
  });

  it('returns null when the allowed windows cannot provide enough room', () => {
    expect(planOllamaNumCtx(31_000, 24_000, { min: 8192, max: 32768 }, inputBudget)).toBeNull();
    expect(planOllamaNumCtx(65_536, 24_000, limits, inputBudget)).toBeNull();
  });

  it('returns null for impossible inputs', () => {
    expect(planOllamaNumCtx(0, 24_000, limits, inputBudget)).toBeNull();
    expect(planOllamaNumCtx(31_000, 0, limits, inputBudget)).toBeNull();
    expect(planOllamaNumCtx(31_000, 24_000, { min: 32768, max: 8192 }, inputBudget)).toBeNull();
    expect(planOllamaNumCtx(Infinity, 24_000, limits, inputBudget)).toBeNull();
  });
});

describe('Ollama recovery with complete request budgets', () => {
  const provider: ProviderInstance = {
    id: 'ollama', source: 'builtin', name: 'Ollama', enabled: true,
    apiFormat: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434', apiKey: '',
    models: [{ id: 'qwen3:32b', label: 'Qwen 3' }],
    status: 'verified', sortOrder: 0, userAdded: false,
  };
  const caps = resolveCapabilities('qwen3:32b');

  it.each([{ fixed: 20_000, current: 8192 }, { fixed: 31_000, current: 32_768 }])(
    'reserves the output budget again for $current tokens', ({ fixed, current }) => {
      const budgetAt = (windowSize: number) => {
        const budget = resolveRequestBudget('qwen3:32b', caps, provider,
          { contextWindowSize: 65_536, maxOutputTokens: 32_768 }, undefined, windowSize);
        return computeInputBudget(budget.contextWindowSize, budget.reasoningParams.maxTokens).inputBudget;
      };
      const spent = budgetAt(current);
      const planned = planOllamaNumCtx(fixed, spent, { min: current + 1, max: 65_536 }, budgetAt)!;
      expect(planned).not.toBeNull();
      expect(budgetAt(planned)).toBeGreaterThanOrEqual(fixed + Math.max(Math.round(spent / 4), 4096));
    },
  );

  it('respects a global ceiling that leaves insufficient input space', () => {
    const budgetAt = (windowSize: number) => {
      const budget = resolveRequestBudget('qwen3:32b', caps, provider,
        { contextWindowSize: 16_384, maxOutputTokens: 32_768 }, undefined, windowSize);
      return computeInputBudget(budget.contextWindowSize, budget.reasoningParams.maxTokens).inputBudget;
    };
    expect(planOllamaNumCtx(20_000, 5000, { min: 8192, max: 65_536 }, budgetAt)).toBeNull();
  });
});
