import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Tauri fetch before importing
vi.mock('./tauriFetch', () => ({
  getTauriFetch: vi.fn().mockResolvedValue(globalThis.fetch),
}));

// Mock Anthropic SDK — we control the stream behavior
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
    APIError: class MockAPIError extends Error {
      status: number;
      constructor(status: number, message: string) {
        super(message);
        this.status = status;
      }
    },
  };
});

import { ClaudeAdapter } from './claude';
import { LLMError } from './adapter';

// Filler timestamp (TESTING.md §3) — not asserted on below.
const FIXED_TIMESTAMP = 1_700_000_000_000;

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

describe('ClaudeAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('stream idle timeout', () => {
    it('aborts and throws a retryable error after the idle window with no data', async () => {
      // Stream hangs after creation until the request signal aborts, then rejects
      // (mirrors real SDK behavior — aborting the request cancels the iterator).
      // The heartbeat must abort the request so chat() can actually reject rather
      // than stay pending forever (emitting events alone would leave it hung).
      mockCreate.mockImplementation((_params: unknown, options?: { signal?: AbortSignal }) => {
        const signal = options?.signal;
        const stream = {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise((_resolve, reject) => {
              if (signal?.aborted) return reject(abortError());
              signal?.addEventListener('abort', () => reject(abortError()), { once: true });
              // otherwise hang forever (no data)
            }),
          }),
        };
        return Promise.resolve(stream);
      });

      const events: Array<{ type: string; error?: string; stopReason?: string }> = [];
      const adapter = new ClaudeAdapter();

      const chatPromise = adapter.chat(
        [{ role: 'user', content: 'hello', id: '1', timestamp: FIXED_TIMESTAMP }],
        { apiKey: 'test-key', model: 'claude-sonnet-4-6', maxTokens: 1024 },
        (event) => events.push(event),
      );
      // Attach a handler so the eventual rejection isn't flagged as unhandled,
      // and track settle state to assert the timeout hasn't fired prematurely.
      let settled = false;
      chatPromise.then(() => { settled = true; }, () => { settled = true; });

      // Enter the for-await loop (create resolves, heartbeat arms)
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toHaveLength(0);

      // 179s — should NOT have timed out yet (idle window is 180s)
      await vi.advanceTimersByTimeAsync(179_000);
      expect(settled).toBe(false);

      // Past 180s — heartbeat aborts the request, chat() rejects with retryable error
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(chatPromise).rejects.toMatchObject({
        code: 'network_error',
        retryable: true,
      });
      // No error/done events emitted — the failure flows through the thrown error
      expect(events.find((e) => e.type === 'done')).toBeUndefined();
      await expect(chatPromise).rejects.toBeInstanceOf(LLMError);
    });
  });

  describe('tool_use input parsing', () => {
    it('emits input {} (not _parse_error) for a no-argument tool call', async () => {
      // A tool with no parameters streams a tool_use block with no
      // input_json_delta, so the accumulated input string is empty. That must
      // become {} — not a _parse_error from JSON.parse('') that would stop the
      // tool from executing and log a bogus disk error.
      vi.useRealTimers();
      mockCreate.mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          yield { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_time' } };
          yield { type: 'content_block_stop' };
          yield { type: 'message_stop' };
        },
      });

      const events: Array<{ type: string; input?: Record<string, unknown> }> = [];
      const adapter = new ClaudeAdapter();
      await adapter.chat(
        [{ role: 'user', content: 'what time is it', id: '1', timestamp: FIXED_TIMESTAMP }],
        { apiKey: 'test-key', model: 'claude-sonnet-4-6', maxTokens: 1024 },
        (event) => events.push(event as { type: string; input?: Record<string, unknown> }),
      );

      const tu = events.find((e) => e.type === 'tool_use');
      expect(tu).toBeDefined();
      expect(tu?.input).toEqual({});
      expect(tu?.input && '_parse_error' in tu.input).toBe(false);
    });
  });

  describe('prompt cache breakpoints', () => {
    type CapturedParams = {
      system?: Array<{ text: string; cache_control?: { type: string } }>;
      tools?: Array<{ cache_control?: { type: string } }>;
      messages: Array<{
        role: string;
        content: string | Array<Record<string, unknown>>;
      }>;
    };

    async function chatAndCapture(
      messages: Array<{ role: 'user' | 'assistant'; content: string; id: string; timestamp: number }>,
      extraOptions: Record<string, unknown> = {},
    ): Promise<CapturedParams> {
      vi.useRealTimers();
      mockCreate.mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          yield { type: 'message_stop' };
        },
      });
      const adapter = new ClaudeAdapter();
      await adapter.chat(
        messages,
        { apiKey: 'test-key', model: 'claude-sonnet-4-6', maxTokens: 1024, ...extraOptions },
        () => {},
      );
      return mockCreate.mock.calls[0][0] as CapturedParams;
    }

    function countBreakpoints(params: CapturedParams): number {
      let n = 0;
      for (const b of params.system ?? []) if (b.cache_control) n++;
      for (const t of params.tools ?? []) if (t.cache_control) n++;
      for (const m of params.messages) {
        if (Array.isArray(m.content)) {
          for (const block of m.content) if (block.cache_control) n++;
        }
      }
      return n;
    }

    it('places the system breakpoint on the last cacheable section and none on volatile sections', async () => {
      const params = await chatAndCapture(
        [{ role: 'user', content: 'hi', id: '1', timestamp: FIXED_TIMESTAMP }],
        {
          systemPromptSections: [
            { name: 'persona', text: 'persona text', cacheable: true },
            { name: 'safety', text: 'safety text', cacheable: true },
            { name: 'current-time', text: 'time text', cacheable: false },
          ],
        },
      );
      expect(params.system).toHaveLength(3);
      expect(params.system![0].cache_control).toBeUndefined();
      expect(params.system![1].cache_control).toEqual({ type: 'ephemeral' });
      expect(params.system![2].cache_control).toBeUndefined();
    });

    it('marks the last block of the last message as an incremental history breakpoint', async () => {
      const params = await chatAndCapture([
        { role: 'user', content: 'first question', id: '1', timestamp: FIXED_TIMESTAMP },
        { role: 'assistant', content: 'first answer', id: '2', timestamp: FIXED_TIMESTAMP },
        { role: 'user', content: 'second question', id: '3', timestamp: FIXED_TIMESTAMP },
      ]);
      const last = params.messages[params.messages.length - 1];
      expect(Array.isArray(last.content)).toBe(true);
      const blocks = last.content as Array<Record<string, unknown>>;
      expect(blocks[blocks.length - 1].cache_control).toEqual({ type: 'ephemeral' });
      // Only the final message carries the history breakpoint
      for (const m of params.messages.slice(0, -1)) {
        if (Array.isArray(m.content)) {
          for (const block of m.content) expect(block.cache_control).toBeUndefined();
        }
      }
    });

    it('appends the volatile context tail AFTER the history breakpoint, uncached', async () => {
      const params = await chatAndCapture(
        [
          { role: 'user', content: 'question', id: '1', timestamp: FIXED_TIMESTAMP },
          { role: 'assistant', content: 'answer', id: '2', timestamp: FIXED_TIMESTAMP },
          { role: 'user', content: 'follow-up', id: '3', timestamp: FIXED_TIMESTAMP },
        ],
        { volatileContextTail: '<runtime-context>\ntodos here\n</runtime-context>' },
      );
      const last = params.messages[params.messages.length - 1];
      const lastBlocks = last.content as Array<Record<string, unknown>>;
      // Tail is the final user message and carries NO cache_control — the
      // history breakpoint must sit on the last STORED message so the cached
      // prefix is not keyed to per-turn bytes.
      expect(last.role).toBe('user');
      expect(String(lastBlocks[0].text)).toContain('todos here');
      expect(lastBlocks[0].cache_control).toBeUndefined();
      const stored = params.messages[params.messages.length - 2];
      const storedBlocks = stored.content as Array<Record<string, unknown>>;
      expect(storedBlocks[storedBlocks.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('never exceeds the 4-breakpoint API limit (tools + system + history)', async () => {
      const params = await chatAndCapture(
        [
          { role: 'user', content: 'q1', id: '1', timestamp: FIXED_TIMESTAMP },
          { role: 'assistant', content: 'a1', id: '2', timestamp: FIXED_TIMESTAMP },
          { role: 'user', content: 'q2', id: '3', timestamp: FIXED_TIMESTAMP },
        ],
        {
          systemPromptSections: [
            { name: 'persona', text: 'persona', cacheable: true },
            { name: 'time', text: 'time', cacheable: false },
          ],
          tools: [
            { name: 'tool_a', description: 'a', inputSchema: { type: 'object', properties: {} } },
            { name: 'tool_b', description: 'b', inputSchema: { type: 'object', properties: {} } },
          ],
        },
      );
      const count = countBreakpoints(params);
      expect(count).toBeGreaterThanOrEqual(3); // tools + system + history all marked
      expect(count).toBeLessThanOrEqual(4);
    });
  });
});
