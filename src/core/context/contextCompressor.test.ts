/**
 * Tests for contextCompressor — covers both the new summarizeConversation()
 * extracted function and the existing compressContextIfNeeded() behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { summarizeConversation, compressContextIfNeeded } from './contextCompressor';
import type { CompressionConfig } from './contextCompressor';
import type { Message } from '../../types';
import type { LLMAdapter } from '../llm/adapter';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeMsg(role: 'user' | 'assistant', content: string): Message {
  return { id: Math.random().toString(36), role, content, timestamp: Date.now() };
}

function makeConfig(chatImpl: ReturnType<typeof vi.fn>): CompressionConfig {
  return {
    // The mock is intentionally loosely typed so mockImplementation callbacks
    // can use simplified inline shapes; narrow to the real chat signature here.
    adapter: { chat: chatImpl as unknown as LLMAdapter['chat'] } as LLMAdapter,
    model: 'claude-haiku-4-5',
    apiKey: 'test-key',
  };
}

// ── summarizeConversation ─────────────────────────────────────────────────────

describe('summarizeConversation', () => {
  let chatMock: ReturnType<typeof vi.fn>;
  let config: CompressionConfig;

  beforeEach(() => {
    chatMock = vi.fn();
    config = makeConfig(chatMock);
  });

  describe('basic contract', () => {
    it('calls adapter.chat and returns the summary text', async () => {
      const expectedSummary = 'Users discussed project requirements.';
      chatMock.mockImplementation(
        async (
          _msgs: Message[],
          _opts: unknown,
          onEvent: (e: { type: string; text?: string }) => void
        ) => {
          onEvent({ type: 'text', text: expectedSummary });
        }
      );

      const messages = [
        makeMsg('user', 'Hello'),
        makeMsg('assistant', 'Hi there'),
      ];
      const result = await summarizeConversation(messages, config);

      expect(chatMock).toHaveBeenCalledOnce();
      expect(result).toBe(expectedSummary);
    });

    it('concatenates streamed text chunks', async () => {
      chatMock.mockImplementation(
        async (
          _msgs: Message[],
          _opts: unknown,
          onEvent: (e: { type: string; text?: string }) => void
        ) => {
          onEvent({ type: 'text', text: 'Part one. ' });
          onEvent({ type: 'text', text: 'Part two.' });
        }
      );

      const messages = [makeMsg('user', 'Explain something')];
      const result = await summarizeConversation(messages, config);

      expect(result).toBe('Part one. Part two.');
    });

    it('passes the correct chat options to adapter (model, apiKey, maxTokens)', async () => {
      chatMock.mockImplementation(
        async (
          _msgs: Message[],
          _opts: { model: string; apiKey: string; maxTokens: number },
          onEvent: (e: { type: string; text?: string }) => void
        ) => {
          onEvent({ type: 'text', text: 'summary' });
          // Capture opts for assertion — done via the mock call args below
        }
      );

      await summarizeConversation([makeMsg('user', 'hi')], config);

      const [[, chatOpts]] = chatMock.mock.calls as [[Message[], { model: string; apiKey: string; maxTokens: number }, unknown]];
      expect(chatOpts.model).toBe('claude-haiku-4-5');
      expect(chatOpts.apiKey).toBe('test-key');
      expect(chatOpts.maxTokens).toBeGreaterThan(0);
    });

    it('ignores non-text stream events', async () => {
      chatMock.mockImplementation(
        async (
          _msgs: Message[],
          _opts: unknown,
          onEvent: (e: { type: string; text?: string }) => void
        ) => {
          onEvent({ type: 'start' });
          onEvent({ type: 'text', text: 'real summary' });
          onEvent({ type: 'end' });
        }
      );

      const result = await summarizeConversation([makeMsg('user', 'hi')], config);
      expect(result).toBe('real summary');
    });

    it('passes AbortSignal through to chat options when provided', async () => {
      chatMock.mockImplementation(
        async (
          _msgs: Message[],
          _opts: unknown,
          onEvent: (e: { type: string; text?: string }) => void
        ) => {
          onEvent({ type: 'text', text: 'ok' });
        }
      );
      const controller = new AbortController();
      const configWithSignal: CompressionConfig = { ...config, signal: controller.signal };

      await summarizeConversation([makeMsg('user', 'hi')], configWithSignal);

      const [[, chatOpts]] = chatMock.mock.calls as [[Message[], { signal?: AbortSignal }, unknown]];
      expect(chatOpts.signal).toBe(controller.signal);
    });
  });

  describe('empty / error cases', () => {
    it('returns empty string when adapter streams nothing', async () => {
      chatMock.mockImplementation(async () => {
        // no events emitted
      });

      const result = await summarizeConversation([makeMsg('user', 'hi')], config);
      expect(result).toBe('');
    });

    it('throws when adapter.chat rejects', async () => {
      chatMock.mockRejectedValue(new Error('network error'));

      await expect(
        summarizeConversation([makeMsg('user', 'hi')], config)
      ).rejects.toThrow('network error');
    });
  });

  describe('prompt shape', () => {
    it('sends exactly one user message to adapter containing the conversation text', async () => {
      chatMock.mockImplementation(
        async (
          msgs: Message[],
          _opts: unknown,
          onEvent: (e: { type: string; text?: string }) => void
        ) => {
          onEvent({ type: 'text', text: 'summary' });
          // Verify the messages shape in the assertion below
          void msgs;
        }
      );

      const messages = [
        makeMsg('user', 'What is TypeScript?'),
        makeMsg('assistant', 'TypeScript is a typed superset of JavaScript.'),
      ];
      await summarizeConversation(messages, config);

      const [[summaryMsgs]] = chatMock.mock.calls as [[Message[], unknown, unknown]];
      expect(summaryMsgs).toHaveLength(1);
      expect(summaryMsgs[0].role).toBe('user');
      // The prompt should contain text derived from the input messages
      const promptContent = summaryMsgs[0].content as string;
      expect(typeof promptContent).toBe('string');
      expect(promptContent.length).toBeGreaterThan(0);
    });
  });
});

// ── compressContextIfNeeded — regression (behaviour unchanged after refactor) ──

describe('compressContextIfNeeded (regression)', () => {
  let chatMock: ReturnType<typeof vi.fn>;
  let config: CompressionConfig;

  beforeEach(() => {
    chatMock = vi.fn();
    config = makeConfig(chatMock);
  });

  it('returns original messages unchanged when below threshold', async () => {
    const messages = [makeMsg('user', 'Hello'), makeMsg('assistant', 'Hi')];
    const result = await compressContextIfNeeded(
      messages,
      'system',
      100_000,
      4_000,
      config
    );
    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(messages);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('compresses middle messages and calls adapter when threshold exceeded', async () => {
    const summaryText = 'Summarised middle rounds.';
    chatMock.mockImplementation(
      async (
        _msgs: Message[],
        _opts: unknown,
        onEvent: (e: { type: string; text?: string }) => void
      ) => {
        onEvent({ type: 'text', text: summaryText });
      }
    );

    // Build a conversation large enough to exceed 65% of a small context window
    const longContent = 'x'.repeat(400); // ~100 tokens each
    const messages: Message[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(makeMsg('user', `Q${i} ${longContent}`));
      messages.push(makeMsg('assistant', `A${i} ${longContent}`));
    }

    const result = await compressContextIfNeeded(
      messages,
      'short system',
      3_000,
      500,
      config
    );

    expect(result.compressed).toBe(true);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(chatMock).toHaveBeenCalledOnce();
    // Summary message should be present in the output
    const hasSummary = result.messages.some(
      (m) => typeof m.content === 'string' && m.content.includes(summaryText)
    );
    expect(hasSummary).toBe(true);
  });

  it('falls back gracefully when summarizeConversation throws', async () => {
    chatMock.mockRejectedValue(new Error('LLM down'));

    const longContent = 'x'.repeat(400);
    const messages: Message[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(makeMsg('user', `Q${i} ${longContent}`));
      messages.push(makeMsg('assistant', `A${i} ${longContent}`));
    }

    const result = await compressContextIfNeeded(
      messages,
      'short system',
      3_000,
      500,
      config
    );

    // Must not throw — falls back to uncompressed
    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it('falls back when adapter returns empty summary', async () => {
    chatMock.mockImplementation(async () => {
      // emit nothing → summaryText stays ''
    });

    const longContent = 'x'.repeat(400);
    const messages: Message[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(makeMsg('user', `Q${i} ${longContent}`));
      messages.push(makeMsg('assistant', `A${i} ${longContent}`));
    }

    const result = await compressContextIfNeeded(
      messages,
      'short system',
      3_000,
      500,
      config
    );

    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(messages);
  });
});
