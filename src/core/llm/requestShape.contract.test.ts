/**
 * Request-shape recordings, one per model family.
 *
 * Each case drives a real adapter (`ClaudeAdapter` / `OpenAICompatibleAdapter`)
 * against a captured `fetch` and pins the outgoing request body to a JSON file
 * under `__contractFixtures__/requestShapes/`. The recordings are the acceptance
 * check for every change to the model profile, the request processors and the
 * two serializers: a shape change shows up as a fixture diff that has to be
 * reviewed, never as a silent 400 from a provider.
 *
 * Only the network boundary is replaced (TESTING.md): the serializers, the
 * processors and the Anthropic SDK run for real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, ToolDefinition } from '../../types';
import type { ProviderInstance } from '../../types/provider';
import type { ChatOptions } from './adapter';

// The global setup mocks the Anthropic SDK with inert stubs; this file needs the
// real client so the body it builds (cache_control, thinking, system blocks) is
// what reaches the wire.
vi.unmock('@anthropic-ai/sdk');

const mockFetch = vi.fn();
vi.mock('./tauriFetch', () => ({
  getTauriFetch: () => Promise.resolve(mockFetch),
}));

import { OpenAICompatibleAdapter } from './openai-compatible';
import { ClaudeAdapter } from './claude';
import { recordCapabilityRejection, resetRejectionMemory } from './rejectionMemory';
import { computeReasoningParams, resolveCapabilities } from './modelCapabilities';
import { resolveModelDeclared } from './resolveModelDeclared';

const FIXED_TIMESTAMP = 1_700_000_000_000;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function openAiStream(): Response {
  const chunks = [
    { id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
    { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function anthropicStream(): Response {
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  const body = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path to file' } },
    required: ['path'],
  },
  execute: async () => 'ok',
};

/** A schema carrying the keys Gemini's endpoint rejects. */
const strictSchemaTool: ToolDefinition = {
  name: 'set_level',
  description: 'Set a level',
  inputSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { level: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 10 } },
    required: ['level'],
  } as ToolDefinition['inputSchema'],
  execute: async () => 'ok',
};

function user(id: string, content: Message['content']): Message {
  return { id, role: 'user', content, timestamp: FIXED_TIMESTAMP };
}

/** user → assistant(thinking + tool call with an image result) → user */
function toolHistory(): Message[] {
  return [
    user('m1', 'Read the config'),
    {
      id: 'm2',
      role: 'assistant',
      content: 'Reading it now.',
      timestamp: FIXED_TIMESTAMP,
      thinking: 'The user wants the config file.',
      toolCalls: [{
        id: 'call_1',
        name: 'read_file',
        input: { path: 'config.json' },
        result: '{"a":1}',
        resultContent: [
          { type: 'text', text: '{"a":1}' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
        ],
      }],
    },
    user('m3', 'Thanks, now summarize it'),
  ];
}

function imageTurn(): Message[] {
  return [user('m1', [
    { type: 'text', text: 'What is in this picture?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
  ] as Message['content'])];
}

async function recordOpenAI(messages: Message[], options: ChatOptions): Promise<string> {
  mockFetch.mockResolvedValueOnce(openAiStream());
  await new OpenAICompatibleAdapter().chat(messages, options, () => {});
  const [url, init] = mockFetch.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];
  return JSON.stringify({ url, body: JSON.parse(init.body) }, null, 2) + '\n';
}

async function recordClaude(messages: Message[], options: ChatOptions): Promise<string> {
  mockFetch.mockResolvedValueOnce(anthropicStream());
  await new ClaudeAdapter().chat(messages, options, () => {});
  const [url, init] = mockFetch.mock.calls[0] as [string, { body: string }];
  return JSON.stringify({ url: String(url), body: JSON.parse(init.body) }, null, 2) + '\n';
}

const fixture = (name: string) => `./__contractFixtures__/requestShapes/${name}.json`;

describe('request shapes by model family', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    resetRejectionMemory();
  });

  describe('gpt', () => {
    it('gpt-5.5 with tools on the official endpoint', async () => {
      const body = await recordOpenAI([user('m1', 'hi')], {
        model: 'gpt-5.5', apiKey: 'k', baseUrl: 'https://api.openai.com/v1',
        tools: [readFileTool], maxTokens: 8192, reasoningEffort: 'medium',
        systemPrompt: 'You are Abu.', metadata: { conversationId: 'conv-1' },
      });
      await expect(body).toMatchFileSnapshot(fixture('gpt-5.5-tools-official'));
    });

    it('gpt-5.5 without tools keeps reasoning_effort', async () => {
      const body = await recordOpenAI([user('m1', 'hi')], {
        model: 'gpt-5.5', apiKey: 'k', baseUrl: 'https://api.openai.com/v1',
        maxTokens: 8192, reasoningEffort: 'medium', systemPrompt: 'You are Abu.',
      });
      await expect(body).toMatchFileSnapshot(fixture('gpt-5.5-no-tools-official'));
    });

    it('gpt-4o replays a tool turn with an image result', async () => {
      const body = await recordOpenAI(toolHistory(), {
        model: 'gpt-4o', apiKey: 'k', baseUrl: 'https://api.openai.com/v1',
        tools: [readFileTool], maxTokens: 4096, supportsVision: true,
        volatileContextTail: '[context] todo: none',
      });
      await expect(body).toMatchFileSnapshot(fixture('gpt-4o-tool-history'));
    });
  });

  describe('deepseek', () => {
    it('deepseek-reasoner with thinking and a tool turn', async () => {
      const body = await recordOpenAI(toolHistory(), {
        model: 'deepseek-reasoner', apiKey: 'k', baseUrl: 'https://api.deepseek.com/v1',
        tools: [readFileTool], maxTokens: 8192, reasoningEffort: 'high', supportsVision: false,
      });
      await expect(body).toMatchFileSnapshot(fixture('deepseek-reasoner-thinking-history'));
    });
  });

  describe('deepseek with the user\'s thinking effort', () => {
    const effortOptions = (thinkingEffort: 'off' | 'low' | 'high' | 'max'): ChatOptions => ({
      model: 'deepseek-flash', apiKey: 'k', baseUrl: 'https://api.deepseek.com/v1',
      tools: [readFileTool], supportsVision: false,
      // What the agent loop hands the adapter: the reasoning params computed with the pick.
      ...computeReasoningParams(resolveCapabilities('deepseek-flash'), 8192, undefined, thinkingEffort),
      maxTokens: 8192,
      declaredCapabilities: { supportsTools: true, supportsReasoning: true, thinkingEffort },
    });

    it('max: thinking enabled, reasoning_effort max, the earlier turn\'s reasoning handed back', async () => {
      const body = await recordOpenAI(toolHistory(), effortOptions('max'));
      await expect(body).toMatchFileSnapshot(fixture('deepseek-flash-effort-max'));
    });

    it('off: thinking disabled, no reasoning_effort, no reasoning_content on the replayed turn', async () => {
      const body = await recordOpenAI(toolHistory(), effortOptions('off'));
      await expect(body).toMatchFileSnapshot(fixture('deepseek-flash-effort-off'));
    });

    // The curated built-in DeepSeek preset has no provider-level declarations and no advanced
    // section: the pick sits on the model alone and reaches the wire through
    // resolveModelDeclared, the way the agent loop hands it to the adapter.
    describe('on the built-in DeepSeek provider', () => {
      const builtinDeepseek = (thinkingEffort?: 'off' | 'max'): ProviderInstance => ({
        id: 'deepseek', source: 'builtin', name: 'DeepSeek', enabled: true, apiFormat: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com', apiKey: 'k', status: 'unchecked', sortOrder: 0,
        models: [{
          id: 'deepseek-flash',
          label: 'DeepSeek V4.1 Flash',
          ...(thinkingEffort ? { declaredCapabilities: { thinkingEffort } } : {}),
        }],
      });
      const builtinOptions = (provider: ProviderInstance): ChatOptions => {
        const declared = resolveModelDeclared(provider, 'deepseek-flash');
        return {
          model: 'deepseek-flash', apiKey: 'k', baseUrl: 'https://api.deepseek.com/v1',
          tools: [readFileTool], supportsVision: false,
          ...computeReasoningParams(resolveCapabilities('deepseek-flash'), 8192, undefined, declared?.thinkingEffort),
          maxTokens: 8192,
          declaredCapabilities: declared,
        };
      };

      it('max on the model sends the same request as the same pick on a custom endpoint', async () => {
        const body = await recordOpenAI(toolHistory(), builtinOptions(builtinDeepseek('max')));
        await expect(body).toMatchFileSnapshot(fixture('deepseek-flash-effort-max'));
      });

      it('off on the model sends the same request as the same pick on a custom endpoint', async () => {
        const body = await recordOpenAI(toolHistory(), builtinOptions(builtinDeepseek('off')));
        await expect(body).toMatchFileSnapshot(fixture('deepseek-flash-effort-off'));
      });

      it('no pick leaves the request as it was before the setting existed', async () => {
        const withoutProvider = await recordOpenAI(toolHistory(), {
          model: 'deepseek-flash', apiKey: 'k', baseUrl: 'https://api.deepseek.com/v1',
          tools: [readFileTool], supportsVision: false,
          ...computeReasoningParams(resolveCapabilities('deepseek-flash'), 8192),
          maxTokens: 8192,
        });
        mockFetch.mockClear();
        const withBuiltin = await recordOpenAI(toolHistory(), builtinOptions(builtinDeepseek()));
        expect(withBuiltin).toBe(withoutProvider);
      });
    });
  });

  describe('kimi', () => {
    it('kimi-k2.6 with thinking', async () => {
      const body = await recordOpenAI([user('m1', 'hi')], {
        model: 'kimi-k2.6', apiKey: 'k', baseUrl: 'https://api.moonshot.cn/v1',
        tools: [readFileTool], maxTokens: 8192, reasoningEffort: 'high',
      });
      await expect(body).toMatchFileSnapshot(fixture('kimi-k2.6-thinking'));
    });
  });

  describe('qwen', () => {
    it('qwen3-max on DashScope with a thinking budget', async () => {
      const body = await recordOpenAI([user('m1', 'hi')], {
        model: 'qwen3-max', apiKey: 'k', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        tools: [readFileTool], maxTokens: 8192, thinkingBudget: 4096,
      });
      await expect(body).toMatchFileSnapshot(fixture('qwen3-max-dashscope-thinking'));
    });
  });

  describe('glm', () => {
    it('glm-5 on z.ai with thinking', async () => {
      const body = await recordOpenAI([user('m1', 'hi')], {
        model: 'glm-5', apiKey: 'k', baseUrl: 'https://api.z.ai/api/paas/v4',
        tools: [readFileTool], maxTokens: 8192, reasoningEffort: 'medium',
      });
      await expect(body).toMatchFileSnapshot(fixture('glm-5-zai-thinking'));
    });
  });

  describe('gemini through a gateway', () => {
    it('gemini-3 on OpenRouter with a strict schema and a tool turn', async () => {
      const body = await recordOpenAI(toolHistory(), {
        model: 'google/gemini-3-pro', apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1',
        tools: [readFileTool, strictSchemaTool], maxTokens: 8192, reasoningEffort: 'low', supportsVision: true,
      });
      await expect(body).toMatchFileSnapshot(fixture('gemini-3-openrouter-tool-history'));
    });
  });

  describe('custom endpoint with declared capabilities', () => {
    it('declared protocol fields drive the request', async () => {
      const body = await recordOpenAI(toolHistory(), {
        model: 'my-model', apiKey: 'k', baseUrl: 'https://gateway.example.com/v1',
        tools: [readFileTool], maxTokens: 8192, reasoningEffort: 'low', supportsVision: false,
        declaredCapabilities: {
          supportsTools: true, supportsReasoning: true, supportedEfforts: ['medium', 'high'],
          maxTokensField: 'max_completion_tokens', requiresToolResultName: true,
          thinkingFormat: 'qwen-chat-template',
        },
      });
      await expect(body).toMatchFileSnapshot(fixture('custom-declared-protocol'));
    });

    it('declared supportsTools=false sends no tools and no reasoning', async () => {
      const body = await recordOpenAI(imageTurn(), {
        model: 'my-model', apiKey: 'k', baseUrl: 'https://gateway.example.com/v1',
        tools: [readFileTool], maxTokens: 8192, reasoningEffort: 'low', supportsVision: false,
        declaredCapabilities: { supportsTools: false, supportsReasoning: false, supportsImages: false },
      });
      await expect(body).toMatchFileSnapshot(fixture('custom-declared-no-tools-no-vision'));
    });
  });

  describe('a capability the model rejected earlier in the session', () => {
    const accounting = { source: 'main' as const, conversationId: 'conv-1', skill: null, providerInstanceId: 'p1' };

    it('reasoning_effort in this process\'s memory: the field is withheld, thinking_budget stays', async () => {
      recordCapabilityRejection('p1', 'my-model', 'reasoning_effort');
      const body = await recordOpenAI([user('m1', 'hi')], {
        model: 'my-model', apiKey: 'k', baseUrl: 'https://gateway.example.com/v1',
        tools: [readFileTool], maxTokens: 8192, reasoningEffort: 'low', thinkingBudget: 2048, accounting,
      });
      await expect(body).toMatchFileSnapshot(fixture('rejected-reasoning-effort-memory'));
    });

    it('max_tokens_field carried by the caller: gpt-4o swaps to max_completion_tokens', async () => {
      const body = await recordOpenAI([user('m1', 'hi')], {
        model: 'gpt-4o', apiKey: 'k', baseUrl: 'https://api.openai.com/v1',
        tools: [readFileTool], maxTokens: 4096, capabilityOverrides: ['max_tokens_field'],
      });
      await expect(body).toMatchFileSnapshot(fixture('rejected-max-tokens-field-caller'));
    });

    it('image_block and parallel_tool_calls: images become text, the parallel flag is withheld', async () => {
      recordCapabilityRejection('p1', 'my-model', 'image_block');
      recordCapabilityRejection('p1', 'my-model', 'parallel_tool_calls');
      const body = await recordOpenAI(imageTurn(), {
        model: 'my-model', apiKey: 'k', baseUrl: 'https://gateway.example.com/v1',
        tools: [readFileTool], maxTokens: 8192, supportsVision: true, accounting,
        declaredCapabilities: { supportsImages: true, parallelToolCalls: false },
      });
      await expect(body).toMatchFileSnapshot(fixture('rejected-image-and-parallel-memory'));
    });

    it('tool_schema_keyword: draft-7 keywords leave the schema on a standard dialect', async () => {
      recordCapabilityRejection('p1', 'my-model', 'tool_schema_keyword');
      const body = await recordOpenAI([user('m1', 'hi')], {
        model: 'my-model', apiKey: 'k', baseUrl: 'https://gateway.example.com/v1',
        tools: [readFileTool, strictSchemaTool], maxTokens: 8192, accounting,
      });
      await expect(body).toMatchFileSnapshot(fixture('rejected-tool-schema-keyword-memory'));
    });

    it('thinking on the Anthropic protocol: the thinking block and its temperature are withheld', async () => {
      recordCapabilityRejection('p1', 'claude-opus-5-5', 'thinking');
      const body = await recordClaude([user('m1', 'hi')], {
        model: 'claude-opus-5-5', apiKey: 'k', systemPrompt: 'You are Abu.',
        maxTokens: 16384, enableThinking: true, thinkingBudget: 10000, accounting,
      });
      await expect(body).toMatchFileSnapshot(fixture('rejected-thinking-anthropic-memory'));
    });
  });

  describe('claude', () => {
    it('sections, tools, thinking, volatile tail and a tool turn', async () => {
      const body = await recordClaude(toolHistory(), {
        model: 'claude-opus-5-5', apiKey: 'k',
        systemPromptSections: [
          { name: 'persona', text: 'You are Abu.', cacheable: true },
          { name: 'rules', text: 'Follow the rules.', cacheable: true },
          { name: 'time', text: 'Now: 2026-10-19', cacheable: false },
        ],
        tools: [readFileTool], maxTokens: 16384, enableThinking: true, thinkingBudget: 10000,
        volatileContextTail: '[context] todo: none', supportsVision: true,
      });
      await expect(body).toMatchFileSnapshot(fixture('claude-sections-tools-thinking-history'));
    });

    it('thinking effort low: a 4096-token budget under the same max_tokens', async () => {
      const body = await recordClaude([user('m1', 'hi')], {
        model: 'claude-opus-5-5', apiKey: 'k', systemPrompt: 'You are Abu.',
        ...computeReasoningParams(resolveCapabilities('claude-opus-4-8'), 32768, 200000, 'low'),
        declaredCapabilities: { supportsReasoning: true, thinkingEffort: 'low' },
      });
      await expect(body).toMatchFileSnapshot(fixture('claude-effort-low'));
    });

    it('thinking effort off: no thinking block and no forced temperature', async () => {
      const body = await recordClaude([user('m1', 'hi')], {
        model: 'claude-opus-5-5', apiKey: 'k', systemPrompt: 'You are Abu.',
        ...computeReasoningParams(resolveCapabilities('claude-opus-4-8'), 32768, 200000, 'off'),
        declaredCapabilities: { supportsReasoning: true, thinkingEffort: 'off' },
      });
      await expect(body).toMatchFileSnapshot(fixture('claude-effort-off'));
    });

    it('plain system prompt with temperature', async () => {
      const body = await recordClaude(imageTurn(), {
        model: 'claude-sonnet-5-5', apiKey: 'k', systemPrompt: 'You are Abu.',
        maxTokens: 4096, temperature: 0.3,
      });
      await expect(body).toMatchFileSnapshot(fixture('claude-plain-system'));
    });
  });
});
