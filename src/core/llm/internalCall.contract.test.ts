/**
 * The app's own short calls, as the real adapters write them: one request body per kind of model.
 * A model whose thinking can be turned off is sent a valid off field under the answer's budget; a
 * model that always thinks is sent no off field and a budget with room for the reasoning.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../types';
import type { ProviderInstance } from '../../types/provider';
import type { ChatOptions } from './adapter';

vi.unmock('@anthropic-ai/sdk');
const mockFetch = vi.fn();
vi.mock('./tauriFetch', () => ({ getTauriFetch: () => Promise.resolve(mockFetch) }));

import { ClaudeAdapter } from './claude';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { INTERNAL_REASONING_HEADROOM, internalCallOptions } from './internalCall';
import { resolveModelDeclared } from './resolveModelDeclared';

const messages: Message[] = [{ id: 'm1', role: 'user', content: 'Give a title', timestamp: 1_700_000_000_000 }];

function anthropicStream(): Response {
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'c', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(events.map(([n, d]) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
function openAiStream(): Response {
  const chunks = [{ id: 'c', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }];
  return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function providerOf(format: ProviderInstance['apiFormat'], baseUrl: string, modelId: string, thinkingEffort?: 'max'): ProviderInstance {
  return {
    id: 'p', source: 'custom', name: 'p', enabled: true, apiFormat: format, baseUrl, apiKey: 'k',
    models: [{ id: modelId, label: modelId, ...(thinkingEffort ? { declaredCapabilities: { thinkingEffort } } : {}) }],
    status: 'verified', sortOrder: 1, userAdded: true,
  };
}

async function internalBody(format: ProviderInstance['apiFormat'], baseUrl: string, modelId: string, answerTokens: number, userPick?: 'max') {
  const provider = providerOf(format, baseUrl, modelId, userPick);
  const options: ChatOptions = {
    model: modelId, apiKey: 'k', baseUrl,
    declaredCapabilities: resolveModelDeclared(provider, modelId),
    ...internalCallOptions({ provider, modelId, baseUrl, answerTokens }),
  };
  mockFetch.mockReset();
  if (format === 'anthropic') {
    mockFetch.mockResolvedValueOnce(anthropicStream());
    await new ClaudeAdapter().chat(messages, options, () => {});
  } else {
    mockFetch.mockResolvedValueOnce(openAiStream());
    await new OpenAICompatibleAdapter().chat(messages, options, () => {});
  }
  const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe('internal call request bodies', () => {
  beforeEach(() => mockFetch.mockReset());

  it('claude-opus-5 with answerTokens 60: thinking disabled, max_tokens 60', async () => {
    const body = await internalBody('anthropic', 'https://api.anthropic.com', 'claude-opus-5', 60);
    expect(body).toMatchObject({ max_tokens: 60, thinking: { type: 'disabled' } });
    expect(body.output_config).toBeUndefined();
  });

  it('claude-opus-5 whose user picked max for chats: still disabled', async () => {
    const body = await internalBody('anthropic', 'https://api.anthropic.com', 'claude-opus-5', 60, 'max');
    expect(body).toMatchObject({ max_tokens: 60, thinking: { type: 'disabled' } });
  });

  it('claude-fable-5 (cannot be turned off): no off field, room for thinking plus the answer', async () => {
    const body = await internalBody('anthropic', 'https://api.anthropic.com', 'claude-fable-5', 60);
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBe(60 + INTERNAL_REASONING_HEADROOM);
  });

  it('claude-sonnet-4-5 (thinks only when asked): no thinking field, answer budget', async () => {
    const body = await internalBody('anthropic', 'https://api.anthropic.com', 'claude-sonnet-4-5', 60);
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBe(60);
  });

  it('deepseek-flash, user picked max for chats: thinking disabled for the call, no reasoning_effort', async () => {
    const body = await internalBody('openai-compatible', 'https://api.deepseek.com', 'deepseek-flash', 60, 'max');
    expect(body).toMatchObject({ max_tokens: 60, thinking: { type: 'disabled' } });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('gpt-5.1: reasoning_effort none, answer budget', async () => {
    const body = await internalBody('openai-compatible', 'https://api.openai.com/v1', 'gpt-5.1', 60);
    expect(body).toMatchObject({ max_completion_tokens: 60, reasoning_effort: 'none' });
  });

  it('gpt-5 (no none level): lowest effort and room for the reasoning', async () => {
    const body = await internalBody('openai-compatible', 'https://api.openai.com/v1', 'gpt-5', 60);
    expect(body).toMatchObject({ max_completion_tokens: 60 + INTERNAL_REASONING_HEADROOM, reasoning_effort: 'low' });
  });
});
