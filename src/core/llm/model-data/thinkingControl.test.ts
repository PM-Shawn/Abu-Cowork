import { describe, expect, it } from 'vitest';
import { offeredThinkingEfforts, resolveThinkingControl, type ThinkingControl } from './thinkingControl';
import type { ThinkingProtocol } from '../modelCapabilities';
import type { ThinkingFormat } from './families';

const control = (
  bareId: string,
  protocol: ThinkingProtocol,
  extra: { format?: ThinkingFormat; adapter?: 'claude' | 'openai-compatible' | 'ollama'; withTools?: boolean; stripped?: boolean } = {},
): ThinkingControl => resolveThinkingControl({
  bareId,
  protocol,
  format: extra.format ?? 'openai',
  adapter: extra.adapter,
  reasoningEffortWithTools: extra.withTools ?? true,
  reasoningStripped: extra.stripped ?? false,
});
const offered = (...args: Parameters<typeof control>) => offeredThinkingEfforts(control(...args));

describe('thinking control: what a pick can do per model and wire', () => {
  describe('Claude (Anthropic wire)', () => {
    it.each([
      ['claude-fable-5', ['low', 'high', 'max']],
      ['claude-fable-5-2', ['low', 'high', 'max']],
      ['claude-mythos-5', ['low', 'high', 'max']],
      ['claude-opus-5-5', ['low', 'high', 'max']],
      ['claude-opus-5.5', ['low', 'high', 'max']],
      ['claude-opus-5', ['off', 'low', 'high', 'max']],
      ['claude-opus-5-20261001', ['off', 'low', 'high', 'max']],
      ['claude-sonnet-5', ['off', 'low', 'high', 'max']],
      ['claude-sonnet-5-5', ['off', 'low', 'high', 'max']],
      ['claude-haiku-5-5', ['off', 'low', 'high', 'max']],
      ['claude-opus-4-8', ['off', 'low', 'high', 'max']],
      ['claude-opus-4-6', ['off', 'low', 'high', 'max']],
      ['claude-sonnet-4-5', ['off', 'low', 'high', 'max']],
    ])('%s offers %j', (id, levels) => {
      expect(offered(id, 'anthropic', { adapter: 'claude' })).toEqual(levels);
    });

    it('says how each model is steered and what turns it off', () => {
      expect(control('claude-fable-5', 'anthropic')).toEqual({ kind: 'anthropic-adaptive', off: null });
      expect(control('claude-opus-5', 'anthropic')).toEqual({ kind: 'anthropic-adaptive', off: 'disabled' });
      expect(control('claude-opus-5-5', 'anthropic')).toEqual({ kind: 'anthropic-adaptive', off: null });
      expect(control('claude-sonnet-5-5', 'anthropic')).toEqual({ kind: 'anthropic-adaptive', off: 'between_tools' });
      expect(control('claude-opus-4-7', 'anthropic')).toEqual({ kind: 'anthropic-adaptive', off: 'omit' });
      expect(control('claude-sonnet-4-5', 'anthropic')).toEqual({ kind: 'anthropic-budget' });
    });

    it('a Claude model that does not think carries nothing', () => {
      expect(control('claude-3-haiku-20240307', false)).toEqual({ kind: 'none' });
    });

    it('is not offered through an OpenAI-compatible provider or a gateway dialect: the adapter writes none of it', () => {
      expect(offered('claude-opus-5', 'anthropic', { adapter: 'openai-compatible' })).toEqual([]);
      expect(offered('claude-opus-5', 'anthropic', { format: 'openrouter' })).toEqual([]);
    });

    it('is not offered once the thinking field is stripped', () => {
      expect(offered('claude-opus-5', 'anthropic', { stripped: true })).toEqual([]);
    });
  });

  describe('OpenAI reasoning_effort', () => {
    it.each([
      ['gpt-5.1', ['off', 'low', 'high']],
      ['gpt-5.2', ['off', 'low', 'high', 'max']],
      ['gpt-5.5-mini', ['off', 'low', 'high', 'max']],
      ['gpt-5', ['low', 'high']],
      ['gpt-5-mini', ['low', 'high']],
      ['o3', ['low', 'high']],
    ])('%s offers %j', (id, levels) => {
      expect(offered(id, 'openai-reasoning', { adapter: 'openai-compatible' })).toEqual(levels);
    });

    it('offers nothing where the profile drops reasoning_effort next to tools (gpt-5.5 agent turns)', () => {
      expect(offered('gpt-5.5', 'openai-reasoning', { withTools: false })).toEqual([]);
    });

    it('is not offered through the Anthropic adapter', () => {
      expect(offered('gpt-5.1', 'openai-reasoning', { adapter: 'claude' })).toEqual([]);
    });
  });

  describe('switch formats', () => {
    it('DeepSeek has levels as well as the switch', () => {
      expect(offered('deepseek-flash', 'uncontrollable', { format: 'deepseek' })).toEqual(['off', 'low', 'high', 'max']);
    });
    it.each(['qwen', 'zai', 'qwen-chat-template', 'kimi'] as const)('%s is a plain switch: off and one on', (format) => {
      expect(offered('some-model', 'uncontrollable', { format })).toEqual(['off', 'high']);
    });
    it('Ollama takes `think: false` and nothing else', () => {
      expect(offered('qwen3', 'uncontrollable', { adapter: 'ollama' })).toEqual(['off', 'high']);
      expect(offered('llama3', false, { adapter: 'ollama' })).toEqual([]);
    });
    it('a model that does not reason carries nothing, and an unknown reasoning model on the plain format has no knob', () => {
      expect(offered('gpt-4o', false, { format: 'deepseek' })).toEqual([]);
      expect(offered('my-reasoner', 'uncontrollable')).toEqual([]);
    });
  });
});
