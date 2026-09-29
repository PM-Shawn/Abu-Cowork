import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Message, StreamEvent, ToolDefinition } from '../../types';
import type { ChatOptions } from './adapter';
import type { UsageAttempt } from './usageAccounting';
import type { PreparedTurn } from './messageNormalizer';

const mockFetch = vi.fn();
const fetchRequests: Array<{ localServer?: boolean } | undefined> = [];
vi.mock('./tauriFetch', () => ({
  getTauriFetch: (fetchOptions?: { localServer?: boolean }) => {
    fetchRequests.push(fetchOptions);
    return Promise.resolve(mockFetch);
  },
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
  fetchRequests.length = 0;
  emitted.length = 0;
});

describe('OllamaNativeAdapter request', () => {
  it('posts to /api/chat without num_ctx when the user left the context length blank', async () => {
    await run([{ message: { role: 'assistant', content: 'hi' } }, DONE], { baseUrl: 'http://127.0.0.1:11434/v1/' });
    const [url, init] = mockFetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'qwen3:0.6b',
      stream: true,
      truncate: false,
      shift: false,
      tools: [{ type: 'function', function: { name: 'read_file' } }],
    });
    // 阿布安排内容用的窗口（contextWindow: 32768）不发给 Ollama，Ollama 按自己的设置运行
    expect(body.options).toEqual({ num_predict: 2048 });
    expect((body.messages as Array<{ role: string }>)[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('sends the context length the user filled in as num_ctx', async () => {
    await run([DONE], { requestedContextLength: 8192 });
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body) as Record<string, unknown>;
    expect(body.options).toEqual({ num_ctx: 8192, num_predict: 2048 });
    expect(body.truncate).toBe(false);
    expect(body.shift).toBe(false);
  });

  it('still sends the request when no window is known at all', async () => {
    const events = await run([{ message: { role: 'assistant', content: 'hi' } }, DONE], { contextWindow: undefined });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body) as Record<string, unknown>;
    expect(body.options).toEqual({ num_predict: 2048 });
  });

  it('turns off Ollama\'s own truncation and context shift so an overflow is reported', async () => {
    await run([DONE]);
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body) as Record<string, unknown>;
    expect(body.truncate).toBe(false);
    expect(body.shift).toBe(false);
  });

  it('sends think: false when thinking is turned off and nothing otherwise', async () => {
    await run([DONE], { enableThinking: false });
    const off = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body) as Record<string, unknown>;
    expect(off.think).toBe(false);

    await run([DONE], { enableThinking: true });
    const on = JSON.parse((mockFetch.mock.calls[1] as [string, { body: string }])[1].body) as Record<string, unknown>;
    expect('think' in on).toBe(false);

    await run([DONE]);
    const unset = JSON.parse((mockFetch.mock.calls[2] as [string, { body: string }])[1].body) as Record<string, unknown>;
    expect('think' in unset).toBe(false);
  });

  it('leaves tools out when the user said the model cannot call tools', async () => {
    await run([DONE], { declaredCapabilities: { supportsTools: false } });
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
  });

});

describe('OllamaNativeAdapter waiting for the first answer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function abortError(): Error {
    const error = new Error('Request cancelled');
    error.name = 'AbortError';
    return error;
  }

  /** 服务收下请求后一直不回响应头，直到请求被中止。 */
  function neverAnswers(): void {
    mockFetch.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) return reject(abortError());
      init?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    }));
  }

  /** 响应头马上到，正文先送出 head 里的几行，之后一直不动，直到请求被中止。 */
  function stallsAfter(head: unknown[]): void {
    mockFetch.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of head) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          if (init?.signal?.aborted) return controller.error(abortError());
          init?.signal?.addEventListener('abort', () => controller.error(abortError()), { once: true });
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }));
    });
  }

  function start(overrides: Partial<ChatOptions> = {}): { chatPromise: Promise<void>; settled: () => boolean } {
    let settled = false;
    const chatPromise = new OllamaNativeAdapter().chat([userMessage], options(overrides), () => {});
    chatPromise.then(() => { settled = true; }, () => { settled = true; });
    return { chatPromise, settled: () => settled };
  }

  it('sends the request as a local model server request, so the transport does not end the wait first', async () => {
    neverAnswers();
    const { chatPromise } = start({ baseUrl: 'http://192.168.1.20:11434' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchRequests).toEqual([{ localServer: true }]);
    await vi.advanceTimersByTimeAsync(601_000);
    await expect(chatPromise).rejects.toMatchObject({ code: 'local_server_timeout' });
  });

  it('waits 10 minutes for a model that has not started answering, then fails without retry', async () => {
    neverAnswers();
    const { chatPromise, settled } = start();
    await vi.advanceTimersByTimeAsync(599_000);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(chatPromise).rejects.toMatchObject({ code: 'local_server_timeout', retryable: false });
    expect(emitted.at(-1)).toMatchObject({ outcome: 'failed' });
  });

  it('counts the whole wait until the first output, headers alone do not end it', async () => {
    stallsAfter([]);
    const { chatPromise, settled } = start();
    await vi.advanceTimersByTimeAsync(599_000);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(chatPromise).rejects.toMatchObject({ code: 'local_server_timeout', retryable: false });
  });

  it('keeps the 180 second idle rule once output has started', async () => {
    stallsAfter([{ message: { role: 'assistant', content: 'Hel' } }]);
    const { chatPromise, settled } = start();
    await vi.advanceTimersByTimeAsync(179_000);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(chatPromise).rejects.toMatchObject({ code: 'network_error', retryable: true });
  });

  it('ends at once when the user stops during the wait', async () => {
    neverAnswers();
    const controller = new AbortController();
    const { chatPromise, settled } = start({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled()).toBe(false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled()).toBe(true);
    await expect(chatPromise).rejects.toMatchObject({ code: 'network_error' });
    expect(emitted.at(-1)).toMatchObject({ outcome: 'cancelled' });
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

  it('generates an id for a native tool call that arrives without one', async () => {
    const events = await run([
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }] } },
      DONE,
    ]);
    const call = events.find((e) => e.type === 'tool_use');
    expect(call?.type === 'tool_use' && call.id).toMatch(/^ollama-tc-/);
  });

  it('reassembles a JSON line that arrives split across two chunks', async () => {
    const line = JSON.stringify({ message: { role: 'assistant', content: 'Hello' } });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(line.slice(0, 12)));
        controller.enqueue(encoder.encode(`${line.slice(12)}\n${JSON.stringify(DONE)}\n`));
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce(new Response(body, { status: 200 }));
    const events: StreamEvent[] = [];
    await new OllamaNativeAdapter().chat([userMessage], options(), (e) => events.push(e));
    expect(events.map((e) => (e.type === 'text' ? e.text : '')).join('')).toBe('Hello');
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
  });

  it('fails as a retryable network error when the stream ends without a final frame', async () => {
    await expect(run([{ message: { role: 'assistant', content: 'half' } }]))
      .rejects.toMatchObject({ code: 'network_error', retryable: true, message: 'Ollama stream ended before it finished' });
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

/** truncate:false 下 Ollama 原样转交的 llama-server 报错，JSON 文本包在 {"error": …} 里。 */
const LLAMA_SERVER_OVERFLOW_BODY = JSON.stringify({
  error: {
    code: 400,
    message: 'request (9000 tokens) exceeds the available context size (4096 tokens), try increasing it',
    type: 'exceed_context_size_error',
    n_prompt_tokens: 9000,
    n_ctx: 4096,
  },
});

describe('OllamaNativeAdapter errors', () => {
  it('turns an in-stream overflow error into context_too_long', async () => {
    mockFetch.mockResolvedValueOnce(ndjson([{ error: 'request (9000 tokens) exceeds the available context size (4096 tokens), try increasing it' }]));
    await expect(new OllamaNativeAdapter().chat([userMessage], options(), () => {}))
      .rejects.toMatchObject({ code: 'context_too_long', contextLimit: 4096 });
  });

  it('turns an HTTP 400 overflow into context_too_long', async () => {
    mockFetch.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'request (9000 tokens) exceeds the available context size (4096 tokens), try increasing it' }),
      { status: 400 },
    ));
    await expect(new OllamaNativeAdapter().chat([userMessage], options(), () => {}))
      .rejects.toMatchObject({ code: 'context_too_long', statusCode: 400 });
  });

  it('reads the limit out of the llama-server error body Ollama forwards as text', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: LLAMA_SERVER_OVERFLOW_BODY }), { status: 400 }));
    await expect(new OllamaNativeAdapter().chat([userMessage], options(), () => {}))
      .rejects.toMatchObject({ code: 'context_too_long', statusCode: 400, contextLimit: 4096 });
  });

  it('turns any other in-stream error into a retryable server error', async () => {
    mockFetch.mockResolvedValueOnce(ndjson([{ message: { role: 'assistant', content: 'a' } }, { error: 'model runner has unexpectedly stopped' }]));
    await expect(new OllamaNativeAdapter().chat([userMessage], options(), () => {}))
      .rejects.toMatchObject({ code: 'server_error', retryable: true, message: 'model runner has unexpectedly stopped' });
  });

  it('settles the ledger as cancelled when the user stops mid-stream', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    mockFetch.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) => {
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(encoder.encode(`${JSON.stringify({ message: { role: 'assistant', content: 'a' } })}\n`));
          init.signal.addEventListener('abort', () => {
            const abortError = new Error('Request cancelled');
            abortError.name = 'AbortError';
            streamController.error(abortError);
          }, { once: true });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const chatPromise = new OllamaNativeAdapter().chat([userMessage], options({ signal: controller.signal }), (event) => {
      if (event.type === 'text') controller.abort();
    });
    await expect(chatPromise).rejects.toMatchObject({ code: 'network_error' });
    expect(emitted.at(-1)).toMatchObject({ outcome: 'cancelled' });
  });

  it('keeps Ollama\'s own wording for an HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "model 'x' not found" }), { status: 404 }));
    await expect(new OllamaNativeAdapter().chat([userMessage], options(), () => {}))
      .rejects.toMatchObject({ code: 'not_found', message: "model 'x' not found" });
  });
});

describe('toOllamaMessages', () => {
  it('separates the text blocks of one user turn with a line break', () => {
    const turns: PreparedTurn[] = [
      { kind: 'user', content: [{ type: 'text', text: '看图' }, { type: 'text', text: '<image_resize_notice>resized</image_resize_notice>' }] },
    ];
    expect(toOllamaMessages(turns)).toEqual([
      { role: 'user', content: '看图\n<image_resize_notice>resized</image_resize_notice>' },
    ]);
  });

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
