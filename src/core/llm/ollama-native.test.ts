import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, StreamEvent, ToolDefinition } from '../../types';
import type { ChatOptions } from './adapter';
import type { UsageAttempt } from './usageAccounting';
import type { PreparedTurn } from './messageNormalizer';

const mockFetch = vi.fn();
vi.mock('./tauriFetch', () => ({
  getTauriFetch: () => Promise.resolve(mockFetch),
}));

const emitted: UsageAttempt[] = [];
vi.mock('./usageSink', () => ({
  emitUsageAttempt: (attempt: UsageAttempt) => {
    emitted.push(attempt);
  },
}));

import { OllamaNativeAdapter, toOllamaMessages } from './ollama-native';
import { TOOL_RESULT_IMAGES_NOTE } from './openai-compatible';

const FIXED_TIMESTAMP = 1_700_000_000_000;
const userMessage: Message = { id: 'm1', role: 'user', content: '读一下 a.txt', timestamp: FIXED_TIMESTAMP };

const readFile: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: async () => 'ok',
};

function options(overrides: Partial<ChatOptions> = {}): ChatOptions {
  return {
    model: 'qwen3:0.6b',
    apiKey: '',
    baseUrl: 'http://127.0.0.1:11434',
    systemPrompt: 'sys',
    maxTokens: 2048,
    contextWindow: 32768,
    tools: [readFile],
    accounting: { source: 'main', conversationId: 'c1', skill: null, providerInstanceId: 'ollama' },
    ...overrides,
  };
}

function ndjson(lines: unknown[]): Response {
  return new Response(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

async function run(lines: unknown[], overrides: Partial<ChatOptions> = {}): Promise<StreamEvent[]> {
  mockFetch.mockResolvedValueOnce(ndjson(lines));
  const events: StreamEvent[] = [];
  await new OllamaNativeAdapter().chat([userMessage], options(overrides), (e) => events.push(e));
  return events;
}

const DONE = { model: 'qwen3:0.6b', done: true, done_reason: 'stop', prompt_eval_count: 120, eval_count: 30 };

beforeEach(() => {
  mockFetch.mockReset();
  emitted.length = 0;
});

describe('OllamaNativeAdapter request', () => {
  it('posts to /api/chat with the same window as num_ctx', async () => {
    await run([{ message: { role: 'assistant', content: 'hi' } }, DONE], { baseUrl: 'http://127.0.0.1:11434/v1/' });
    const [url, init] = mockFetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'qwen3:0.6b',
      stream: true,
      options: { num_ctx: 32768, num_predict: 2048 },
      tools: [{ type: 'function', function: { name: 'read_file' } }],
    });
    expect((body.messages as Array<{ role: string }>)[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('leaves tools out when the user said the model cannot call tools', async () => {
    await run([DONE], { declaredCapabilities: { supportsTools: false } });
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
  });

  it('refuses to send a request without a window', async () => {
    await expect(new OllamaNativeAdapter().chat([userMessage], options({ contextWindow: undefined }), () => {}))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('OllamaNativeAdapter streaming', () => {
  it('streams thinking, text, a native tool call and usage', async () => {
    const events = await run([
      { message: { role: 'assistant', content: '', thinking: 'plan' } },
      { message: { role: 'assistant', content: 'Hel' } },
      { message: { role: 'assistant', content: 'lo' } },
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }] } },
      DONE,
    ]);
    expect(events.filter((e) => e.type === 'thinking')).toEqual([{ type: 'thinking', thinking: 'plan' }]);
    expect(events.map((e) => (e.type === 'text' ? e.text : '')).join('')).toBe('Hello');
    expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 120, outputTokens: 30 } });
    expect(events.find((e) => e.type === 'tool_use')).toMatchObject({ name: 'read_file', input: { path: 'a.txt' } });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
  });

  it('runs an operation written into the text and hides it', async () => {
    const events = await run([
      { message: { role: 'assistant', content: '好的<invoke name="read_file"><param' } },
      { message: { role: 'assistant', content: 'eter name="path">a.txt</parameter></invoke>' } },
      DONE,
    ]);
    expect(events.map((e) => (e.type === 'text' ? e.text : '')).join('')).toBe('好的');
    expect(events.find((e) => e.type === 'tool_use')).toMatchObject({ name: 'read_file', input: { path: 'a.txt' } });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
  });

  it('reports a malformed operation without printing it', async () => {
    const events = await run([{ message: { role: 'assistant', content: '<tool_call>{"name":' } }, DONE]);
    expect(events.some((e) => e.type === 'text')).toBe(false);
    expect(events.find((e) => e.type === 'malformed_tool_call')).toEqual({ type: 'malformed_tool_call', raw: '<tool_call>{"name":' });
  });

  it('maps a length stop with no operation to max_tokens', async () => {
    const events = await run([{ message: { role: 'assistant', content: 'cut' } }, { ...DONE, done_reason: 'length' }]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'max_tokens' });
  });

  it('records the final usage in the ledger', async () => {
    await run([{ message: { role: 'assistant', content: 'hi' } }, { ...DONE, prompt_eval_cached_count: 100 }]);
    const last = emitted.at(-1);
    expect(last).toMatchObject({
      protocol: 'openai-compatible',
      servedModel: 'qwen3:0.6b',
      outcome: 'succeeded',
      usage: { inputTotal: 120, outputTotal: 30, cacheRead: 100, uncachedInput: 20, evidence: 'final' },
    });
  });
});

describe('OllamaNativeAdapter errors', () => {
  it('turns an in-stream overflow error into context_too_long', async () => {
    mockFetch.mockResolvedValueOnce(ndjson([{ error: 'the prompt is longer than the context length currently available to the model' }]));
    await expect(new OllamaNativeAdapter().chat([userMessage], options(), () => {}))
      .rejects.toMatchObject({ code: 'context_too_long' });
  });

  it('keeps Ollama\'s own wording for an HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "model 'x' not found" }), { status: 404 }));
    await expect(new OllamaNativeAdapter().chat([userMessage], options(), () => {}))
      .rejects.toMatchObject({ code: 'not_found', message: "model 'x' not found" });
  });
});

describe('toOllamaMessages', () => {
  it('sends images as base64, tool results with the tool name, and the volatile tail last', () => {
    const turns: PreparedTurn[] = [
      { kind: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
      {
        kind: 'assistant',
        text: '',
        thinking: 't',
        toolCalls: [{
          id: 'c1', name: 'read_file', input: { path: 'a' }, result: 'file body',
          resultImages: [{ mediaType: 'image/png', data: 'BBBB' }], isError: false,
        }],
      },
    ];
    expect(toOllamaMessages(turns, 'sys', 'tail')).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '看图', images: ['AAAA'] },
      { role: 'assistant', content: '', thinking: 't', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: { path: 'a' } } }] },
      { role: 'tool', content: 'file body', tool_name: 'read_file', tool_call_id: 'c1' },
      { role: 'user', content: TOOL_RESULT_IMAGES_NOTE, images: ['BBBB'] },
      { role: 'user', content: 'tail' },
    ]);
  });
});
