import { describe, it, expect } from 'vitest';
import zhCN from '@/i18n/locales/zh-CN';
import enUS from '@/i18n/locales/en-US';
import {
  contextTooSmallMessage,
  contextTooSmallMessageWithNumbers,
  formatTokenCount,
  planOllamaNumCtx,
  canWindowHoldFixedCost,
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

  it('adds headroom above the fixed cost and aligns to 1024', () => {
    // fixed 31k, spent budget 24k → headroom 6k → 37k → aligned 37888
    expect(planOllamaNumCtx(31_000, 24_000, limits)).toBe(37_888);
  });

  it('keeps at least 4k of headroom even when the spent budget was tiny', () => {
    // fixed 31k, spent budget 1k → headroom max(0.25k, 4k) = 4k → 35k → 35840
    expect(planOllamaNumCtx(31_000, 1_000, limits)).toBe(35_840);
  });

  it('clamps into the protection bounds', () => {
    expect(planOllamaNumCtx(31_000, 24_000, { min: 8192, max: 32768 })).toBe(32768);
    // headroom = max(6000, 4096) = 6000 → 4000 + 6000 → 10240, above the min
    expect(planOllamaNumCtx(4_000, 24_000, limits)).toBe(10_240);
  });

  it('returns null for impossible inputs', () => {
    expect(planOllamaNumCtx(0, 24_000, limits)).toBeNull();
    expect(planOllamaNumCtx(31_000, 0, limits)).toBeNull();
    expect(planOllamaNumCtx(31_000, 24_000, { min: 32768, max: 8192 })).toBeNull();
  });
});

describe('canWindowHoldFixedCost', () => {
  // Mirror of contextManager's margin: min(floor(raw*0.05), max(1, min(4096, ceil(window*0.02)))).
  it('holds when fixed cost fits below the safe budget', () => {
    // raw = 37888 - 37888? No: reserve is maxOutputTokens, take 4096 → raw 33792,
    // margin = min(1689, max(1, min(4096, 758))) = 758 → budget 33034 > 31000
    expect(canWindowHoldFixedCost(37_888, 4_096, 31_000)).toBe(true);
  });

  it('rejects when the fixed cost alone still exceeds the safe budget', () => {
    expect(canWindowHoldFixedCost(32_768, 4_096, 31_000)).toBe(false);
  });

  it('rejects a window smaller than the output reserve', () => {
    expect(canWindowHoldFixedCost(8_192, 8_192, 1_000)).toBe(false);
  });
});
