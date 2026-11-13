// @vitest-environment happy-dom
/**
 * The title call on each kind of model, through the real llmCall and adapters (only the network is
 * replaced): a model whose thinking can be turned off is asked not to think, one that always thinks
 * gets room for it, and either way a non-empty title ends up on the conversation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { setLanguage } from '@/i18n';
import type { Message } from '@/types';
import type { ProviderInstance } from '@/types/provider';
import { resetTitleGenForTests } from './titleGen';

vi.unmock('@anthropic-ai/sdk');
const mockFetch = vi.fn();
vi.mock('../llm/tauriFetch', () => ({ getTauriFetch: () => Promise.resolve(mockFetch) }));
vi.mock('./conversationStorage', async () => {
  const actual = await vi.importActual<typeof import('./conversationStorage')>('./conversationStorage');
  return {
    ...actual,
    appendMessage: vi.fn(async () => undefined),
    updateIndexEntry: vi.fn(async () => undefined),
    catalogReindexConversation: vi.fn(async () => undefined),
    flushIndex: vi.fn(async () => undefined),
  };
});

const user = (content: string): Message => ({ id: 'm1', role: 'user', content, timestamp: 1 });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); };

function anthropicStream(withThinking: boolean, text: string): Response {
  const events: Array<[string, unknown]> = [
    ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'c', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
  ];
  let index = 0;
  if (withThinking) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }]);
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 'The user greets me.' } }]);
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 's' } }]);
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
    index += 1;
  }
  events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
  events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }]);
  events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return new Response(events.map(([n, d]) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
function openAiStream(text: string): Response {
  const chunks = [{ id: 'c', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }];
  return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function useProvider(format: ProviderInstance['apiFormat'], baseUrl: string, modelId: string): void {
  const provider: ProviderInstance = {
    id: 'p', source: 'custom', name: 'p', enabled: true, apiFormat: format, baseUrl, apiKey: 'k',
    models: [{ id: modelId, label: modelId }], status: 'verified', sortOrder: 1, userAdded: true,
  };
  useSettingsStore.setState({ providers: [provider], activeModel: { providerId: 'p', modelId } });
}

async function runTitle(): Promise<{ body: Record<string, unknown>; title: string | undefined }> {
  const id = useChatStore.getState().createConversation();
  useChatStore.getState().addMessage(id, user('hello there'));
  useChatStore.getState().setConversationStatus(id, 'running');
  useChatStore.getState().setConversationStatus(id, 'completed');
  await flush();
  const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
  return { body: JSON.parse(init.body) as Record<string, unknown>, title: useChatStore.getState().conversations[id]?.title };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockFetch.mockReset();
  resetTitleGenForTests();
  setLanguage('en-US');
});
afterEach(() => vi.useRealTimers());

describe('the title call asks each kind of model for its title without spending the budget on thinking', () => {
  it('claude-opus-5 (thinking can be turned off): thinking disabled, 60 tokens', async () => {
    useProvider('anthropic', 'https://api.anthropic.com', 'claude-opus-5');
    mockFetch.mockResolvedValueOnce(anthropicStream(false, 'Greeting'));
    const { body, title } = await runTitle();
    expect(body).toMatchObject({ max_tokens: 60, thinking: { type: 'disabled' } });
    expect(title).toBe('Greeting');
  });

  it('claude-fable-5 (always thinks): room for the thinking on top of the title, and the title comes out of the text', async () => {
    useProvider('anthropic', 'https://api.anthropic.com', 'claude-fable-5');
    mockFetch.mockResolvedValueOnce(anthropicStream(true, 'Greeting'));
    const { body, title } = await runTitle();
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens as number).toBeGreaterThan(60 + 4096);
    expect(title).toBe('Greeting');
  });

  it('deepseek-flash (thinks by default, has a switch): thinking disabled, 60 tokens', async () => {
    useProvider('openai-compatible', 'https://api.deepseek.com', 'deepseek-flash');
    mockFetch.mockResolvedValueOnce(openAiStream('Greeting'));
    const { body, title } = await runTitle();
    expect(body).toMatchObject({ max_tokens: 60, thinking: { type: 'disabled' } });
    expect(title).toBe('Greeting');
  });

  it('gpt-5 (always reasons): the lowest effort and room for the reasoning', async () => {
    useProvider('openai-compatible', 'https://api.openai.com/v1', 'gpt-5');
    mockFetch.mockResolvedValueOnce(openAiStream('Greeting'));
    const { body, title } = await runTitle();
    expect(body).toMatchObject({ reasoning_effort: 'low' });
    expect(body.max_completion_tokens as number).toBeGreaterThan(60 + 4096);
    expect(title).toBe('Greeting');
  });
});
