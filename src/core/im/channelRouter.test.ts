/**
 * IMChannelRouter Tests
 *
 * Tests the core processMessage pipeline: session → thinking → agent → reply → error handling.
 * Uses mocks for all external dependencies (stores, agentLoop, streamingReply).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedIMMessage } from './inboundRouter';
import type { IMChannel } from '@/types/imChannel';

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
vi.mock('../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      conversations: mockConversations,
      createConversation: vi.fn(() => {
        const id = 'conv-' + Date.now();
        mockConversations[id] = { messages: [] };
        return id;
      }),
      renameConversation: vi.fn(),
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

vi.mock('./authGate', () => ({
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
            lastActiveAt: Date.now(),
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
  getAdapter: vi.fn(() => ({
    config: { supportsMessageUpdate: false },
  })),
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
  stop(): void;
};

function getInternal(): RouterInternal {
  return imChannelRouter as unknown as RouterInternal;
}

function makeChannel(overrides: Partial<IMChannel> = {}): IMChannel {
  return {
    id: 'ch1', platform: 'dingtalk', name: 'Test', enabled: true,
    appId: 'a', appSecret: 's', capability: 'safe_tools',
    responseMode: 'mention_only',
    allowedUsers: [], workspacePaths: [], sessionTimeoutMinutes: 30,
    maxRoundsPerSession: 50, status: 'connected',
    createdAt: Date.now(), updatedAt: Date.now(),
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
    // Reset runningCount and session tracking
    getInternal().runningCount = 0;
    getInternal().activeSessions.clear();
  });

  it('processes message through full pipeline', async () => {
    const channel = makeChannel();
    const message = makeMessage();

    // Agent succeeds, and we plant a reply in the conversation
    mockRunAgentLoop.mockImplementation(async (convId: string) => {
      if (mockConversations[convId]) {
        mockConversations[convId].messages.push({ role: 'assistant', content: 'AI reply' });
      }
    });

    await getInternal().processMessage(message, channel, 'safe_tools');

    expect(mockSendThinking).toHaveBeenCalledOnce();
    expect(mockRunAgentLoop).toHaveBeenCalledOnce();
    expect(mockSendFinal).toHaveBeenCalledOnce();
    expect(mockSendFinal.mock.calls[0][1].content).toBe('AI reply');
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
    mockRunAgentLoop.mockResolvedValue(undefined);
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

    // Seed with an "old" timestamp beyond the 30-minute TTL
    router.recentMessageIds.set(dedupKey, Date.now() - 31 * 60 * 1000);

    router.dispatchMessage(makeDedupMessage({
      replyContext: { platform: 'dingtalk', sessionWebhook: 'https://h.x', messageId: 'ttl-msg' },
    }));
    await flush();

    // TTL expired → message should process, and recentMessageIds timestamp
    // should be refreshed to ~now (within the current millisecond window).
    const ts = router.recentMessageIds.get(dedupKey)!;
    expect(ts).toBeGreaterThan(Date.now() - 1000);
    expect(mockSendThinking).toHaveBeenCalledTimes(1);
  });

  it('stop() clears dedup cache (full shutdown only)', () => {
    // Does NOT dispatch through the full pipeline — we just want to confirm
    // the synchronous state machine: stop() clears, dispatch re-populates.
    const router = getInternal();
    router.recentMessageIds.set('dingtalk:foo', Date.now());
    router.recentMessageIds.set('dingtalk:bar', Date.now());
    expect(router.recentMessageIds.size).toBe(2);

    router.stop();
    expect(router.recentMessageIds.size).toBe(0);

    // Reconnect scenario: a new message arriving AFTER stop() should land in
    // a fresh cache, proving stop() is the only path that clears. The IM WS
    // reconnect path (feishu_ws.rs) does NOT call stop() — it only reloads
    // the Rust-side connection, leaving this TS cache intact across reconnects.
    router.recentMessageIds.set('dingtalk:after-stop', Date.now());
    expect(router.recentMessageIds.size).toBe(1);
  });
});
