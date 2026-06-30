/**
 * Tests for the OpenAI Responses API path (issue #86).
 *
 * gpt-5.5 on official OpenAI rejects /v1/chat/completions when a request carries
 * function tools + reasoning_effort ("Please use /v1/responses instead."). This
 * module routes that exact case to /v1/responses, whose request body and SSE
 * stream differ from chat/completions. These tests pin the detection rule, the
 * request-body shape, history serialization, usage extraction, and the SSE
 * event → StreamEvent mapping.
 */
import { describe, it, expect } from 'vitest';
import type { Message, StreamEvent, ToolDefinition } from '../../types';
import type { ChatOptions } from './adapter';
import { LLMError } from './adapter';
import {
  isOpenAIOfficialEndpoint,
  isGpt55Model,
  shouldUseResponsesApi,
  buildResponsesBody,
  extractResponsesUsage,
  toResponsesToolChoice,
  createResponsesParser,
} from './openai-responses';

const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path to file' } },
    required: ['path'],
  },
  execute: async () => 'ok',
} as ToolDefinition;

function makeOptions(overrides: Partial<ChatOptions> = {}): ChatOptions {
  return {
    model: 'gpt-5.5',
    apiKey: 'k',
    baseUrl: 'https://api.openai.com/v1',
    maxTokens: 128000,
    ...overrides,
  };
}

// ─── Detection ───────────────────────────────────────────────────────

describe('Responses API detection', () => {
  it('recognises the official OpenAI endpoint (resolved form)', () => {
    expect(isOpenAIOfficialEndpoint('https://api.openai.com/v1')).toBe(true);
    expect(isOpenAIOfficialEndpoint('https://api.openai.com')).toBe(true);
    expect(isOpenAIOfficialEndpoint('HTTPS://API.OPENAI.COM/v1')).toBe(true);
  });

  it('rejects non-official endpoints (proxies, other vendors, local)', () => {
    expect(isOpenAIOfficialEndpoint('https://api.deepseek.com/v1')).toBe(false);
    expect(isOpenAIOfficialEndpoint('https://my-proxy.example.com/v1')).toBe(false);
    expect(isOpenAIOfficialEndpoint('http://localhost:11434/v1')).toBe(false);
    // Must not be fooled by a lookalike host that merely contains the string.
    expect(isOpenAIOfficialEndpoint('https://api.openai.com.evil.com/v1')).toBe(false);
    expect(isOpenAIOfficialEndpoint('')).toBe(false);
  });

  it('matches gpt-5.5 family only', () => {
    expect(isGpt55Model('gpt-5.5')).toBe(true);
    expect(isGpt55Model('gpt-5.5-2026-01-01')).toBe(true);
    expect(isGpt55Model('gpt-5.5-chat-latest')).toBe(true);
    // Not gpt-5 / o-series / 4-series — those still work on chat/completions.
    expect(isGpt55Model('gpt-5')).toBe(false);
    expect(isGpt55Model('gpt-5-turbo')).toBe(false);
    expect(isGpt55Model('gpt-5.1')).toBe(false);
    expect(isGpt55Model('o5')).toBe(false);
    expect(isGpt55Model('gpt-4o')).toBe(false);
  });

  it('routes to Responses only for gpt-5.5 on the official endpoint', () => {
    expect(shouldUseResponsesApi('https://api.openai.com/v1', 'gpt-5.5')).toBe(true);
    // right model, wrong endpoint
    expect(shouldUseResponsesApi('https://my-proxy.example.com/v1', 'gpt-5.5')).toBe(false);
    // right endpoint, wrong model
    expect(shouldUseResponsesApi('https://api.openai.com/v1', 'gpt-5')).toBe(false);
  });
});

// ─── Request body ────────────────────────────────────────────────────

describe('buildResponsesBody', () => {
  const userMsg: Message = { id: 'm1', role: 'user', content: 'hello', timestamp: 0 };

  it('builds a Responses request, not a chat/completions one', () => {
    const body = buildResponsesBody([userMsg], makeOptions({
      systemPrompt: 'You are Abu.',
      tools: [readFileTool],
      reasoningEffort: 'medium',
      toolChoice: { type: 'auto' },
    }));

    expect(body.model).toBe('gpt-5.5');
    expect(body.instructions).toBe('You are Abu.');
    expect(body.max_output_tokens).toBe(128000);
    expect(body.stream).toBe(true);
    expect(body.reasoning).toEqual({ effort: 'medium' });

    // Responses uses `input`, not `messages`.
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.messages).toBeUndefined();

    // Tools are FLAT (no nested `function` wrapper) for the Responses API.
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      type: 'function',
      name: 'read_file',
      description: 'Read a file',
      parameters: readFileTool.inputSchema,
    });

    // The keys that break chat/completions must NOT appear here.
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });

  it('omits reasoning when no effort is requested', () => {
    const body = buildResponsesBody([userMsg], makeOptions());
    expect(body.reasoning).toBeUndefined();
  });

  it('serializes the user turn into an input item', () => {
    const body = buildResponsesBody([userMsg], makeOptions());
    const input = body.input as Array<Record<string, unknown>>;
    const user = input.find((i) => i.role === 'user');
    expect(user).toBeTruthy();
    // text carried either as a string or as input_text parts
    const text = typeof user!.content === 'string'
      ? user!.content
      : (user!.content as Array<Record<string, unknown>>).map((p) => p.text).join('');
    expect(text).toContain('hello');
  });

  it('serializes assistant tool calls + results as function_call / function_call_output items', () => {
    const history: Message[] = [
      { id: 'u1', role: 'user', content: 'read a.txt', timestamp: 0 },
      {
        id: 'a1', role: 'assistant', content: '', timestamp: 0,
        toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'a.txt' }, result: 'file body' }],
      },
      { id: 'u2', role: 'user', content: 'thanks', timestamp: 0 },
    ];
    const body = buildResponsesBody(history, makeOptions({ tools: [readFileTool] }));
    const input = body.input as Array<Record<string, unknown>>;

    const call = input.find((i) => i.type === 'function_call');
    expect(call).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'read_file' });
    expect(JSON.parse(call!.arguments as string)).toEqual({ path: 'a.txt' });

    const out = input.find((i) => i.type === 'function_call_output');
    expect(out).toMatchObject({ type: 'function_call_output', call_id: 'call_1', output: 'file body' });
  });
});

describe('toResponsesToolChoice', () => {
  it('maps Abu ToolChoice to the flat Responses form', () => {
    expect(toResponsesToolChoice(undefined)).toBeUndefined();
    expect(toResponsesToolChoice({ type: 'auto' })).toBe('auto');
    expect(toResponsesToolChoice({ type: 'any' })).toBe('required');
    expect(toResponsesToolChoice({ type: 'tool', name: 'read_file' }))
      .toEqual({ type: 'function', name: 'read_file' });
  });
});

// ─── Usage ───────────────────────────────────────────────────────────

describe('extractResponsesUsage', () => {
  it('maps input_tokens/output_tokens and cached tokens', () => {
    const u = extractResponsesUsage({
      input_tokens: 100,
      output_tokens: 42,
      input_tokens_details: { cached_tokens: 30 },
    });
    expect(u).toEqual({ inputTokens: 100, outputTokens: 42, cacheReadInputTokens: 30 });
  });

  it('tolerates missing fields', () => {
    expect(extractResponsesUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

// ─── SSE parser ──────────────────────────────────────────────────────

function collectFrom(events: Array<Record<string, unknown>>): StreamEvent[] {
  const out: StreamEvent[] = [];
  const parser = createResponsesParser((e) => out.push(e));
  for (const e of events) parser.handle(e);
  parser.end();
  return out;
}

describe('createResponsesParser', () => {
  it('emits text deltas and a clean end_turn done', () => {
    const events = collectFrom([
      { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.output_text.delta', delta: ' world' },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } } },
    ]);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text))
      .toEqual(['Hello', ' world']);
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ usage: { inputTokens: 5, outputTokens: 2 } });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });
  });

  it('maps reasoning summary deltas to thinking events', () => {
    const events = collectFrom([
      { type: 'response.reasoning_summary_text.delta', delta: 'pondering' },
      { type: 'response.completed', response: { status: 'completed', usage: {} } },
    ]);
    expect(events.find((e) => e.type === 'thinking')).toEqual({ type: 'thinking', thinking: 'pondering' });
  });

  it('assembles a streamed function call into a tool_use with call_id', () => {
    const events = collectFrom([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'read_file' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"a.txt"}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"path":"a.txt"}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'read_file', arguments: '{"path":"a.txt"}' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 8, output_tokens: 4 } } },
    ]);
    const toolUse = events.find((e) => e.type === 'tool_use') as { id: string; name: string; input: Record<string, unknown> } | undefined;
    expect(toolUse).toBeTruthy();
    expect(toolUse!.id).toBe('call_abc');           // call_id, not the output-item id
    expect(toolUse!.name).toBe('read_file');
    expect(toolUse!.input).toEqual({ path: 'a.txt' });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
  });

  it('signals max_tokens on truncation so the caller can escalate', () => {
    const events = collectFrom([
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 9, output_tokens: 9 } } },
    ]);
    expect(events.find((e) => e.type === 'usage')).toBeTruthy();
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'max_tokens' });
  });

  it('drops a half-streamed tool call on truncation (escalation path)', () => {
    const events = collectFrom([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_x', name: 'read_file' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":"a.t' },  // truncated JSON
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
    ]);
    expect(events.some((e) => e.type === 'tool_use')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'max_tokens' });
  });

  it('throws a classified LLMError on response.failed', () => {
    const parser = createResponsesParser(() => {});
    expect(() => parser.handle({
      type: 'response.failed',
      response: { status: 'failed', error: { code: 'server_error', message: 'boom' } },
    })).toThrow(LLMError);
  });

  it('falls back to a done event if the stream closes without a terminal event', () => {
    const events = collectFrom([
      { type: 'response.output_text.delta', delta: 'hi' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });
});
