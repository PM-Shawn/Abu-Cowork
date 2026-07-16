/**
 * Tests for OpenAICompatibleAdapter streaming behavior, specifically:
 *
 * - finish_reason='length' must NOT silently emit broken tool calls. When tool
 *   args are partial/unparseable, the adapter must drop them and signal
 *   stopReason='max_tokens' so agentLoop's escalateMaxOutputTokens can retry
 *   with a doubled limit.
 *
 * - finish_reason='length' WITH complete tool args should still emit tool_use
 *   normally (the model happened to finish the JSON exactly at the limit).
 *
 * - finish_reason='function_call' (legacy alias) is treated as tool_calls.
 *
 * Regression coverage for the GLM-5 read_file truncation incident.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Message, StreamEvent, ToolDefinition } from '../../types';
import { LLMError } from './adapter';
import type { ChatOptions } from './adapter';

function abortError(): Error {
  const e = new Error('Request cancelled');
  e.name = 'AbortError';
  return e;
}

// Mock getTauriFetch BEFORE importing the adapter so the singleton picks up the mock.
const mockFetch = vi.fn();
vi.mock('./tauriFetch', () => ({
  getTauriFetch: () => Promise.resolve(mockFetch),
}));

// Import after mock is registered.
import { OpenAICompatibleAdapter, toOpenAIToolChoice } from './openai-compatible';
import type { ToolChoice } from './adapter';

/** Build an SSE Response from a list of JSON-serializable chunks (plus [DONE]). */
function makeSSEResponse(chunks: unknown[]): Response {
  const lines: string[] = [];
  for (const c of chunks) {
    lines.push(`data: ${JSON.stringify(c)}\n\n`);
  }
  lines.push('data: [DONE]\n\n');
  const body = lines.join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Minimal valid ChatOptions for tests. */
function makeOptions(overrides: Partial<ChatOptions> = {}): ChatOptions {
  return {
    model: 'glm-5-test',
    apiKey: 'test-key',
    baseUrl: 'https://api.test.example.com/v1',
    maxTokens: 100,
    tools: [
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Path to file' } },
          required: ['path'],
        },
        execute: async () => 'ok',
      } as ToolDefinition,
    ],
    ...overrides,
  };
}

const userMessage: Message = {
  id: 'm1',
  role: 'user',
  content: 'read the file',
  timestamp: Date.now(),
};

async function runChat(chunks: unknown[]): Promise<StreamEvent[]> {
  mockFetch.mockResolvedValueOnce(makeSSEResponse(chunks));
  const adapter = new OpenAICompatibleAdapter();
  const events: StreamEvent[] = [];
  await adapter.chat([userMessage], makeOptions(), (e) => events.push(e));
  return events;
}

// Regression for B6: PDF/document content blocks were silently dropped when
// serializing for OpenAI-compatible providers (both the image-parts path and the
// text-only path), with NO placeholder — so the model saw nothing and could claim
// "no file was provided". A document must leave a text breadcrumb, mirroring the
// vision-unsupported image hint.
describe('OpenAICompatibleAdapter — document attachment placeholder (B6)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const pdfBlock = {
    type: 'document' as const,
    source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: 'JVBERi0xLjQK' },
  };

  async function requestBodyFor(messages: Message[], overrides: Partial<ChatOptions> = {}) {
    mockFetch.mockResolvedValueOnce(
      makeSSEResponse([
        { choices: [{ delta: { content: 'ok' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    );
    const adapter = new OpenAICompatibleAdapter();
    await adapter.chat(messages, makeOptions(overrides), () => {});
    return JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body) as {
      messages: Array<{ role: string; content: unknown }>;
    };
  }

  it('leaves a text breadcrumb for a document-only user message (text-join path)', async () => {
    const body = await requestBodyFor([
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'summarize this' }, pdfBlock], timestamp: Date.now() } as Message,
    ]);
    const user = body.messages.find((m) => m.role === 'user');
    const asText = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
    expect(asText.toLowerCase()).toContain('document');
  });

  it('leaves a text breadcrumb for a document alongside an image (content-parts path)', async () => {
    const body = await requestBodyFor(
      [
        {
          id: 'u1',
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
            pdfBlock,
          ],
          timestamp: Date.now(),
        } as Message,
      ],
      { supportsVision: true },
    );
    const user = body.messages.find((m) => m.role === 'user');
    // content is an array of parts (an image is present) — a text part must mention the document.
    expect(JSON.stringify(user?.content).toLowerCase()).toContain('document');
  });
});

describe('OpenAICompatibleAdapter streaming finish_reason handling', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("finish_reason='length' (max_tokens recovery path)", () => {
    it('drops broken tool calls and signals max_tokens when args are truncated', async () => {
      // Stream a tool call whose arguments are truncated mid-string,
      // then a finish_reason='length' chunk.
      const events = await runChat([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'tc_1',
                function: { name: 'read_file', arguments: '{"path":"26司服评' },
              }],
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
      ]);

      // The broken tool call must NOT be emitted — keeping it would set
      // collectedToolCalls.length > 0 in agentLoop and bypass escalation.
      expect(events.find((e) => e.type === 'tool_use')).toBeUndefined();

      // stopReason MUST be 'max_tokens' so agentLoop's escalation triggers.
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      if (done?.type === 'done') {
        expect(done.stopReason).toBe('max_tokens');
      }
    });

    it('signals max_tokens when no tool calls were emitted (pure text truncation)', async () => {
      const events = await runChat([
        { choices: [{ delta: { content: 'this is going to be cut o' } }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
      ]);

      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      if (done?.type === 'done') {
        expect(done.stopReason).toBe('max_tokens');
      }
    });

    it('emits tool_use normally when args happen to be complete despite length truncation', async () => {
      const events = await runChat([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'tc_1',
                function: { name: 'read_file', arguments: '{"path":"file.xlsx"}' },
              }],
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
      ]);

      const tu = events.find((e) => e.type === 'tool_use');
      expect(tu).toBeDefined();
      if (tu?.type === 'tool_use') {
        expect(tu.name).toBe('read_file');
        expect(tu.input).toEqual({ path: 'file.xlsx' });
        expect('_parse_error' in tu.input).toBe(false);
      }

      const done = events.find((e) => e.type === 'done');
      expect(done?.type === 'done' && done.stopReason).toBe('tool_use');
    });

    it('emits a COMPLETE text-tag <tool_call> truncated by length instead of dropping it', async () => {
      // A text-tag-convention model (no native tool_calls) emits one fully-closed
      // <tool_call> block, then keeps generating and is cut off at max_tokens.
      // The text parser only buffers closed tool calls, so this one is complete
      // and must be executed — NOT dropped with a needless max_tokens retry.
      // Regression for the length-branch asymmetry: every other terminal branch
      // calls emitTextToolCalls(), but 'length' only inspected native buffers.
      const events = await runChat([
        {
          choices: [{
            delta: {
              content:
                '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call> now rambling on until we run ou',
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
      ]);

      const tu = events.find((e) => e.type === 'tool_use');
      expect(tu).toBeDefined();
      if (tu?.type === 'tool_use') {
        expect(tu.name).toBe('read_file');
        expect(tu.input).toEqual({ path: 'a.txt' });
      }

      // A decided, complete action ran → tool_use, not max_tokens escalation.
      const done = events.find((e) => e.type === 'done');
      expect(done?.type === 'done' && done.stopReason).toBe('tool_use');
    });
  });

  describe("finish_reason='stop_sequence' (stop-word match)", () => {
    it("treats stop_sequence like stop — emits done end_turn when no tool calls", async () => {
      const events = await runChat([
        { choices: [{ delta: { content: 'hello' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop_sequence' }] },
      ]);
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      if (done?.type === 'done') {
        expect(done.stopReason).toBe('end_turn');
      }
    });

    it("treats stop_sequence like stop — emits done tool_use when text tool calls present", async () => {
      const events = await runChat([
        { choices: [{ delta: { content: '<tool_call>{"name":"read_file","arguments":{"path":"f.txt"}}</tool_call>' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop_sequence' }] },
      ]);
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      if (done?.type === 'done') {
        // text-based tool call was emitted → stopReason=tool_use
        expect(done.stopReason).toBe('tool_use');
      }
    });
  });

  describe("finish_reason='content_filter' / 'refusal'", () => {
    it("emits done end_turn on content_filter with no tool calls", async () => {
      const events = await runChat([
        { choices: [{ delta: { content: 'I cannot' } }] },
        { choices: [{ delta: {}, finish_reason: 'content_filter' }] },
      ]);
      // Must NOT hang — a done event must always be emitted
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      if (done?.type === 'done') {
        expect(done.stopReason).toBe('end_turn');
      }
    });

    it("emits done end_turn on refusal with no tool calls", async () => {
      const events = await runChat([
        { choices: [{ delta: {}, finish_reason: 'refusal' }] },
      ]);
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      if (done?.type === 'done') {
        expect(done.stopReason).toBe('end_turn');
      }
    });

    it("flushes a COMPLETED tool call streamed before content_filter", async () => {
      const events = await runChat([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc_1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'content_filter' }] },
      ]);
      const tu = events.find((e) => e.type === 'tool_use');
      expect(tu).toBeDefined();
      if (tu?.type === 'tool_use') {
        expect(tu.input).toEqual({ path: 'a.txt' });
        expect('_parse_error' in tu.input).toBe(false);
      }
      const done = events.find((e) => e.type === 'done');
      expect(done?.type === 'done' && done.stopReason).toBe('tool_use');
    });

    it("DROPS a malformed tool call on content_filter (never surfaces _parse_error)", async () => {
      const events = await runChat([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc_1', function: { name: 'read_file', arguments: '{"path":"trunc' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'content_filter' }] },
      ]);
      expect(events.find((e) => e.type === 'tool_use')).toBeUndefined();
      const done = events.find((e) => e.type === 'done');
      expect(done?.type === 'done' && done.stopReason).toBe('end_turn');
    });
  });

  describe("finish_reason='error' (provider-side error in stream)", () => {
    it("emits done end_turn without hanging", async () => {
      const events = await runChat([
        { choices: [{ delta: { content: 'partial' } }] },
        { choices: [{ delta: {}, finish_reason: 'error' }] },
      ]);
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      if (done?.type === 'done') {
        expect(done.stopReason).toBe('end_turn');
      }
    });

    it("flushes a COMPLETED tool call streamed before finish_reason='error'", async () => {
      // A provider may stream a full tool call then close the chunk with 'error';
      // the invocation must not be silently lost.
      const events = await runChat([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc_1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'error' }] },
      ]);
      const tu = events.find((e) => e.type === 'tool_use');
      expect(tu).toBeDefined();
      if (tu?.type === 'tool_use') {
        expect(tu.input).toEqual({ path: 'a.txt' });
        expect('_parse_error' in tu.input).toBe(false);
      }
      const done = events.find((e) => e.type === 'done');
      expect(done?.type === 'done' && done.stopReason).toBe('tool_use');
    });

    it("DROPS a malformed tool call on finish_reason='error'", async () => {
      const events = await runChat([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc_1', function: { name: 'read_file', arguments: '{"path":"trunc' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'error' }] },
      ]);
      expect(events.find((e) => e.type === 'tool_use')).toBeUndefined();
      const done = events.find((e) => e.type === 'done');
      expect(done?.type === 'done' && done.stopReason).toBe('end_turn');
    });
  });

  describe('unknown finish_reason', () => {
    it('emits tool_use + done tool_use when tool calls are buffered', async () => {
      const events = await runChat([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'tc_1',
                function: { name: 'read_file', arguments: '{"path":"x.txt"}' },
              }],
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: 'some_new_reason' }] },
      ]);

      // Must emit the tool call (not drop it silently)
      const tu = events.find((e) => e.type === 'tool_use');
      expect(tu).toBeDefined();
      if (tu?.type === 'tool_use') {
        expect(tu.name).toBe('read_file');
        expect(tu.input).toEqual({ path: 'x.txt' });
      }

      // Must emit done (not hang)
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      if (done?.type === 'done') {
        expect(done.stopReason).toBe('tool_use');
      }
    });

    it('emits done end_turn when no tool calls are buffered', async () => {
      const events = await runChat([
        { choices: [{ delta: { content: 'some text' } }] },
        { choices: [{ delta: {}, finish_reason: 'some_new_reason' }] },
      ]);

      // Must emit done (not hang)
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      if (done?.type === 'done') {
        expect(done.stopReason).toBe('end_turn');
      }
    });

    it('DROPS a malformed buffered tool call on unknown finish_reason (no _parse_error)', async () => {
      const events = await runChat([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc_1', function: { name: 'read_file', arguments: '{"path":"trunc' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'some_new_reason' }] },
      ]);
      // Malformed args must not be handed to the agent as a _parse_error tool call.
      expect(events.find((e) => e.type === 'tool_use')).toBeUndefined();
      const done = events.find((e) => e.type === 'done');
      expect(done?.type === 'done' && done.stopReason).toBe('end_turn');
    });
  });

  describe("finish_reason='function_call' (legacy alias)", () => {
    it('treats function_call same as tool_calls', async () => {
      const events = await runChat([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'tc_1',
                function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
              }],
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: 'function_call' }] },
      ]);

      const tu = events.find((e) => e.type === 'tool_use');
      expect(tu?.type === 'tool_use' && tu.input).toEqual({ path: 'a.txt' });
      const done = events.find((e) => e.type === 'done');
      expect(done?.type === 'done' && done.stopReason).toBe('tool_use');
    });
  });

  describe('regression: normal tool_calls path still works', () => {
    it("emits tool_use and stopReason='tool_use' on finish_reason='tool_calls'", async () => {
      const events = await runChat([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'tc_1',
                function: { name: 'read_file', arguments: '{"path":"x"}' },
              }],
            },
          }],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]);

      const tu = events.find((e) => e.type === 'tool_use');
      expect(tu?.type === 'tool_use' && tu.name).toBe('read_file');
      const done = events.find((e) => e.type === 'done');
      expect(done?.type === 'done' && done.stopReason).toBe('tool_use');
    });

    it("emits stopReason='end_turn' on plain finish_reason='stop' with no tool calls", async () => {
      const events = await runChat([
        { choices: [{ delta: { content: 'hello world' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);

      const done = events.find((e) => e.type === 'done');
      expect(done?.type === 'done' && done.stopReason).toBe('end_turn');
    });
  });

  describe('streaming usage parsing (stream_options)', () => {
    it('emits usage event from streaming usage chunk', async () => {
      const events = await runChat([
        { choices: [{ delta: { content: 'hello' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        // Usage chunk: empty choices + usage object (OpenAI stream_options format)
        { choices: [], usage: { prompt_tokens: 150, completion_tokens: 50 } },
      ]);

      const usage = events.find((e) => e.type === 'usage');
      expect(usage).toBeDefined();
      if (usage?.type === 'usage') {
        expect(usage.usage.inputTokens).toBe(150);
        expect(usage.usage.outputTokens).toBe(50);
      }
    });

    it('emits usage even when choices field is absent', async () => {
      const events = await runChat([
        { choices: [{ delta: { content: 'hi' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        // Some providers omit choices entirely on usage chunk
        { usage: { prompt_tokens: 200, completion_tokens: 80 } },
      ]);

      const usage = events.find((e) => e.type === 'usage');
      expect(usage).toBeDefined();
      if (usage?.type === 'usage') {
        expect(usage.usage.inputTokens).toBe(200);
        expect(usage.usage.outputTokens).toBe(80);
      }
    });

    it('does not emit usage when no usage chunk is present', async () => {
      const events = await runChat([
        { choices: [{ delta: { content: 'hi' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);

      expect(events.find((e) => e.type === 'usage')).toBeUndefined();
    });
  });

  describe('regression: assistant tool_call messages carry reasoning_content', () => {
    // Kimi K2.5 (and DeepSeek R1) in thinking mode reject assistant messages
    // that carry tool_calls but no reasoning_content field with HTTP 400:
    //   "thinking is enabled but reasoning_content is missing in assistant
    //    tool call message at index N"
    // The serializer must always set reasoning_content on tool_call assistant
    // messages — real thinking when captured, empty string otherwise.
    it("sets reasoning_content='' when prior assistant tool_call has no thinking", async () => {
      // Prior turn: assistant with tool_calls but no thinking captured
      const assistantWithToolCall: Message = {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [{
          id: 'tc_prior',
          name: 'read_file',
          input: { path: 'x.txt' },
          result: 'file content',
        }],
        // thinking: undefined — no reasoning captured for this turn
      };
      const history: Message[] = [
        userMessage,
        assistantWithToolCall,
        { id: 'u2', role: 'user', content: 'now summarize', timestamp: Date.now() },
      ];

      mockFetch.mockResolvedValueOnce(makeSSEResponse([
        { choices: [{ delta: { content: 'ok' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]));
      const adapter = new OpenAICompatibleAdapter();
      await adapter.chat(history, makeOptions(), () => {});

      expect(mockFetch).toHaveBeenCalledOnce();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as { messages: Array<Record<string, unknown>> };
      const asstMsg = body.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
      expect(asstMsg).toBeDefined();
      expect(asstMsg).toHaveProperty('reasoning_content');
      expect(asstMsg!.reasoning_content).toBe('');
    });

    it('preserves real thinking content when present on the turn', async () => {
      const assistantWithThinking: Message = {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        thinking: 'let me think about this',
        toolCalls: [{
          id: 'tc_prior',
          name: 'read_file',
          input: { path: 'x.txt' },
          result: 'file content',
        }],
      };
      const history: Message[] = [
        userMessage,
        assistantWithThinking,
        { id: 'u2', role: 'user', content: 'next', timestamp: Date.now() },
      ];

      mockFetch.mockResolvedValueOnce(makeSSEResponse([
        { choices: [{ delta: { content: 'ok' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]));
      const adapter = new OpenAICompatibleAdapter();
      await adapter.chat(history, makeOptions(), () => {});

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as { messages: Array<Record<string, unknown>> };
      const asstMsg = body.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
      expect(asstMsg!.reasoning_content).toBe('let me think about this');
    });
  });

  describe('regression: _parse_error fallback when tool args are invalid JSON', () => {
    it('marks tool input with _parse_error in [DONE] path when JSON parse fails', async () => {
      // Send incomplete args via [DONE] without explicit finish_reason on last chunk.
      const events = await runChat([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'tc_1',
                function: { name: 'read_file', arguments: '{"path":"' },
              }],
            },
          }],
        },
      ]);

      const tu = events.find((e) => e.type === 'tool_use');
      expect(tu).toBeDefined();
      if (tu?.type === 'tool_use') {
        expect('_parse_error' in tu.input).toBe(true);
      }
    });

    it('keeps the replayed _parse_error input bounded even for very long invalid args', async () => {
      // The _parse_error blob is persisted in the tool_use input and re-sent to
      // the model every turn until compaction, so it MUST stay small regardless
      // of how long the model's malformed args were (full args go to the disk
      // log instead — see PARSE_ERROR_INPUT_PREVIEW vs LOG_TOOL_ARG_PREVIEW).
      // Marker sits at ~char 230, past the 200-char input cap.
      const longInvalid = `{"path":"${'x'.repeat(220)}NEEDLE`; // unterminated string → invalid JSON
      const events = await runChat([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'tc_1',
                function: { name: 'read_file', arguments: longInvalid },
              }],
            },
          }],
        },
      ]);

      const tu = events.find((e) => e.type === 'tool_use');
      expect(tu?.type).toBe('tool_use');
      if (tu?.type === 'tool_use') {
        const preview = (tu.input as Record<string, unknown>)._parse_error as string;
        // Bounded: prefix (~28 chars) + at most 200 chars of args.
        expect(preview.length).toBeLessThanOrEqual(240);
        // Content past the 200-char cap must NOT be replayed to the model.
        expect(preview).not.toContain('NEEDLE');
      }
    });
  });
});

describe('OpenAICompatibleAdapter hang timeouts (abort on no progress)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts and throws retryable error when headers never arrive (connect phase)', async () => {
    // fetch never resolves until the request signal aborts — simulates a server
    // that accepts the connection but never returns response headers. This is the
    // phase the streaming idle-heartbeat can't cover (it only arms after body).
    mockFetch.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    });

    const adapter = new OpenAICompatibleAdapter();
    const events: StreamEvent[] = [];
    const chatPromise = adapter.chat([userMessage], makeOptions(), (e) => events.push(e));
    let settled = false;
    chatPromise.then(() => { settled = true; }, () => { settled = true; });

    // Connect phase shares the 180s hang ceiling (see heartbeat.ts).
    await vi.advanceTimersByTimeAsync(179_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    // code-review fix #10 regression: the connect-phase hang timer was
    // consolidated into a shared armHangTimer/hangTimeoutError helper — lock
    // down the exact message text and retryAfterMs it must still produce.
    await expect(chatPromise).rejects.toMatchObject({
      code: 'network_error',
      retryable: true,
      retryAfterMs: 2000,
      message: '连接超时：180 秒未收到服务器响应头',
    });
    await expect(chatPromise).rejects.toBeInstanceOf(LLMError);
  });

  it('aborts and throws retryable error when body stalls mid-stream (idle phase)', async () => {
    // Headers arrive, but the body stream never emits data and only rejects when
    // the request is aborted. The idle heartbeat must abort so reader.read()
    // rejects and chat() can unwind (previously it emitted events but stayed hung).
    mockFetch.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (signal?.aborted) return controller.error(abortError());
          signal?.addEventListener('abort', () => controller.error(abortError()), { once: true });
        },
      });
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    });

    const adapter = new OpenAICompatibleAdapter();
    const events: StreamEvent[] = [];
    const chatPromise = adapter.chat([userMessage], makeOptions(), (e) => events.push(e));
    let settled = false;
    chatPromise.then(() => { settled = true; }, () => { settled = true; });

    // Idle phase (headers already arrived) uses the patient 180s window.
    await vi.advanceTimersByTimeAsync(179_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(chatPromise).rejects.toMatchObject({ code: 'network_error', retryable: true });
  });

  it('non-streaming (Ollama+tools) body read aborts on the hang ceiling (B3)', async () => {
    // Ollama endpoint + tools forces the NON-streaming path (response.json()).
    // Headers arrive, but the body never completes and only errors on abort. The
    // body-download timeout must abort so response.json() rejects and chat()
    // unwinds — previously response.json() had no timeout and hung forever.
    mockFetch.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (signal?.aborted) return controller.error(abortError());
          signal?.addEventListener('abort', () => controller.error(abortError()), { once: true });
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    const adapter = new OpenAICompatibleAdapter();
    const events: StreamEvent[] = [];
    const chatPromise = adapter.chat(
      [userMessage],
      makeOptions({ baseUrl: 'http://localhost:11434/v1' }),
      (e) => events.push(e),
    );
    let settled = false;
    chatPromise.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(179_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    // code-review fix #10 regression: body-download hang timer now shares the
    // same helper as the connect-phase timers but must keep its own message.
    await expect(chatPromise).rejects.toMatchObject({
      code: 'network_error',
      retryable: true,
      retryAfterMs: 2000,
      message: '响应体读取超时：180 秒未完成',
    });
  });

  it('max_tokens retry re-arms the connect timeout instead of hanging (B4)', async () => {
    // First attempt → 400 "max_tokens too large" triggers a one-shot retry. The
    // retry then stalls before returning headers; the first attempt's connect
    // timer was already cleared, so the retry must arm its OWN timer and abort.
    let call = 0;
    mockFetch.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      call++;
      if (call === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { param: 'max_tokens', message: 'max_tokens supports at most 4096' } }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    });

    const adapter = new OpenAICompatibleAdapter();
    const events: StreamEvent[] = [];
    const chatPromise = adapter.chat([userMessage], makeOptions(), (e) => events.push(e));
    let settled = false;
    chatPromise.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(179_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    // code-review fix #10 regression: the retry-connect hang timer shares the
    // same helper/message as the first-attempt connect timer.
    await expect(chatPromise).rejects.toMatchObject({
      code: 'network_error',
      retryable: true,
      retryAfterMs: 2000,
      message: '连接超时：180 秒未收到服务器响应头',
    });
    expect(call).toBe(2); // the retry actually fired
  });
});

describe('toOpenAIToolChoice (pure helper)', () => {
  it('returns undefined when called with undefined', () => {
    expect(toOpenAIToolChoice(undefined)).toBeUndefined();
  });

  it("maps { type: 'auto' } → 'auto'", () => {
    const tc: ToolChoice = { type: 'auto' };
    expect(toOpenAIToolChoice(tc)).toBe('auto');
  });

  it("maps { type: 'any' } → 'required'", () => {
    const tc: ToolChoice = { type: 'any' };
    expect(toOpenAIToolChoice(tc)).toBe('required');
  });

  it("maps { type: 'tool', name: 'X' } → { type: 'function', function: { name: 'X' } }", () => {
    const tc: ToolChoice = { type: 'tool', name: 'X' };
    expect(toOpenAIToolChoice(tc)).toEqual({ type: 'function', function: { name: 'X' } });
  });
});

describe('OpenAICompatibleAdapter body wiring: tool_choice', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sets body.tool_choice when toolChoice is provided and tools are present', async () => {
    mockFetch.mockResolvedValueOnce(makeSSEResponse([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]));
    const adapter = new OpenAICompatibleAdapter();
    await adapter.chat([userMessage], makeOptions({ toolChoice: { type: 'any' } }), () => {});

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body.tool_choice).toBe('required');
  });

  it('omits body.tool_choice when toolChoice is not provided', async () => {
    mockFetch.mockResolvedValueOnce(makeSSEResponse([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]));
    const adapter = new OpenAICompatibleAdapter();
    await adapter.chat([userMessage], makeOptions(), () => {});

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body.tool_choice).toBeUndefined();
  });
});
