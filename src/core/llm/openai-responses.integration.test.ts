/**
 * Integration: OpenAICompatibleAdapter must route gpt-5.5-on-official to
 * /v1/responses (issue #86) and everything else to /v1/chat/completions.
 * Drives the real adapter with a mocked fetch capturing URL + body and
 * replaying a Responses-style SSE stream.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, StreamEvent, ToolDefinition } from '../../types';
import type { ChatOptions } from './adapter';

const mockFetch = vi.fn();
vi.mock('./tauriFetch', () => ({
  getTauriFetch: () => Promise.resolve(mockFetch),
}));

import { OpenAICompatibleAdapter } from './openai-compatible';

/** Build a Responses-style SSE Response from typed events. */
function responsesSSE(events: Array<Record<string, unknown>>): Response {
  const body = events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'p' } }, required: ['path'] },
  execute: async () => 'ok',
} as ToolDefinition;

const userMsg: Message = { id: 'm1', role: 'user', content: 'read a.txt', timestamp: 0 };

async function run(options: Partial<ChatOptions>, sse: Response): Promise<{ url: string; body: Record<string, unknown>; events: StreamEvent[] }> {
  let url = '';
  let body: Record<string, unknown> = {};
  mockFetch.mockImplementationOnce(async (u: string, init: { body: string }) => {
    url = u;
    body = JSON.parse(init.body);
    return sse;
  });
  const adapter = new OpenAICompatibleAdapter();
  const events: StreamEvent[] = [];
  await adapter.chat([userMsg], {
    model: 'gpt-5.5', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', maxTokens: 128000,
    ...options,
  }, (e) => events.push(e));
  return { url, body, events };
}

describe('adapter routing for issue #86', () => {
  beforeEach(() => mockFetch.mockReset());

  it('gpt-5.5 + tools + reasoning → POSTs /responses with flat tools and reasoning.effort', async () => {
    const { url, body, events } = await run(
      { tools: [readFileTool], reasoningEffort: 'medium', toolChoice: { type: 'auto' } },
      responsesSSE([
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'read_file' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":"a.txt"}' },
        { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"path":"a.txt"}' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'read_file', arguments: '{"path":"a.txt"}' } },
        { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 11, output_tokens: 7 } } },
      ]),
    );

    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(body.reasoning_effort).toBeUndefined();   // the key that triggered the rejection
    expect(body.messages).toBeUndefined();
    expect(Array.isArray(body.input)).toBe(true);
    expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'function', name: 'read_file' });

    const toolUse = events.find((e) => e.type === 'tool_use') as { id: string; name: string; input: Record<string, unknown> };
    expect(toolUse).toMatchObject({ id: 'call_abc', name: 'read_file', input: { path: 'a.txt' } });
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ usage: { inputTokens: 11, outputTokens: 7 } });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
  });

  it('regression: gpt-5 (not 5.5) still POSTs /chat/completions', async () => {
    let url = '';
    mockFetch.mockImplementationOnce(async (u: string) => {
      url = u;
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });
    const adapter = new OpenAICompatibleAdapter();
    await adapter.chat([userMsg], {
      model: 'gpt-5', apiKey: 'k', baseUrl: 'https://api.openai.com/v1', maxTokens: 4096,
      tools: [readFileTool], reasoningEffort: 'medium',
    }, () => {});
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('regression: gpt-5.5 on a non-official proxy still POSTs /chat/completions', async () => {
    let url = '';
    mockFetch.mockImplementationOnce(async (u: string) => {
      url = u;
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });
    const adapter = new OpenAICompatibleAdapter();
    await adapter.chat([userMsg], {
      model: 'gpt-5.5', apiKey: 'k', baseUrl: 'https://my-proxy.example.com/v1', maxTokens: 4096,
      tools: [readFileTool], reasoningEffort: 'medium',
    }, () => {});
    expect(url).toBe('https://my-proxy.example.com/v1/chat/completions');
  });
});
