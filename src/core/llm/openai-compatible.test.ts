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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, StreamEvent, ToolDefinition } from '../../types';
import type { ChatOptions } from './adapter';

// Mock getTauriFetch BEFORE importing the adapter so the singleton picks up the mock.
const mockFetch = vi.fn();
vi.mock('./tauriFetch', () => ({
  getTauriFetch: () => Promise.resolve(mockFetch),
}));

// Import after mock is registered.
import { OpenAICompatibleAdapter } from './openai-compatible';

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
  });
});
