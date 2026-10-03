import { describe, it, expect } from 'vitest';
import zhCN from '@/i18n/locales/zh-CN';
import enUS from '@/i18n/locales/en-US';
import { contextTooSmallMessage } from './contextWindowMessages';

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
