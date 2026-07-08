import { describe, it, expect } from 'vitest';
import { applyModelRequestProcessors } from './modelRequestProcessors';

const run = (body: Record<string, unknown>, ctx: Parameters<typeof applyModelRequestProcessors>[1]) => {
  applyModelRequestProcessors(body, ctx);
  return body;
};

describe('modelRequestProcessors', () => {
  it('responses-native-fallback: gpt-5.5 + tools on openai host drops reasoning_effort', () => {
    const b = run({ model: 'gpt-5.5', reasoning_effort: 'medium', tools: [{}] },
      { modelId: 'gpt-5.5', requestHost: 'api.openai.com', hasTools: true, caps: undefined });
    expect(b.reasoning_effort).toBeUndefined();
    expect(Array.isArray(b.tools)).toBe(true);
  });
  it('responses-native-fallback: gpt-5.5 + tools on NON-openai host also drops reasoning_effort', () => {
    // Regression: the original guard required isDirectOpenAIHost, so proxies/gateways
    // would still send reasoning_effort and get a 400 from OpenAI's API.
    const b = run({ model: 'gpt-5.5', reasoning_effort: 'high', tools: [{}] },
      { modelId: 'gpt-5.5', requestHost: 'proxy.corp', hasTools: true, caps: undefined });
    expect(b.reasoning_effort).toBeUndefined();
    expect(Array.isArray(b.tools)).toBe(true);
  });
  it('reasoning-support: declared supportsReasoning=false strips reasoning_effort', () => {
    const b = run({ reasoning_effort: 'high' },
      { modelId: 'x', requestHost: 'h', hasTools: false, caps: { supportsReasoning: false } });
    expect(b.reasoning_effort).toBeUndefined();
  });
  it('tools-gate: declared supportsTools=false removes tools + tool_choice', () => {
    const b = run({ tools: [{}], tool_choice: 'auto' },
      { modelId: 'x', requestHost: 'h', hasTools: true, caps: { supportsTools: false } });
    expect(b.tools).toBeUndefined();
    expect(b.tool_choice).toBeUndefined();
  });
  it('effort-clamp: reasoning_effort outside supportedEfforts clamps to nearest', () => {
    const b = run({ reasoning_effort: 'high' },
      { modelId: 'x', requestHost: 'h', hasTools: false, caps: { supportedEfforts: ['low', 'medium'] } });
    expect(b.reasoning_effort).toBe('medium');
  });
  it('no caps + non-openai host: leaves body untouched', () => {
    const b = run({ reasoning_effort: 'medium', tools: [{}] },
      { modelId: 'llama3', requestHost: 'localhost', hasTools: true, caps: undefined });
    expect(b.reasoning_effort).toBe('medium');
    expect(Array.isArray(b.tools)).toBe(true);
  });

  // ── thinkingFormatTranslator ──────────────────────────────────────────────

  describe('thinkingFormatTranslator', () => {
    it('deepseek host + reasoning_effort: sets thinking.type=enabled, keeps reasoning_effort', () => {
      const b = run(
        { reasoning_effort: 'high' },
        { modelId: 'deepseek-reasoner', requestHost: 'api.deepseek.com', hasTools: false },
      );
      expect(b.thinking).toEqual({ type: 'enabled' });
      expect(b.reasoning_effort).toBe('high');
    });

    it('together host + reasoning_effort: sets reasoning.enabled=true, keeps reasoning_effort', () => {
      const b = run(
        { reasoning_effort: 'high' },
        { modelId: 'some-model', requestHost: 'api.together.ai', hasTools: false },
      );
      expect((b.reasoning as Record<string, unknown>).enabled).toBe(true);
      expect(b.reasoning_effort).toBe('high');
    });

    it('zai host + reasoning_effort: sets enable_thinking=true, deletes reasoning_effort', () => {
      const b = run(
        { reasoning_effort: 'high' },
        { modelId: 'glm-z1', requestHost: 'api.z.ai', hasTools: false },
      );
      expect(b.enable_thinking).toBe(true);
      expect(b.reasoning_effort).toBeUndefined();
    });

    it('qwen host + reasoning_effort: sets enable_thinking=true, deletes reasoning_effort', () => {
      const b = run(
        { reasoning_effort: 'medium' },
        { modelId: 'qwen3-235b', requestHost: 'dashscope.aliyuncs.com', hasTools: false },
      );
      expect(b.enable_thinking).toBe(true);
      expect(b.reasoning_effort).toBeUndefined();
    });

    it('caps.thinkingFormat=qwen-chat-template (override): sets chat_template_kwargs.enable_thinking=true, deletes reasoning_effort', () => {
      const b = run(
        { reasoning_effort: 'high' },
        {
          modelId: 'qwen3-custom',
          requestHost: 'localhost',
          hasTools: false,
          caps: { thinkingFormat: 'qwen-chat-template' },
        },
      );
      expect((b.chat_template_kwargs as Record<string, unknown>).enable_thinking).toBe(true);
      expect(b.reasoning_effort).toBeUndefined();
    });

    it('openrouter host + reasoning_effort: moves effort into reasoning obj, deletes reasoning_effort', () => {
      const b = run(
        { reasoning_effort: 'high' },
        { modelId: 'anthropic/claude-3.7-sonnet', requestHost: 'openrouter.ai', hasTools: false },
      );
      expect((b.reasoning as Record<string, unknown>).effort).toBe('high');
      expect(b.reasoning_effort).toBeUndefined();
    });

    it('openrouter host + existing reasoning obj: merges effort without overwriting other fields', () => {
      const b = run(
        { reasoning_effort: 'low', reasoning: { max_tokens: 1000 } },
        { modelId: 'some/model', requestHost: 'openrouter.ai', hasTools: false },
      );
      expect((b.reasoning as Record<string, unknown>).effort).toBe('low');
      expect((b.reasoning as Record<string, unknown>).max_tokens).toBe(1000);
      expect(b.reasoning_effort).toBeUndefined();
    });

    it('openrouter host + existing reasoning.effort: existing effort wins (not overwritten)', () => {
      const b = run(
        { reasoning_effort: 'high', reasoning: { effort: 'low' } },
        { modelId: 'some/model', requestHost: 'openrouter.ai', hasTools: false },
      );
      // existing.effort ('low') takes precedence per spec
      expect((b.reasoning as Record<string, unknown>).effort).toBe('low');
      expect(b.reasoning_effort).toBeUndefined();
    });

    it('openai/generic host + reasoning_effort: UNCHANGED (no-op)', () => {
      const b = run(
        { reasoning_effort: 'high' },
        { modelId: 'gpt-4o', requestHost: 'api.openai.com', hasTools: false },
      );
      expect(b.reasoning_effort).toBe('high');
      expect(b.thinking).toBeUndefined();
      expect(b.enable_thinking).toBeUndefined();
      expect(b.reasoning).toBeUndefined();
    });

    it('thinking OFF (no reasoning_effort, no thinking_budget) on deepseek host: UNCHANGED (no thinking field injected)', () => {
      // Safety: non-reasoning deepseek models (e.g. deepseek-chat) must not get
      // a spurious `thinking` field that would cause a 400.
      const b = run(
        { model: 'deepseek-chat', messages: [] },
        { modelId: 'deepseek-chat', requestHost: 'api.deepseek.com', hasTools: false },
      );
      expect(b.thinking).toBeUndefined();
      expect(b.enable_thinking).toBeUndefined();
      expect(b.reasoning).toBeUndefined();
    });

    it('REGRESSION: gpt-5.5 + tools — responsesNativeFallback still deletes reasoning_effort (new rule does not interfere)', () => {
      // The new thinkingFormatTranslator must not re-add reasoning or thinking
      // after responsesNativeFallback has stripped reasoning_effort.
      // (After fallback runs at priority 10, reasoning_effort is gone; the
      //  translator at priority 40 sees thinkingEnabled=false → matches()=false.)
      const b = run(
        { model: 'gpt-5.5', reasoning_effort: 'high', tools: [{}] },
        { modelId: 'gpt-5.5', requestHost: 'api.openai.com', hasTools: true },
      );
      expect(b.reasoning_effort).toBeUndefined();
      expect(b.thinking).toBeUndefined();
      expect(b.enable_thinking).toBeUndefined();
    });
  });

  // ── maxTokensField ────────────────────────────────────────────────────────

  describe('maxTokensField', () => {
    it('gpt-5 model: swaps max_tokens → max_completion_tokens', () => {
      const b = run(
        { max_tokens: 4096 },
        { modelId: 'gpt-5', requestHost: 'api.openai.com', hasTools: false },
      );
      expect(b.max_completion_tokens).toBe(4096);
      expect(b.max_tokens).toBeUndefined();
    });

    it('o3-mini model: swaps max_tokens → max_completion_tokens', () => {
      const b = run(
        { max_tokens: 2048 },
        { modelId: 'o3-mini', requestHost: 'api.openai.com', hasTools: false },
      );
      expect(b.max_completion_tokens).toBe(2048);
      expect(b.max_tokens).toBeUndefined();
    });

    it('gpt-4.1 model: swaps max_tokens → max_completion_tokens', () => {
      const b = run(
        { max_tokens: 8192 },
        { modelId: 'gpt-4.1', requestHost: 'api.openai.com', hasTools: false },
      );
      expect(b.max_completion_tokens).toBe(8192);
      expect(b.max_tokens).toBeUndefined();
    });

    it('non-openai model with caps.maxTokensField=max_completion_tokens: swapped', () => {
      const b = run(
        { max_tokens: 1024 },
        {
          modelId: 'some-custom-model',
          requestHost: 'custom.provider.com',
          hasTools: false,
          caps: { maxTokensField: 'max_completion_tokens' },
        },
      );
      expect(b.max_completion_tokens).toBe(1024);
      expect(b.max_tokens).toBeUndefined();
    });

    it('caps.maxTokensField=max_tokens on gpt-5: NOT swapped (explicit keep wins)', () => {
      const b = run(
        { max_tokens: 4096 },
        {
          modelId: 'gpt-5',
          requestHost: 'api.openai.com',
          hasTools: false,
          caps: { maxTokensField: 'max_tokens' },
        },
      );
      expect(b.max_tokens).toBe(4096);
      expect(b.max_completion_tokens).toBeUndefined();
    });

    it('non-openai model with no caps (e.g. deepseek-chat): NOT swapped', () => {
      const b = run(
        { max_tokens: 2048 },
        { modelId: 'deepseek-chat', requestHost: 'api.deepseek.com', hasTools: false },
      );
      expect(b.max_tokens).toBe(2048);
      expect(b.max_completion_tokens).toBeUndefined();
    });

    it('body already has max_completion_tokens: untouched (no double-write)', () => {
      const b = run(
        { max_tokens: 4096, max_completion_tokens: 1024 },
        { modelId: 'gpt-5', requestHost: 'api.openai.com', hasTools: false },
      );
      // max_completion_tokens was already set — processor skips
      expect(b.max_completion_tokens).toBe(1024);
      expect(b.max_tokens).toBe(4096);
    });
  });

  // ── toolResultName ────────────────────────────────────────────────────────

  describe('toolResultName', () => {
    it('caps.requiresToolResultName=true: injects name from tool_call map', () => {
      const messages = [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'file contents',
          // no name field
        },
      ];
      const b = run(
        { messages },
        { modelId: 'deepseek-chat', requestHost: 'api.deepseek.com', hasTools: true, caps: { requiresToolResultName: true } },
      );
      const toolMsg = (b.messages as Record<string, unknown>[])[1];
      expect(toolMsg.name).toBe('read_file');
    });

    it('caps.requiresToolResultName=true: existing name is left as-is (not overwritten)', () => {
      const messages = [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_2', type: 'function', function: { name: 'write_file', arguments: '{}' } },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_2',
          content: 'ok',
          name: 'existing_name', // already present
        },
      ];
      const b = run(
        { messages },
        { modelId: 'deepseek-chat', requestHost: 'api.deepseek.com', hasTools: true, caps: { requiresToolResultName: true } },
      );
      const toolMsg = (b.messages as Record<string, unknown>[])[1];
      expect(toolMsg.name).toBe('existing_name');
    });

    it('caps.requiresToolResultName not set: messages untouched', () => {
      const messages = [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_3', type: 'function', function: { name: 'bash', arguments: '{}' } },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_3',
          content: 'output',
        },
      ];
      const b = run(
        { messages },
        { modelId: 'some-model', requestHost: 'api.example.com', hasTools: true, caps: undefined },
      );
      const toolMsg = (b.messages as Record<string, unknown>[])[1];
      expect(toolMsg.name).toBeUndefined();
    });

    it('malformed tool_calls array (missing/null entries): does not throw, no-op', () => {
      const messages = [
        {
          role: 'assistant',
          content: null,
          // Intentionally malformed: null, undefined, empty object, missing function.name
          tool_calls: [null, undefined, {}, { id: '', function: null }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_x',
          content: 'output',
        },
      ];
      const body: Record<string, unknown> = { messages };
      expect(() => {
        run(body, { modelId: 'deepseek-chat', requestHost: 'api.deepseek.com', hasTools: true, caps: { requiresToolResultName: true } });
      }).not.toThrow();
      // call_x is not in the map (all entries were malformed) → name stays undefined
      const toolMsg = (body.messages as Record<string, unknown>[])[1];
      expect(toolMsg.name).toBeUndefined();
    });

    it('no messages field (not an array): does not throw, no-op', () => {
      expect(() => {
        run(
          { messages: 'not-an-array' },
          { modelId: 'deepseek-chat', requestHost: 'api.deepseek.com', hasTools: true, caps: { requiresToolResultName: true } },
        );
      }).not.toThrow();
    });
  });

  // ── kimiThinkingMode ──────────────────────────────────────────────────────

  describe('kimiThinkingMode', () => {
    it('moonshotai/kimi-k2.5 + reasoning_effort: sets thinking={type:enabled}, temperature=1, deletes reasoning_effort', () => {
      const b = run(
        { reasoning_effort: 'high' },
        { modelId: 'moonshotai/kimi-k2.5', requestHost: 'api.moonshot.cn', hasTools: false },
      );
      expect(b.thinking).toEqual({ type: 'enabled' });
      expect(b.temperature).toBe(1);
      expect(b.reasoning_effort).toBeUndefined();
    });

    it('kimi-k2.6 variant: sets thinking={type:enabled}, temperature=1, deletes reasoning_effort', () => {
      const b = run(
        { reasoning_effort: 'medium', thinking_budget: 500 },
        { modelId: 'kimi-k2.6', requestHost: 'api.moonshot.cn', hasTools: false },
      );
      expect(b.thinking).toEqual({ type: 'enabled' });
      expect(b.temperature).toBe(1);
      expect(b.reasoning_effort).toBeUndefined();
    });

    it('x-kimi-k2.5 (hyphen before segment): NOT matched — body unchanged', () => {
      const b = run(
        { reasoning_effort: 'high' },
        { modelId: 'x-kimi-k2.5', requestHost: 'api.moonshot.cn', hasTools: false },
      );
      // kimiThinkingMode must NOT fire when kimi-k2.5 is preceded by a hyphen
      expect(b.thinking).toBeUndefined();
      // reasoning_effort survives (no other rule deletes it on this host)
      expect(b.reasoning_effort).toBe('high');
    });

    it('kimi without thinking (no reasoning_effort, no thinking_budget): NOT matched — body unchanged', () => {
      const b = run(
        { model: 'kimi-k2.5', messages: [] },
        { modelId: 'kimi-k2.5', requestHost: 'api.moonshot.cn', hasTools: false },
      );
      expect(b.thinking).toBeUndefined();
      expect(b.temperature).toBeUndefined();
    });

    it('non-kimi model: NOT matched', () => {
      const b = run(
        { reasoning_effort: 'high' },
        { modelId: 'deepseek-reasoner', requestHost: 'api.deepseek.com', hasTools: false },
      );
      expect(b.thinking).toEqual({ type: 'enabled' }); // deepseek rule fires, not kimi
      expect(b.temperature).toBeUndefined(); // kimi did NOT fire
    });
  });

  // ── geminiToolSchemaCleanup ───────────────────────────────────────────────

  describe('geminiToolSchemaCleanup', () => {
    it('gemini-2.5-pro with tools: removes $schema, exclusiveMinimum, exclusiveMaximum at every nesting level', () => {
      const tools = [
        {
          type: 'function',
          function: {
            name: 'search',
            description: 'search',
            parameters: {
              $schema: 'http://json-schema.org/draft-07/schema#',
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  exclusiveMinimum: 0,
                  exclusiveMaximum: 100,
                  minimum: 1, // must be KEPT
                },
                count: {
                  type: 'integer',
                  $schema: 'inner', // nested $schema must also be removed
                },
              },
              items: {
                $schema: 'item-schema',
                exclusiveMinimum: -1,
                type: 'string',
                minimum: 0, // must be KEPT
              },
            },
          },
        },
      ];
      const b = run(
        { tools },
        { modelId: 'gemini-2.5-pro', requestHost: 'generativelanguage.googleapis.com', hasTools: true },
      );
      const params = (b.tools as Record<string, unknown>[])[0];
      const fn = params.function as Record<string, unknown>;
      const parameters = fn.parameters as Record<string, unknown>;

      // Top-level $schema removed
      expect(parameters.$schema).toBeUndefined();

      // Nested property: exclusiveMinimum/Maximum removed, minimum kept
      const queryProp = (parameters.properties as Record<string, unknown>).query as Record<string, unknown>;
      expect(queryProp.exclusiveMinimum).toBeUndefined();
      expect(queryProp.exclusiveMaximum).toBeUndefined();
      expect(queryProp.minimum).toBe(1); // KEPT

      // Nested property: $schema removed
      const countProp = (parameters.properties as Record<string, unknown>).count as Record<string, unknown>;
      expect(countProp.$schema).toBeUndefined();

      // items: $schema and exclusiveMinimum removed, minimum kept
      const items = parameters.items as Record<string, unknown>;
      expect(items.$schema).toBeUndefined();
      expect(items.exclusiveMinimum).toBeUndefined();
      expect(items.minimum).toBe(0); // KEPT
    });

    it('gemini-3-pro: also matched and cleaned', () => {
      const tools = [
        {
          type: 'function',
          function: {
            name: 'fn',
            description: '',
            parameters: { $schema: 'x', type: 'object', minimum: 1 },
          },
        },
      ];
      const b = run(
        { tools },
        { modelId: 'gemini-3-pro', requestHost: 'openrouter.ai', hasTools: true },
      );
      const params = ((b.tools as Record<string, unknown>[])[0].function as Record<string, unknown>).parameters as Record<string, unknown>;
      expect(params.$schema).toBeUndefined();
      expect(params.minimum).toBe(1); // KEPT
    });

    it('non-gemini model: tools untouched', () => {
      const tools = [
        {
          type: 'function',
          function: {
            name: 'fn',
            description: '',
            parameters: { $schema: 'x', type: 'object' },
          },
        },
      ];
      const b = run(
        { tools },
        { modelId: 'gpt-4o', requestHost: 'api.openai.com', hasTools: true },
      );
      const params = ((b.tools as Record<string, unknown>[])[0].function as Record<string, unknown>).parameters as Record<string, unknown>;
      expect(params.$schema).toBe('x'); // untouched
    });

    it('gemini-2.5 model but no tools: not matched (no-op)', () => {
      const b = run(
        { model: 'gemini-2.5-flash', messages: [] },
        { modelId: 'gemini-2.5-flash', requestHost: 'generativelanguage.googleapis.com', hasTools: false },
      );
      expect(b.tools).toBeUndefined();
    });

    it('stripGeminiUnsupportedKeys: handles null/non-object nodes without throwing', () => {
      const tools = [
        {
          type: 'function',
          function: {
            name: 'fn',
            description: '',
            parameters: {
              $schema: 'x',
              type: 'object',
              properties: null, // null node — must not throw
              items: [1, 2, 3], // array of non-objects — must not throw
            },
          },
        },
      ];
      expect(() => {
        run(
          { tools },
          { modelId: 'gemini-2.5-flash', requestHost: 'generativelanguage.googleapis.com', hasTools: true },
        );
      }).not.toThrow();
    });
  });

  // ── geminiThoughtSignature ────────────────────────────────────────────────

  describe('geminiThoughtSignature', () => {
    it('gemini-3-pro assistant msg with tool_calls and no extra_content: placeholder injected', () => {
      const messages = [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
          ],
        },
      ];
      const b = run(
        { messages },
        { modelId: 'gemini-3-pro', requestHost: 'generativelanguage.googleapis.com', hasTools: true },
      );
      const msg = (b.messages as Record<string, unknown>[])[0];
      const toolCalls = msg.tool_calls as Record<string, unknown>[];
      const extraContent = toolCalls[0].extra_content as Record<string, unknown>;
      const google = extraContent.google as Record<string, unknown>;
      expect(google.thought_signature).toBe('skip_thought_signature_validator');
    });

    it('gemini-2.5-pro: uses msg.extra_fields.google.thought_signature if present', () => {
      const messages = [
        {
          role: 'assistant',
          content: null,
          extra_fields: { google: { thought_signature: 'REAL_SIG' } },
          tool_calls: [
            { id: 'call_2', type: 'function', function: { name: 'fn', arguments: '{}' } },
          ],
        },
      ];
      const b = run(
        { messages },
        { modelId: 'gemini-2.5-pro', requestHost: 'openrouter.ai', hasTools: true },
      );
      const msg = (b.messages as Record<string, unknown>[])[0];
      const toolCalls = msg.tool_calls as Record<string, unknown>[];
      const extraContent = toolCalls[0].extra_content as Record<string, unknown>;
      const google = extraContent.google as Record<string, unknown>;
      expect(google.thought_signature).toBe('REAL_SIG');
    });

    it('extra_content.google.thought_signature already set: left as-is (not overwritten)', () => {
      const messages = [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_3',
              type: 'function',
              function: { name: 'fn', arguments: '{}' },
              extra_content: { google: { thought_signature: 'ALREADY_SET' } },
            },
          ],
        },
      ];
      const b = run(
        { messages },
        { modelId: 'gemini-3-pro', requestHost: 'generativelanguage.googleapis.com', hasTools: true },
      );
      const msg = (b.messages as Record<string, unknown>[])[0];
      const toolCalls = msg.tool_calls as Record<string, unknown>[];
      const extraContent = toolCalls[0].extra_content as Record<string, unknown>;
      const google = extraContent.google as Record<string, unknown>;
      expect(google.thought_signature).toBe('ALREADY_SET');
    });

    it('non-gemini model: messages untouched', () => {
      const messages = [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_4', type: 'function', function: { name: 'fn', arguments: '{}' } },
          ],
        },
      ];
      const b = run(
        { messages },
        { modelId: 'gpt-4o', requestHost: 'api.openai.com', hasTools: true },
      );
      const msg = (b.messages as Record<string, unknown>[])[0];
      const toolCalls = msg.tool_calls as Record<string, unknown>[];
      expect((toolCalls[0] as Record<string, unknown>).extra_content).toBeUndefined();
    });

    it('assistant msg with empty tool_calls array: no-op, does not throw', () => {
      const messages = [
        {
          role: 'assistant',
          content: 'hello',
          tool_calls: [],
        },
      ];
      expect(() => {
        run(
          { messages },
          { modelId: 'gemini-2.5-flash', requestHost: 'generativelanguage.googleapis.com', hasTools: false },
        );
      }).not.toThrow();
      const msg = (messages as Record<string, unknown>[])[0];
      const toolCalls = msg.tool_calls as unknown[];
      expect(toolCalls.length).toBe(0);
    });

    it('user and tool role messages: not touched', () => {
      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'tool', tool_call_id: 'c1', content: 'result' },
      ];
      expect(() => {
        run(
          { messages },
          { modelId: 'gemini-3-flash', requestHost: 'generativelanguage.googleapis.com', hasTools: true },
        );
      }).not.toThrow();
      expect((messages[0] as Record<string, unknown>).extra_content).toBeUndefined();
      expect((messages[1] as Record<string, unknown>).extra_content).toBeUndefined();
    });
  });
});
