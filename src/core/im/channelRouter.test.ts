/**
 * IMChannelRouter Tests
 *
 * Tests the core processMessage pipeline: session → thinking → agent → reply → error handling.
 * Uses mocks for all external dependencies (stores, agentLoop, streamingReply).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NormalizedIMMessage } from './inboundRouter';
import type { IMChannel } from '@/types/imChannel';
import type { IMAdapter } from './adapters/types';
import { matchesToolName } from '../skill/toolFilter';

// Deterministic filler timestamp (TESTING.md §3) — used where a numeric
// timestamp field is structurally required but its exact value is never
// asserted on.
const FIXED_TIMESTAMP = 1_700_000_000_000;

const typingMocks = vi.hoisted(() => ({
  sendTyping: vi.fn(),
  warn: vi.fn(),
  adapter: {
    config: { platform: 'dingtalk', supportsMessageUpdate: false },
  } as {
    config: { platform: string; supportsMessageUpdate: boolean };
    sendTyping?: ReturnType<typeof vi.fn>;
  },
}));

// ── Mocks ──

const mockSessions: Record<string, unknown> = {};
const mockChannels: Record<string, unknown> = {};
const mockSetChannelStatus = vi.fn();
vi.mock('../../stores/imChannelStore', () => ({
  useIMChannelStore: {
    getState: () => ({
      channels: mockChannels,
      sessions: mockSessions,
      upsertSession: vi.fn((key: string, session: unknown) => { mockSessions[key] = session; }),
      removeSession: vi.fn((key: string) => { delete mockSessions[key]; }),
      incrementSessionRound: vi.fn(),
      getChannelsByPlatform: vi.fn((platform: string) =>
        Object.values(mockChannels).filter((c) => (c as { platform: string }).platform === platform),
      ),
      setChannelStatus: mockSetChannelStatus,
    }),
  },
}));

const mockConversations: Record<string, { messages: { role: string; content: string }[] }> = {};
// Deterministic id source (TESTING.md §3) — a monotonic counter guarantees each
// createConversation() call gets a distinct id, which real Date.now() only did
// incidentally (two calls within the same millisecond would have collided).
let mockConvIdCounter = 0;
vi.mock('../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      conversations: mockConversations,
      createConversation: vi.fn(() => {
        const id = 'conv-' + (++mockConvIdCounter);
        mockConversations[id] = { messages: [] };
        return id;
      }),
      renameConversation: vi.fn(),
      // Router hydrates the conversation before dispatching (lazily-loaded
      // conversations are evicted from memory; see channelRouter step 1a).
      loadConversation: vi.fn(async () => {}),
      addMessage: vi.fn((convId: string, msg: { role: string; content: string }) => {
        if (mockConversations[convId]) mockConversations[convId].messages.push(msg);
      }),
    }),
  },
}));

const mockRunAgentLoop = vi.fn();
vi.mock('../agent/agentLoop', () => ({
  runAgentLoop: (...args: unknown[]) => mockRunAgentLoop(...args),
}));

const mockSendThinking = vi.fn();
const mockSendFinal = vi.fn();
vi.mock('./streamingReply', () => ({
  sendThinking: (...args: unknown[]) => mockSendThinking(...args),
  sendFinal: (...args: unknown[]) => mockSendFinal(...args),
}));

vi.mock('../logging/logger', () => ({
  createLogger: () => ({ warn: typingMocks.warn }),
}));

// Partial mock: `getBlockedToolsForLevel` is deliberately REAL so this file
// pins what the router actually forwards to the agent run per tier — a
// hand-written stub here would let the tier ceiling regress unnoticed.
vi.mock('./authGate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./authGate')>()),
  resolveCapability: vi.fn((_userId: string, _channel: unknown) => ({
    allowed: true,
    capability: 'safe_tools',
  })),
  getCallbacksForLevel: vi.fn(() => ({
    commandConfirmCallback: undefined,
    filePermissionCallback: undefined,
  })),
}));

vi.mock('./sessionMapper', () => {
  let convCounter = 0;
  return {
    sessionMapper: {
      resolve: vi.fn((_msg: unknown, _ch: unknown, _cap: unknown) => {
        const convId = `conv-session-${++convCounter}`;
        mockConversations[convId] = { messages: [] };
        return {
          session: {
            key: 'test:chat1:window',
            channelId: 'ch1',
            conversationId: convId,
            lastActiveAt: FIXED_TIMESTAMP,
            messageCount: 1,
            userId: 'u1',
            userName: '张三',
            capability: 'safe_tools',
            platform: 'dingtalk',
            chatId: 'chat1',
          },
          isNew: true,
          isRecovered: false,
        };
      }),
      peekSessionKey: vi.fn(() => 'test:chat1:window'),
      cleanup: vi.fn(),
    },
  };
});

vi.mock('./inboundRouter', () => ({
  parseInboundMessage: vi.fn(() => null),
}));

vi.mock('./outputSender', () => ({
  outputSender: {},
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Needed for handleMessage → processMessage → dynamic adapter import.
// Returning supportsMessageUpdate: false forces the non-reaction path which
// calls sendThinking directly (observable from tests).
vi.mock('./adapters/registry', () => ({
  getAdapter: vi.fn(() => typingMocks.adapter),
}));

// i18n — processMessage calls getI18n() on certain branches; give it
// an empty surface so access to .imChannel.* doesn't explode.
vi.mock('@/i18n', () => ({
  getI18n: () => ({
    imChannel: {
      sessionResetConfirm: '',
      sessionRecovered: '',
      sessionExpiredHint: '',
      sessionQueueFull: '',
      errorReply: 'Abu 处理出错: {error}',
    },
  }),
  format: (t: string, v: Record<string, string>) => {
    let out = t;
    for (const [k, val] of Object.entries(v)) out = out.replace(`{${k}}`, val);
    return out;
  },
}));

// ── Import after mocks ──

import { imChannelRouter } from './channelRouter';

// Access private methods via type cast for testing
type RouterInternal = {
  processMessage(msg: NormalizedIMMessage, channel: IMChannel, capability: string): Promise<void>;
  dispatchMessage(msg: NormalizedIMMessage): void;
  runWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T>;
  runningCount: number;
  activeSessions: Set<string>;
  recentMessageIds: Map<string, number>;
  pendingMedia: Map<string, { message: NormalizedIMMessage; timer: ReturnType<typeof setTimeout> }>;
  typingOperations: Map<string, Promise<void>>;
  activeTypingStops: Set<() => void>;
  startTypingHeartbeat(adapter: IMAdapter, token: string, userId: string): () => void;
  stop(): void;
};

function getInternal(): RouterInternal {
  return imChannelRouter as unknown as RouterInternal;
}

async function drainTypingOperations(): Promise<void> {
  await Promise.all([...getInternal().typingOperations.values()]);
}

function makeChannel(overrides: Partial<IMChannel> = {}): IMChannel {
  return {
    id: 'ch1', platform: 'dingtalk', name: 'Test', enabled: true,
    appId: 'a', appSecret: 's', capability: 'safe_tools',
    responseMode: 'mention_only',
    allowedUsers: [], workspacePaths: [], sessionTimeoutMinutes: 30,
    maxRoundsPerSession: 50, status: 'connected',
    createdAt: FIXED_TIMESTAMP, updatedAt: FIXED_TIMESTAMP,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<NormalizedIMMessage> = {}): NormalizedIMMessage {
  return {
    senderId: 'u1', senderName: '张三', text: 'hello',
    isMention: true, isDirect: false, chatId: 'chat1',
    platform: 'dingtalk',
    replyContext: { platform: 'dingtalk', sessionWebhook: 'https://hook.example.com' },
    raw: {},
    ...overrides,
  };
}

describe('IMChannelRouter', () => {
  beforeEach(() => {
    mockRunAgentLoop.mockReset();
    mockSendThinking.mockReset();
    mockSendFinal.mockReset();
    mockSendThinking.mockResolvedValue({ platform: 'dingtalk', supportsUpdate: false, replyContext: {} });
    mockSendFinal.mockResolvedValue({ success: true });
    typingMocks.sendTyping.mockReset();
    typingMocks.sendTyping.mockResolvedValue(undefined);
    typingMocks.warn.mockReset();
    typingMocks.adapter = {
      config: { platform: 'dingtalk', supportsMessageUpdate: false },
    };
    // Reset runningCount and session tracking
    getInternal().runningCount = 0;
    getInternal().activeSessions.clear();
    getInternal().recentMessageIds.clear();
    getInternal().typingOperations.clear();
    for (const { timer } of getInternal().pendingMedia.values()) clearTimeout(timer);
    getInternal().pendingMedia.clear();
  });

  afterEach(async () => {
    for (const stopTyping of [...getInternal().activeTypingStops]) stopTyping();
    await drainTypingOperations();
  });

  describe('photo + caption coalescing', () => {
    // IM clients can't send an image and its text together, so a photo and the
    // caption that follows arrive as two messages. Treating them as two turns
    // made the agent answer the photo with no question, then answer the question
    // with no photo ("I didn't get an image this turn").
    const img = { id: 'i1', data: 'AAAA', mediaType: 'image/jpeg' as const };

    beforeEach(() => {
      // dispatchMessage (unlike processMessage) resolves the channel from the
      // store, so the platform needs a registered enabled channel.
      mockChannels['ch1'] = makeChannel({ responseMode: 'all_messages' });
    });
    afterEach(() => { delete mockChannels['ch1']; });

    it('holds an image-only message instead of dispatching it immediately', () => {
      getInternal().dispatchMessage(makeMessage({
        text: '', images: [img], replyContext: { platform: 'dingtalk', messageId: 'm1' },
      }));

      expect(mockRunAgentLoop).not.toHaveBeenCalled();
      expect(getInternal().pendingMedia.size).toBe(1);
    });

    it('merges the caption into the buffered photo and runs one turn', async () => {
      getInternal().dispatchMessage(makeMessage({
        text: '', images: [img], replyContext: { platform: 'dingtalk', messageId: 'm1' },
      }));
      getInternal().dispatchMessage(makeMessage({
        text: '看看这张图是啥', replyContext: { platform: 'dingtalk', messageId: 'm2' },
      }));
      await vi.waitFor(() => expect(mockRunAgentLoop).toHaveBeenCalledTimes(1));

      // one run, carrying BOTH the caption text and the photo
      expect(mockRunAgentLoop.mock.calls[0][1]).toContain('看看这张图是啥');
      expect(mockRunAgentLoop.mock.calls[0][2].images).toHaveLength(1);
      expect(getInternal().pendingMedia.size).toBe(0);
    });

    it('coalesces a FILE message with its caption too, keeping the local path', async () => {
      // A file arrives as text-only ("[文件: x, 路径: /tmp/x]") with no images,
      // so the image-only check missed it and files still split into two turns.
      getInternal().dispatchMessage(makeMessage({
        text: '[文件: 2026-08-22.log, 路径: /tmp/wechat-1.log]',
        replyContext: { platform: 'dingtalk', messageId: 'f1' },
      }));
      expect(mockRunAgentLoop).not.toHaveBeenCalled();

      getInternal().dispatchMessage(makeMessage({
        text: '这个是啥', replyContext: { platform: 'dingtalk', messageId: 'f2' },
      }));
      await vi.waitFor(() => expect(mockRunAgentLoop).toHaveBeenCalledTimes(1));

      const sent = mockRunAgentLoop.mock.calls[0][1];
      expect(sent).toContain('/tmp/wechat-1.log'); // path survives the merge
      expect(sent).toContain('这个是啥');
    });

    it('dispatches a lone photo once the wait elapses', async () => {
      vi.useFakeTimers();
      try {
        getInternal().dispatchMessage(makeMessage({
          text: '', images: [img], replyContext: { platform: 'dingtalk', messageId: 'm3' },
        }));
        expect(mockRunAgentLoop).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(16_000); // past MEDIA_COALESCE_MS
      } finally {
        vi.useRealTimers();
      }
      await vi.waitFor(() => expect(mockRunAgentLoop).toHaveBeenCalledTimes(1));
      expect(mockRunAgentLoop.mock.calls[0][2].images).toHaveLength(1);
    });
  });

  it('processes message through full pipeline', async () => {
    const channel = makeChannel();
    const message = makeMessage();

    // Agent succeeds, and we plant a reply in the conversation
    mockRunAgentLoop.mockImplementation(async (convId: string) => {
      if (mockConversations[convId]) {
        mockConversations[convId].messages.push({ role: 'assistant', content: 'AI reply' });
      }
      return { reason: 'completed' };
    });

    await getInternal().processMessage(message, channel, 'safe_tools');

    expect(mockSendThinking).toHaveBeenCalledOnce();
    expect(mockRunAgentLoop).toHaveBeenCalledOnce();
    expect(mockSendFinal).toHaveBeenCalledOnce();
    expect(mockSendFinal.mock.calls[0][1].content).toBe('AI reply');
    expect(typingMocks.sendTyping).not.toHaveBeenCalled();
  });

  it('refreshes WeChat typing every 5 seconds and stops without leaving a timer', async () => {
    vi.useFakeTimers();
    let stopTyping: (() => void) | null = null;
    try {
      typingMocks.adapter = {
        config: { platform: 'wechat', supportsMessageUpdate: false },
        sendTyping: typingMocks.sendTyping,
      };

      stopTyping = getInternal().startTypingHeartbeat(
        typingMocks.adapter as unknown as IMAdapter,
        'wechat-credentials',
        'user@im.wechat',
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(typingMocks.sendTyping.mock.calls.map((call) => call[2])).toEqual([1]);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(typingMocks.sendTyping.mock.calls.map((call) => call[2])).toEqual([1, 1]);

      stopTyping();
      await vi.advanceTimersByTimeAsync(0);
      expect(typingMocks.sendTyping.mock.calls.map((call) => call[2])).toEqual([1, 1, 2]);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(typingMocks.sendTyping).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stopTyping?.();
      vi.useRealTimers();
    }
  });

  it('times out a stuck typing request so cancel and the next turn can proceed', async () => {
    vi.useFakeTimers();
    let stopFirst: (() => void) | null = null;
    let stopSecond: (() => void) | null = null;
    try {
      typingMocks.adapter = {
        config: { platform: 'wechat', supportsMessageUpdate: false },
        sendTyping: typingMocks.sendTyping,
      };
      typingMocks.sendTyping
        .mockImplementationOnce(() => new Promise<void>(() => {}))
        .mockResolvedValue(undefined);
      const adapter = typingMocks.adapter as unknown as IMAdapter;

      stopFirst = getInternal().startTypingHeartbeat(adapter, 'credentials', 'stuck@im.wechat');
      await vi.advanceTimersByTimeAsync(0);
      stopFirst();
      stopSecond = getInternal().startTypingHeartbeat(adapter, 'credentials', 'stuck@im.wechat');

      await vi.advanceTimersByTimeAsync(3_999);
      expect(typingMocks.sendTyping.mock.calls.map((call) => call[2])).toEqual([1]);

      await vi.advanceTimersByTimeAsync(1);
      expect(typingMocks.sendTyping.mock.calls.map((call) => call[2])).toEqual([1, 2, 1]);
      expect(typingMocks.warn).toHaveBeenCalledWith(
        'typing indicator lifecycle failed',
        expect.objectContaining({
          userId: 'stuck@im.wechat',
          error: expect.stringContaining('timed out'),
        }),
      );
    } finally {
      stopFirst?.();
      stopSecond?.();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it('stops active typing heartbeats when the router stops', async () => {
    vi.useFakeTimers();
    try {
      typingMocks.adapter = {
        config: { platform: 'wechat', supportsMessageUpdate: false },
        sendTyping: typingMocks.sendTyping,
      };

      getInternal().startTypingHeartbeat(
        typingMocks.adapter as unknown as IMAdapter,
        'credentials',
        'shutdown@im.wechat',
      );
      await vi.advanceTimersByTimeAsync(0);

      getInternal().stop();
      await vi.advanceTimersByTimeAsync(0);
      expect(typingMocks.sendTyping.mock.calls.map((call) => call[2])).toEqual([1, 2]);
      expect(getInternal().activeTypingStops.size).toBe(0);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(typingMocks.sendTyping).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not register a heartbeat after stop wins the adapter-import race', async () => {
    typingMocks.adapter = {
      config: { platform: 'wechat', supportsMessageUpdate: false },
      sendTyping: typingMocks.sendTyping,
    };
    mockRunAgentLoop.mockImplementation(async (convId: string) => {
      mockConversations[convId]?.messages.push({ role: 'assistant', content: 'done' });
      return { reason: 'completed' };
    });

    const processing = getInternal().processMessage(
      makeMessage({
        platform: 'wechat',
        senderId: 'stopping@im.wechat',
        chatId: 'stopping@im.wechat',
        replyContext: { platform: 'wechat', chatId: 'stopping@im.wechat' },
      }),
      makeChannel({ platform: 'wechat', appSecret: 'credentials' }),
      'safe_tools',
    );
    // processMessage has yielded at its dynamic import; stop invalidates that
    // continuation before it can register a new interval.
    getInternal().stop();

    await processing;
    await drainTypingOperations();
    expect(typingMocks.sendTyping).not.toHaveBeenCalled();
    expect(getInternal().activeTypingStops.size).toBe(0);
  });

  it('starts and cancels WeChat typing around the full processing lifecycle', async () => {
    typingMocks.adapter = {
      config: { platform: 'wechat', supportsMessageUpdate: false },
      sendTyping: typingMocks.sendTyping,
    };
    mockRunAgentLoop.mockImplementation(async (convId: string) => {
      mockConversations[convId]?.messages.push({ role: 'assistant', content: 'done' });
      return { reason: 'completed' };
    });

    await getInternal().processMessage(
      makeMessage({
        platform: 'wechat',
        senderId: 'user@im.wechat',
        chatId: 'user@im.wechat',
        replyContext: { platform: 'wechat', chatId: 'user@im.wechat' },
      }),
      makeChannel({ platform: 'wechat', appSecret: 'wechat-credentials' }),
      'safe_tools',
    );

    await drainTypingOperations();
    expect(typingMocks.sendTyping.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ['wechat-credentials', 'user@im.wechat', 1],
      ['wechat-credentials', 'user@im.wechat', 2],
    ]);
  });

  it('keeps the reply pipeline healthy when WeChat typing requests reject', async () => {
    typingMocks.adapter = {
      config: { platform: 'wechat', supportsMessageUpdate: false },
      sendTyping: typingMocks.sendTyping,
    };
    typingMocks.sendTyping.mockRejectedValue(new Error('typing unavailable'));
    mockRunAgentLoop.mockImplementation(async (convId: string) => {
      mockConversations[convId]?.messages.push({ role: 'assistant', content: 'still works' });
      return { reason: 'completed' };
    });

    await getInternal().processMessage(
      makeMessage({
        platform: 'wechat',
        senderId: 'failure@im.wechat',
        chatId: 'failure@im.wechat',
        replyContext: { platform: 'wechat', chatId: 'failure@im.wechat' },
      }),
      makeChannel({ platform: 'wechat', appSecret: 'wechat-credentials' }),
      'safe_tools',
    );

    await drainTypingOperations();
    expect(mockRunAgentLoop).toHaveBeenCalledOnce();
    expect(mockSendFinal.mock.calls.at(-1)?.[1].content).toBe('still works');
    expect(typingMocks.warn).toHaveBeenCalledWith(
      'typing indicator lifecycle failed',
      expect.objectContaining({ platform: 'wechat', userId: 'failure@im.wechat' }),
    );
  });

  it('forwards the tier ceiling as blockedTools — read_tools gets no browser tools', async () => {
    mockRunAgentLoop.mockResolvedValue({ reason: 'completed' });

    await getInternal().processMessage(makeMessage(), makeChannel(), 'read_tools');

    const options = mockRunAgentLoop.mock.calls[0][2];
    expect(options.blockedTools).toContain('request_workspace');
    for (const tool of ['click', 'navigate', 'execute_js', 'snapshot']) {
      expect(
        options.blockedTools.some((p: string) => matchesToolName(`abu-browser__${tool}`, p)),
        tool,
      ).toBe(true);
    }
  });

  it('does not strip browser tools for the higher tiers', async () => {
    mockRunAgentLoop.mockResolvedValue({ reason: 'completed' });

    await getInternal().processMessage(makeMessage(), makeChannel(), 'full');

    // request_workspace + ask_user_question are always blocked in IM (no desktop
    // UI to answer them); browser tools remain available at higher tiers.
    expect(mockRunAgentLoop.mock.calls[0][2].blockedTools).toEqual(['request_workspace', 'ask_user_question']);
  });

  it('sets channel error status when agentLoop throws', async () => {
    mockRunAgentLoop.mockRejectedValue(new Error('LLM connection failed'));
    const channel = makeChannel();
    mockSetChannelStatus.mockClear();

    await getInternal().processMessage(makeMessage(), channel, 'safe_tools');

    expect(mockSetChannelStatus).toHaveBeenCalledWith('ch1', 'error', 'LLM connection failed');
  });

  it('attempts error reply to user on failure', async () => {
    mockRunAgentLoop.mockRejectedValue(new Error('agent crash'));

    await getInternal().processMessage(makeMessage(), makeChannel(), 'safe_tools');

    // sendFinal is called with error message
    const finalCalls = mockSendFinal.mock.calls;
    expect(finalCalls.length).toBeGreaterThanOrEqual(1);
    const lastCall = finalCalls[finalCalls.length - 1];
    expect(lastCall[1].content).toContain('Abu 处理出错');
  });

  it('decrements runningCount even on error', async () => {
    mockRunAgentLoop.mockRejectedValue(new Error('fail'));
    getInternal().runningCount = 1;

    await getInternal().processMessage(makeMessage(), makeChannel(), 'safe_tools');

    // runningCount was incremented to 2 at start, then decremented to 1 in finally
    expect(getInternal().runningCount).toBe(1);
  });

  it('clears channel error on successful processing', async () => {
    mockRunAgentLoop.mockImplementation(async (convId: string) => {
      if (mockConversations[convId]) {
        mockConversations[convId].messages.push({ role: 'assistant', content: 'ok' });
      }
      return { reason: 'completed' };
    });
    mockSetChannelStatus.mockClear();

    await getInternal().processMessage(makeMessage(), makeChannel(), 'safe_tools');

    expect(mockSetChannelStatus).toHaveBeenCalledWith('ch1', 'connected');
  });
});

describe('runWithTimeout', () => {
  it('resolves if promise completes within timeout', async () => {
    const result = await getInternal().runWithTimeout(Promise.resolve(42), 1000);
    expect(result).toBe(42);
  });

  it('rejects if promise exceeds timeout', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(getInternal().runWithTimeout(slow, 50)).rejects.toThrow('timed out');
  });

  it('propagates original error if promise rejects before timeout', async () => {
    const failing = Promise.reject(new Error('original error'));
    await expect(getInternal().runWithTimeout(failing, 5000)).rejects.toThrow('original error');
  });
});

// ─────────────────────────────────────────────────────────────────
// Dedup tests — regression guard for IM dedup historical incident.
// Rule (from project memory): dedup must use ID+TTL; reconnect must
// NOT clear the cache. Covers handleMessage entry path via
// dispatchMessage().
// ─────────────────────────────────────────────────────────────────

describe('handleMessage dedup', () => {
  // Flush microtasks so that processMessage's dynamic `await import(...)`
  // and initial awaits settle, making sendThinking calls observable.
  async function flush() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  beforeEach(() => {
    // Reset dedup cache + running state
    const internal = getInternal();
    internal.recentMessageIds.clear();
    internal.runningCount = 0;
    internal.activeSessions.clear();

    // Populate mockChannels so channel lookup inside handleMessage succeeds
    for (const k of Object.keys(mockChannels)) delete mockChannels[k];
    mockChannels['ch1'] = makeChannel({ responseMode: 'all_messages' });

    // Agent loop is a noop — we only care whether processMessage was reached
    mockRunAgentLoop.mockReset();
    mockRunAgentLoop.mockResolvedValue({ reason: 'completed' });
    mockSendThinking.mockReset();
    mockSendThinking.mockResolvedValue({ platform: 'dingtalk', supportsUpdate: false, replyContext: {} });
    mockSendFinal.mockReset();
    mockSendFinal.mockResolvedValue({ success: true });
  });

  function makeDedupMessage(overrides: Partial<NormalizedIMMessage> = {}): NormalizedIMMessage {
    return makeMessage({
      isDirect: true, // bypass response-mode filter
      replyContext: {
        platform: 'dingtalk',
        sessionWebhook: 'https://hook.example.com',
        messageId: 'msg-id-1',
      },
      ...overrides,
    });
  }

  it('skips duplicate message with same messageId', async () => {
    const router = getInternal();
    const msg = makeDedupMessage();

    router.dispatchMessage(msg);
    await flush();
    router.dispatchMessage(msg);
    await flush();

    // Same ID → second dispatch should be deduped at the ID layer and never
    // reach processMessage. sendThinking is the first observable side effect
    // inside processMessage, so it must only have fired once.
    expect(mockSendThinking).toHaveBeenCalledTimes(1);
    expect(router.recentMessageIds.size).toBe(1);
  });

  it('processes two messages with different messageIds', async () => {
    const router = getInternal();
    router.dispatchMessage(makeDedupMessage({ replyContext: { platform: 'dingtalk', sessionWebhook: 'https://h.x', messageId: 'msg-A' } }));
    await flush();
    router.dispatchMessage(makeDedupMessage({ replyContext: { platform: 'dingtalk', sessionWebhook: 'https://h.x', messageId: 'msg-B' } }));
    await flush();

    expect(mockSendThinking).toHaveBeenCalledTimes(2);
    expect(router.recentMessageIds.size).toBe(2);
  });

  it('falls back to content-based dedup when messageId is absent', async () => {
    const router = getInternal();
    const noIdMsg = makeDedupMessage({
      replyContext: { platform: 'dingtalk', sessionWebhook: 'https://h.x' }, // no messageId
      text: 'hello world',
    });

    router.dispatchMessage(noIdMsg);
    await flush();
    router.dispatchMessage(noIdMsg);
    await flush();

    // Same sender + chat + text → same content key → dedup fires
    expect(mockSendThinking).toHaveBeenCalledTimes(1);
  });

  it('content-based dedup does not collide on different text', async () => {
    const router = getInternal();
    router.dispatchMessage(makeDedupMessage({
      replyContext: { platform: 'dingtalk', sessionWebhook: 'https://h.x' },
      text: 'hello',
    }));
    await flush();
    router.dispatchMessage(makeDedupMessage({
      replyContext: { platform: 'dingtalk', sessionWebhook: 'https://h.x' },
      text: 'world',
    }));
    await flush();

    expect(mockSendThinking).toHaveBeenCalledTimes(2);
  });

  it('re-processes the same message after TTL expires (30min)', async () => {
    // Observe TTL behavior directly on recentMessageIds — avoid fake timers
    // here because processMessage's dynamic import doesn't play well with
    // time manipulation, and the TTL logic is a pure Date.now() comparison.
    const router = getInternal();
    const dedupKey = 'dingtalk:ttl-msg';

    // Seed with an "old" timestamp beyond the 30-minute TTL. Genuinely needs real
    // wall-clock time: per the comment above, processMessage's dynamic import doesn't
    // play well with fake timers, and the production TTL check compares against a real
    // Date.now() read at dispatch time, so the seed must be relative to that same clock.
    // eslint-disable-next-line no-restricted-syntax -- see rationale above
    router.recentMessageIds.set(dedupKey, Date.now() - 31 * 60 * 1000);

    router.dispatchMessage(makeDedupMessage({
      replyContext: { platform: 'dingtalk', sessionWebhook: 'https://h.x', messageId: 'ttl-msg' },
    }));
    await flush();

    // TTL expired → message should process, and recentMessageIds timestamp
    // should be refreshed to ~now (within the current millisecond window).
    const ts = router.recentMessageIds.get(dedupKey)!;
    // Paired with the real Date.now() seed above (same "no fake timers here" rationale).
    // eslint-disable-next-line no-restricted-syntax -- see rationale above
    expect(ts).toBeGreaterThan(Date.now() - 1000);
    expect(mockSendThinking).toHaveBeenCalledTimes(1);
  });

  it('stop() clears dedup cache (full shutdown only)', () => {
    // Does NOT dispatch through the full pipeline — we just want to confirm
    // the synchronous state machine: stop() clears, dispatch re-populates.
    const router = getInternal();
    router.recentMessageIds.set('dingtalk:foo', FIXED_TIMESTAMP);
    router.recentMessageIds.set('dingtalk:bar', FIXED_TIMESTAMP);
    expect(router.recentMessageIds.size).toBe(2);

    router.stop();
    expect(router.recentMessageIds.size).toBe(0);

    // Reconnect scenario: a new message arriving AFTER stop() should land in
    // a fresh cache, proving stop() is the only path that clears. The IM WS
    // reconnect path (feishu_ws.rs) does NOT call stop() — it only reloads
    // the Rust-side connection, leaving this TS cache intact across reconnects.
    router.recentMessageIds.set('dingtalk:after-stop', FIXED_TIMESTAMP);
    expect(router.recentMessageIds.size).toBe(1);
  });
});
