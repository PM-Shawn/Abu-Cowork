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
        [{ role: 'user', content: 'hello', id: '1', timestamp: Date.now() }],
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
});
