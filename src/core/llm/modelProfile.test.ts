import { describe, it, expect } from 'vitest';
import { resolveModelProfile, documentedDefaultThinkingEffort } from './modelProfile';
import type { ProviderInstance } from '@/types/provider';

function provider(partial: Partial<ProviderInstance>): ProviderInstance {
  return {
    id: 'p1',
    source: 'custom',
    name: 'Custom',
    enabled: true,
    apiFormat: 'openai',
    baseUrl: 'https://gateway.example.com/v1',
    models: [],
    ...partial,
  } as ProviderInstance;
}

describe('resolveModelProfile', () => {
  describe('family', () => {
    it.each([
      ['claude-opus-5-5', 'claude'],
      ['anthropic/claude-sonnet-5-5', 'claude'],
      ['gpt-5.5', 'gpt'],
      ['o3-mini', 'gpt'],
      ['codex-mini-latest', 'gpt'],
      ['deepseek-v4-flash', 'deepseek'],
      ['moonshotai/kimi-k2.6', 'kimi'],
      ['qwen3-max', 'qwen'],
      ['glm-5', 'glm'],
      ['google/gemini-3-pro', 'gemini'],
      ['llama3.3:70b', 'other'],
      ['my-private-model', 'other'],
    ])('%s → %s', (id, family) => {
      expect(resolveModelProfile({ modelId: id }).family).toBe(family);
    });
  });

  describe('wire defaults per family', () => {
    it('gpt takes max_completion_tokens, gpt-4o keeps max_tokens', () => {
      expect(resolveModelProfile({ modelId: 'gpt-5.5' }).wire.maxTokensField).toBe('max_completion_tokens');
      expect(resolveModelProfile({ modelId: 'gpt-4.1' }).wire.maxTokensField).toBe('max_completion_tokens');
      expect(resolveModelProfile({ modelId: 'gpt-4o' }).wire.maxTokensField).toBe('max_tokens');
    });

    it('gpt-5.5 drops reasoning_effort next to tools, other gpt ids keep it', () => {
      expect(resolveModelProfile({ modelId: 'gpt-5.5' }).wire.reasoningEffortWithTools).toBe(false);
      expect(resolveModelProfile({ modelId: 'gpt-5.6-sol' }).wire.reasoningEffortWithTools).toBe(true);
    });

    it('deepseek: thinking format deepseek, schema unions flattened, reasoning_content always replayed', () => {
      const p = resolveModelProfile({ modelId: 'deepseek-reasoner' });
      expect(p.wire.thinkingFormat).toBe('deepseek');
      expect(p.wire.toolSchemaDialect).toBe('deepseek');
      expect(p.wire.reasoningReplay).toBe('reasoning_content-or-empty');
    });

    it('kimi-k2.5 / k2.6 take the kimi thinking shape with temperature 1; a hyphen before the segment does not match', () => {
      expect(resolveModelProfile({ modelId: 'moonshotai/kimi-k2.5' }).wire.thinkingFormat).toBe('kimi');
      expect(resolveModelProfile({ modelId: 'kimi-k2.6' }).wire.temperatureWhenThinking).toBe(1);
      expect(resolveModelProfile({ modelId: 'x-kimi-k2.5' }).wire.thinkingFormat).toBe('openai');
    });

    it('gemini cleans the schema and needs the thought-signature placeholder', () => {
      const p = resolveModelProfile({ modelId: 'gemini-3-pro' });
      expect(p.wire.toolSchemaDialect).toBe('gemini');
      expect(p.wire.thoughtSignaturePlaceholder).toBe(true);
    });

    it('claude sends no temperature on the OpenAI-compatible path and replays no reasoning_content', () => {
      const p = resolveModelProfile({ modelId: 'claude-sonnet-5-5' });
      expect(p.wire.sendTemperature).toBe(false);
      expect(p.wire.reasoningReplay).toBe('none');
    });
  });

  describe('host', () => {
    it('a gateway host picks the thinking format over the model id', () => {
      expect(resolveModelProfile({ modelId: 'kimi-k2.6', requestHost: 'openrouter.ai' }).wire.thinkingFormat).toBe('openrouter');
      expect(resolveModelProfile({ modelId: 'glm-5', requestHost: 'api.together.ai' }).wire.thinkingFormat).toBe('together');
    });

    it('prompt_cache_key only on the official OpenAI host', () => {
      expect(resolveModelProfile({ modelId: 'gpt-5.5', requestHost: 'api.openai.com' }).wire.promptCacheKey).toBe(true);
      expect(resolveModelProfile({ modelId: 'gpt-5.5', requestHost: 'proxy.corp' }).wire.promptCacheKey).toBe(false);
      expect(resolveModelProfile({ modelId: 'gpt-5.5', baseUrl: 'https://api.openai.com/v1' }).wire.promptCacheKey).toBe(true);
    });

    it('a host that is not a URL yields the family defaults', () => {
      expect(resolveModelProfile({ modelId: 'deepseek-chat', baseUrl: 'not a url' }).wire.thinkingFormat).toBe('deepseek');
    });
  });

  describe('declarations', () => {
    it('provider-level protocol fields override the family', () => {
      const p = resolveModelProfile({
        modelId: 'deepseek-chat',
        provider: provider({
          declaredCapabilities: {
            thinkingFormat: 'qwen-chat-template',
            maxTokensField: 'max_completion_tokens',
            requiresToolResultName: true,
            reasoningReplay: 'none',
            toolSchemaDialect: 'gemini',
            sendTemperature: false,
            promptCacheKey: true,
            supportedEfforts: ['low'],
            supportsReasoning: false,
          },
        }),
      });
      expect(p.wire).toMatchObject({
        thinkingFormat: 'qwen-chat-template',
        maxTokensField: 'max_completion_tokens',
        toolResultName: true,
        reasoningReplay: 'none',
        toolSchemaDialect: 'gemini',
        sendTemperature: false,
        promptCacheKey: true,
        supportedEfforts: ['low'],
        stripReasoningParams: true,
      });
    });

    describe('thinkingEffort', () => {
      it('is unset (null) by default', () => {
        expect(resolveModelProfile({ modelId: 'deepseek-flash' }).wire.thinkingEffort).toBeNull();
        expect(resolveModelProfile({ modelId: 'deepseek-flash', declared: { supportsReasoning: true } }).wire.thinkingEffort).toBeNull();
      });

      it('comes from the model\'s declaration, through the provider', () => {
        const p = resolveModelProfile({
          modelId: 'deepseek-flash',
          provider: provider({ apiFormat: 'openai-compatible', models: [{ id: 'deepseek-flash', label: 'f', declaredCapabilities: { thinkingEffort: 'max' } }] }),
        });
        expect(p.wire.thinkingEffort).toBe('max');
      });

      it('ignores a level the model does not carry (a stale pick is as good as unset)', () => {
        const pick = (modelId: string, thinkingEffort: 'off' | 'max', extra: Parameters<typeof resolveModelProfile>[0] = { modelId }) =>
          resolveModelProfile({ ...extra, modelId, declared: { thinkingEffort }, adapter: 'claude' }).wire.thinkingEffort;
        expect(pick('claude-fable-5', 'off')).toBeNull();
        expect(pick('claude-fable-5', 'max')).toBe('max');
        expect(resolveModelProfile({ modelId: 'gpt-5.5', declared: { thinkingEffort: 'max' }, adapter: 'openai-compatible' }).wire.thinkingEffort).toBeNull();
      });

      it('ignores a stored value that is not one of the four efforts', () => {
        const p = resolveModelProfile({ modelId: 'deepseek-flash', declared: { thinkingEffort: 'ultra' as never } });
        expect(p.wire.thinkingEffort).toBeNull();
      });

      it('off drops the reasoning replay where the switch is really sent', () => {
        const base = resolveModelProfile({ modelId: 'deepseek-flash', requestHost: 'api.deepseek.com' });
        expect(base.wire.reasoningReplay).toBe('reasoning_content-or-empty');
        const off = resolveModelProfile({
          modelId: 'deepseek-flash', requestHost: 'api.deepseek.com', declared: { thinkingEffort: 'off' },
        });
        expect(off.wire.reasoningReplay).toBe('none');
        const on = resolveModelProfile({
          modelId: 'deepseek-flash', requestHost: 'api.deepseek.com', declared: { thinkingEffort: 'max' },
        });
        expect(on.wire.reasoningReplay).toBe('reasoning_content-or-empty');
      });

      it('off keeps the replay when the switch is withheld: DeepSeek then thinks and wants its reasoning back', () => {
        const rejected = resolveModelProfile({
          modelId: 'deepseek-flash', requestHost: 'api.deepseek.com', declared: { thinkingEffort: 'off' }, overrides: ['thinking'],
        });
        expect(rejected.wire.reasoningReplay).toBe('reasoning_content-or-empty');
        const noReasoning = resolveModelProfile({
          modelId: 'deepseek-flash', requestHost: 'api.deepseek.com', declared: { thinkingEffort: 'off', supportsReasoning: false },
        });
        expect(noReasoning.wire.reasoningReplay).toBe('reasoning_content-or-empty');
      });

      it('off on a format with no switch leaves the replay alone', () => {
        const p = resolveModelProfile({ modelId: 'gpt-5.5', requestHost: 'api.openai.com', declared: { thinkingEffort: 'off' } });
        expect(p.wire.reasoningReplay).toBe('reasoning_content-or-empty');
      });
    });

    it('a declared thinking format beats the gateway host', () => {
      const p = resolveModelProfile({
        modelId: 'glm-5',
        requestHost: 'openrouter.ai',
        declared: { thinkingFormat: 'zai' },
      });
      expect(p.wire.thinkingFormat).toBe('zai');
    });

    it('model-level parallelToolCalls overrides the provider and the family', () => {
      const p = resolveModelProfile({
        modelId: 'my-model',
        provider: provider({
          declaredCapabilities: { parallelToolCalls: true },
          models: [{ id: 'my-model', label: 'My', declaredCapabilities: { parallelToolCalls: false } }],
        }),
      });
      expect(p.capabilities.parallelToolCalls).toBe(false);
    });

    it('declared images and reasoning reach capabilities; declared tools reach agent', () => {
      const p = resolveModelProfile({
        modelId: 'my-model',
        providerSource: 'custom',
        declared: { supportsImages: true, supportsReasoning: true, supportsTools: false },
      });
      expect(p.capabilities.vision).toBe(true);
      expect(p.capabilities.thinking).toBe('openai-reasoning');
      expect(p.agent.toolCalling).toBe('none');
    });
  });

  describe('session rejection overrides', () => {
    it('each class switches its field off, over the declaration and the family', () => {
      const p = resolveModelProfile({
        modelId: 'my-model',
        providerSource: 'custom',
        declared: { supportsImages: true, supportsReasoning: true, parallelToolCalls: false, maxTokensField: 'max_tokens' },
        overrides: ['thinking', 'reasoning_effort', 'max_tokens_field', 'parallel_tool_calls', 'image_block', 'tool_schema_keyword'],
      });
      expect(p.wire.stripReasoningParams).toBe(true);
      expect(p.wire.sendReasoningEffort).toBe(false);
      expect(p.wire.maxTokensField).toBe('max_completion_tokens');
      expect(p.wire.sendParallelToolCalls).toBe(false);
      expect(p.capabilities.vision).toBe(false);
      expect(p.wire.toolSchemaDialect).toBe('gemini');
    });

    it('max_tokens_field swaps whichever name the profile had', () => {
      expect(resolveModelProfile({ modelId: 'gpt-5.5', overrides: ['max_tokens_field'] }).wire.maxTokensField).toBe('max_tokens');
      expect(resolveModelProfile({ modelId: 'gpt-4o', overrides: ['max_tokens_field'] }).wire.maxTokensField).toBe('max_completion_tokens');
    });

    it('tool_schema_keyword leaves a dialect that already cleans the schema alone', () => {
      expect(resolveModelProfile({ modelId: 'deepseek-chat', overrides: ['tool_schema_keyword'] }).wire.toolSchemaDialect).toBe('deepseek');
      expect(resolveModelProfile({ modelId: 'google/gemini-3-pro', overrides: ['tool_schema_keyword'] }).wire.toolSchemaDialect).toBe('gemini');
    });

    it('without overrides the send switches are on', () => {
      const p = resolveModelProfile({ modelId: 'my-model' });
      expect(p.wire.sendReasoningEffort).toBe(true);
      expect(p.wire.sendParallelToolCalls).toBe(true);
      expect(p.wire.stripReasoningParams).toBe(false);
    });
  });

  describe('unknown models', () => {
    it('get the generic defaults and never throw', () => {
      const p = resolveModelProfile({ modelId: 'my-private-model', providerSource: 'custom' });
      expect(p.family).toBe('other');
      expect(p.harness.editToolStyle).toBe('replace');
      expect(p.harness.promptVariant).toBe('other');
      expect(p.harness.guards.toolArgumentRepair).toBe(true);
      expect(p.agent.toolCalling).toBe('text-recovery');
      expect(p.capabilities.parallelToolCalls).toBe(true);
    });
  });

  describe('harness defaults', () => {
    it('gpt-5 and codex take the patch tool, gpt-4 and every other family keep replace', () => {
      expect(resolveModelProfile({ modelId: 'gpt-5.6-sol' }).harness.editToolStyle).toBe('patch');
      expect(resolveModelProfile({ modelId: 'codex-mini-latest' }).harness.editToolStyle).toBe('patch');
      expect(resolveModelProfile({ modelId: 'gpt-4.1' }).harness.editToolStyle).toBe('replace');
      expect(resolveModelProfile({ modelId: 'gpt-4o' }).harness.editToolStyle).toBe('replace');
      expect(resolveModelProfile({ modelId: 'claude-opus-5-5' }).harness.editToolStyle).toBe('replace');
      expect(resolveModelProfile({ modelId: 'deepseek-v4-flash' }).harness.editToolStyle).toBe('replace');
    });

    it('the text-only end-turn nudge is off everywhere until an evaluation turns it on per model', () => {
      for (const id of ['claude-opus-5-5', 'gpt-5.5', 'deepseek-v4-flash', 'kimi-k2.6', 'qwen3-max', 'glm-5', 'x']) {
        expect(resolveModelProfile({ modelId: id }).harness.guards.textOnlyEndTurnNudge).toBe(false);
      }
    });
  });

  it('is plain data: survives a JSON round trip', () => {
    const p = resolveModelProfile({ modelId: 'kimi-k2.6', requestHost: 'api.moonshot.cn' });
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});

describe('documentedDefaultThinkingEffort', () => {
  it('is high for DeepSeek thinking models, whose API thinks at high effort by default', () => {
    expect(documentedDefaultThinkingEffort('deepseek-flash', 'https://api.deepseek.com')).toBe('high');
    expect(documentedDefaultThinkingEffort('deepseek-v4-pro', 'https://api.deepseek.com')).toBe('high');
  });

  it('says nothing for families whose default is not a documented effort', () => {
    expect(documentedDefaultThinkingEffort('gpt-5.5', 'https://api.openai.com/v1')).toBeUndefined();
    expect(documentedDefaultThinkingEffort('claude-sonnet-4-5', 'https://api.anthropic.com')).toBeUndefined();
    expect(documentedDefaultThinkingEffort('qwen3-max', 'https://dashscope.aliyuncs.com/compatible-mode/v1')).toBeUndefined();
  });
});
