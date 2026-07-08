import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '@/types';

// ── Mock chatStore ──
// Must be hoisted-compatible: use plain const objects since they start with "mock"

const mockConversations: Record<string, { messages: Message[] }> = {};
const mockAddMessage = vi.fn();
const mockClearContextCache = vi.fn();
const mockSetIsCompressing = vi.fn();

vi.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      conversations: mockConversations,
      addMessage: mockAddMessage,
      clearContextCache: mockClearContextCache,
      setIsCompressing: mockSetIsCompressing,
    }),
  },
}));

// ── Mock settingsStore ──

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({}) },
  getActiveProvider: vi.fn().mockReturnValue({ apiFormat: 'anthropic-compatible', baseUrl: undefined }),
  getActiveApiKey: vi.fn().mockReturnValue('test-api-key'),
  getEffectiveModel: vi.fn().mockReturnValue('claude-haiku-4-5'),
}));

// ── Mock enterprise llm-resolver ──

vi.mock('@/core/enterprise/llm-resolver', () => ({
  resolveEffectiveLlmCreds: vi.fn().mockReturnValue({
    apiKey: 'resolved-api-key',
    baseUrl: undefined,
    forceOpenAiCompatible: false,
  }),
}));

// ── Mock LLM adapters (just need constructors to not throw) ──

vi.mock('@/core/llm/claude', () => ({
  ClaudeAdapter: vi.fn().mockImplementation(function () { return { chat: vi.fn() }; }),
}));

vi.mock('@/core/llm/openai-compatible', () => ({
  OpenAICompatibleAdapter: vi.fn().mockImplementation(function () { return { chat: vi.fn() }; }),
}));

// ── Mock contextCompressor (whole module) ──
// Use a module-level vi.fn so we can spy on it from tests.

vi.mock('@/core/context/contextCompressor', () => ({
  summarizeConversation: vi.fn(),
}));

// ── Import after all mocks ──

import * as contextCompressor from '@/core/context/contextCompressor';
import { compactConversationManually } from './compactionService';
import { isCompactBoundary } from './compactBoundary';

// Convenient alias
const mockSummarize = contextCompressor.summarizeConversation as ReturnType<typeof vi.fn>;

// ── Helpers ──

let _seq = 0;

function makeMsg(role: 'user' | 'assistant'): Message {
  _seq++;
  return {
    id: `msg-${_seq}`,
    role,
    content: `content-${_seq}`,
    timestamp: 1000 * _seq,
  };
}

/** Build N user+assistant round pairs (2N messages). Need > 5 rounds for a non-null plan. */
function buildRounds(count: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    messages.push(makeMsg('user'));
    messages.push(makeMsg('assistant'));
  }
  return messages;
}

const CONV_ID = 'test-conv-123';

beforeEach(() => {
  _seq = 0;
  vi.mocked(contextCompressor.summarizeConversation).mockReset();
  mockAddMessage.mockReset();
  mockClearContextCache.mockReset();
  mockSetIsCompressing.mockReset();
  for (const key of Object.keys(mockConversations)) {
    delete mockConversations[key];
  }
});

// ── Tests ──

describe('compactConversationManually', () => {
  describe('no-conversation', () => {
    it('returns no-conversation when convId is absent from store', async () => {
      const result = await compactConversationManually(CONV_ID);
      expect(result).toEqual({ compacted: false, reason: 'no-conversation' });
    });

    it('returns no-conversation for empty string convId', async () => {
      const result = await compactConversationManually('');
      expect(result).toEqual({ compacted: false, reason: 'no-conversation' });
    });
  });

  describe('too-few', () => {
    it('returns too-few when conversation has fewer rounds than threshold', async () => {
      mockConversations[CONV_ID] = { messages: buildRounds(2) };
      const result = await compactConversationManually(CONV_ID);
      expect(result).toEqual({ compacted: false, reason: 'too-few' });
      expect(mockSummarize).not.toHaveBeenCalled();
    });

    it('returns too-few for empty messages array', async () => {
      mockConversations[CONV_ID] = { messages: [] };
      const result = await compactConversationManually(CONV_ID);
      expect(result).toEqual({ compacted: false, reason: 'too-few' });
    });
  });

  describe('summarize-failed', () => {
    it('returns summarize-failed when summarizeConversation throws', async () => {
      mockConversations[CONV_ID] = { messages: buildRounds(6) };
      vi.mocked(contextCompressor.summarizeConversation).mockRejectedValueOnce(new Error('network error'));

      const result = await compactConversationManually(CONV_ID);
      expect(result).toEqual({ compacted: false, reason: 'summarize-failed' });
      expect(mockAddMessage).not.toHaveBeenCalled();
    });

    it('returns summarize-failed when summary is empty string', async () => {
      mockConversations[CONV_ID] = { messages: buildRounds(6) };
      vi.mocked(contextCompressor.summarizeConversation).mockResolvedValueOnce('');

      const result = await compactConversationManually(CONV_ID);
      expect(result).toEqual({ compacted: false, reason: 'summarize-failed' });
      expect(mockAddMessage).not.toHaveBeenCalled();
    });

    it('returns summarize-failed when summary is whitespace only', async () => {
      mockConversations[CONV_ID] = { messages: buildRounds(6) };
      vi.mocked(contextCompressor.summarizeConversation).mockResolvedValueOnce('   ');

      const result = await compactConversationManually(CONV_ID);
      expect(result).toEqual({ compacted: false, reason: 'summarize-failed' });
      expect(mockAddMessage).not.toHaveBeenCalled();
    });
  });

  describe('successful compaction', () => {
    it('returns compacted:true and reason:ok on success', async () => {
      mockConversations[CONV_ID] = { messages: buildRounds(6) };
      vi.mocked(contextCompressor.summarizeConversation).mockResolvedValueOnce('Summary of the conversation.');

      const result = await compactConversationManually(CONV_ID);
      expect(result).toEqual({ compacted: true, reason: 'ok' });
    });

    it('calls addMessage with a compact boundary marker', async () => {
      mockConversations[CONV_ID] = { messages: buildRounds(6) };
      vi.mocked(contextCompressor.summarizeConversation).mockResolvedValueOnce('A fine summary.');

      await compactConversationManually(CONV_ID);

      expect(mockAddMessage).toHaveBeenCalledOnce();
      const [calledConvId, calledMarker] = mockAddMessage.mock.calls[0] as [string, Message];
      expect(calledConvId).toBe(CONV_ID);
      expect(isCompactBoundary(calledMarker)).toBe(true);
    });

    it('marker has source === "manual"', async () => {
      mockConversations[CONV_ID] = { messages: buildRounds(6) };
      vi.mocked(contextCompressor.summarizeConversation).mockResolvedValueOnce('manual summary');

      await compactConversationManually(CONV_ID);

      const [, marker] = mockAddMessage.mock.calls[0] as [string, Message];
      expect(marker.compactBoundary?.source).toBe('manual');
    });

    it('marker summaryText matches trimmed LLM output', async () => {
      mockConversations[CONV_ID] = { messages: buildRounds(6) };
      vi.mocked(contextCompressor.summarizeConversation).mockResolvedValueOnce('  The actual summary.  ');

      await compactConversationManually(CONV_ID);

      const [, marker] = mockAddMessage.mock.calls[0] as [string, Message];
      expect(marker.compactBoundary?.summaryText).toBe('The actual summary.');
    });

    it('calls clearContextCache with the correct convId', async () => {
      mockConversations[CONV_ID] = { messages: buildRounds(6) };
      vi.mocked(contextCompressor.summarizeConversation).mockResolvedValueOnce('summary');

      await compactConversationManually(CONV_ID);

      expect(mockClearContextCache).toHaveBeenCalledOnce();
      expect(mockClearContextCache).toHaveBeenCalledWith(CONV_ID);
    });

    it('clearContextCache is called AFTER addMessage', async () => {
      const callOrder: string[] = [];
      mockAddMessage.mockImplementation(function () { callOrder.push('addMessage'); });
      mockClearContextCache.mockImplementation(function () { callOrder.push('clearContextCache'); });

      mockConversations[CONV_ID] = { messages: buildRounds(6) };
      vi.mocked(contextCompressor.summarizeConversation).mockResolvedValueOnce('summary');

      await compactConversationManually(CONV_ID);

      expect(callOrder).toEqual(['addMessage', 'clearContextCache']);
    });

    it('toggles the in-progress indicator: setIsCompressing(true) before, (false) after', async () => {
      const order: string[] = [];
      mockSetIsCompressing.mockImplementation((_id: string, v: boolean) => order.push(`compressing:${v}`));
      vi.mocked(contextCompressor.summarizeConversation).mockImplementation(async () => {
        order.push('summarize');
        return 'summary';
      });
      mockConversations[CONV_ID] = { messages: buildRounds(6) };

      await compactConversationManually(CONV_ID);

      expect(order).toEqual(['compressing:true', 'summarize', 'compressing:false']);
    });

    it('resets the in-progress indicator even when summarize throws', async () => {
      mockConversations[CONV_ID] = { messages: buildRounds(6) };
      vi.mocked(contextCompressor.summarizeConversation).mockRejectedValueOnce(new Error('boom'));

      const result = await compactConversationManually(CONV_ID);

      expect(result.reason).toBe('summarize-failed');
      expect(mockSetIsCompressing).toHaveBeenLastCalledWith(CONV_ID, false);
    });
  });
});
