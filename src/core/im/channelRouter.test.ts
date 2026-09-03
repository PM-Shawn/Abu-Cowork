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
import { checkReadPath, checkWritePath } from '../tools/pathSafety';

// Deterministic filler timestamp (TESTING.md §3) — used where a numeric
// timestamp field is structurally required but its exact value is never
// asserted on.
const FIXED_TIMESTAMP = 1_700_000_000_000;
let inboundMessageIdCounter = 0;

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
const abortControllerMocks = vi.hoisted(() => ({
  has: vi.fn(() => false),
  get: vi.fn(() => new AbortController()),
}));
const authGateMocks = vi.hoisted(() => ({
  resolveCapability: vi.fn((_userId: string, _channel: unknown) => ({
    allowed: true,
    capability: 'safe_tools',
  })),
}));
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
      hasAbortController: abortControllerMocks.has,
      getAbortController: abortControllerMocks.get,
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

vi.mock('../agent/agentLoopRunner', () => ({
  runAgentLoopDispatched: (...args: unknown[]) => mockRunAgentLoop(...args),
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
  resolveCapability: (...args: unknown[]) => authGateMocks.resolveCapability(...args),
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
      confirmCommandPrompt: 'confirm command',
      confirmDeleteFilePrompt: 'confirm delete',
      confirmFilePermissionPrompt: 'confirm file',
      confirmGroupCommandPrompt: 'group confirm command',
      confirmGroupDeleteFilePrompt: 'group confirm delete',
      confirmGroupFileReadPrompt: 'group confirm file read',
      confirmGroupFileWritePrompt: 'group confirm file write',
      confirmGroupDetailsHidden: 'details hidden for group chat',
      confirmReplyOptions: 'reply 1/2',
      confirmInvalidReply: 'invalid confirmation reply',
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
import {
  __resetIMConfirmationRelayForTests,
  consumeIMConfirmationReply,
  getPendingIMConfirmationCount,
} from './confirmationRelay';

// Access private methods via type cast for testing
type RouterInternal = {
  processMessage(msg: NormalizedIMMessage, channel: IMChannel, capability: string): Promise<void>;
  dispatchMessage(msg: NormalizedIMMessage): void;
  runWithTimeout<T>(
    promise: Promise<T>,
    ms: number,
    onTimeout?: () => void,
    settleGraceMs?: number,
  ): Promise<T>;
  runningCount: number;
  queuedMessages: Array<{ message: NormalizedIMMessage; channelId: string; sessionKey: string }>;
  activeSessions: Set<string>;
  sessionQueues: Map<string, Array<{
    message: NormalizedIMMessage;
    channel: IMChannel;
    capability: 'safe_tools';
  }>>;
  recentMessageIds: Map<string, number>;
  pendingMedia: Map<string, { message: NormalizedIMMessage; timer: ReturnType<typeof setTimeout> }>;
  typingOperations: Map<string, Promise<void>>;
  activeTypingStops: Set<() => void>;
  processQueue(): void;
  startTypingHeartbeat(adapter: IMAdapter, token: string, userId: string): () => void;
  stop(): void;
};

function getInternal(): RouterInternal {
  return imChannelRouter as unknown as RouterInternal;
}

async function drainTypingOperations(): Promise<void> {
  await Promise.all([...getInternal().typingOperations.values()]);
}

async function waitForIMConfirmationPrompt(): Promise<void> {
  await vi.waitFor(() => expect(
    mockSendFinal.mock.calls.some(([, body]) =>
      typeof body?.content === 'string'
      && (
        body.content.includes('confirm command')
        || body.content.includes('confirm file')
        || body.content.includes('confirm delete')
      ),
    ),
  ).toBe(true));
  await Promise.resolve();
  await Promise.resolve();
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

function makeMessage(
  overrides: Partial<Omit<NormalizedIMMessage, 'replyContext'>> & {
    replyContext?: Partial<NormalizedIMMessage['replyContext']>;
  } = {},
): NormalizedIMMessage {
  const replyContext = {
    platform: 'dingtalk' as const,
    sessionWebhook: 'https://hook.example.com',
    messageId: `im-reply-${++inboundMessageIdCounter}`,
    ...overrides.replyContext,
  };
  return {
    senderId: 'u1', senderName: '张三', text: 'hello',
    isMention: true, isDirect: false, chatId: 'chat1',
    platform: 'dingtalk',
    replyContext,
    raw: {},
    ...overrides,
    replyContext,
  };
}

describe('IMChannelRouter', () => {
  beforeEach(() => {
    inboundMessageIdCounter = 0;
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
    abortControllerMocks.has.mockReset();
    abortControllerMocks.has.mockReturnValue(false);
    abortControllerMocks.get.mockReset();
    abortControllerMocks.get.mockImplementation(() => new AbortController());
    authGateMocks.resolveCapability.mockReset();
    authGateMocks.resolveCapability.mockImplementation((_userId: string, _channel: unknown) => ({
      allowed: true,
      capability: 'safe_tools',
    }));
    __resetIMConfirmationRelayForTests();
    // Reset runningCount and session tracking
    getInternal().runningCount = 0;
    getInternal().queuedMessages.length = 0;
    getInternal().activeSessions.clear();
    getInternal().sessionQueues.clear();
    getInternal().recentMessageIds.clear();
    getInternal().typingOperations.clear();
    for (const { timer } of getInternal().pendingMedia.values()) clearTimeout(timer);
    getInternal().pendingMedia.clear();
  });

  afterEach(async () => {
    __resetIMConfirmationRelayForTests();
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

  it('does not route a direct message through a channel with malformed truthy enabled', () => {
    const channel = makeChannel({ enabled: 'yes' as never, responseMode: 'all_messages' });
    mockChannels[channel.id] = channel;

    getInternal().dispatchMessage(makeMessage({ isDirect: true, isMention: false }));

    expect(mockRunAgentLoop).not.toHaveBeenCalled();
    delete mockChannels[channel.id];
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
    expect(options.runPermissionCeiling).toEqual({
      version: 1,
      source: 'im',
      capability: 'read_tools',
    });
    for (const tool of ['click', 'navigate', 'execute_js', 'snapshot']) {
      expect(
        options.blockedTools.some((p: string) => matchesToolName(`abu-browser__${tool}`, p)),
        tool,
      ).toBe(true);
    }
  });

  it('creates a per-turn scoped read grant for read_tools and disposes it after the turn', async () => {
    const workspace = '/Users/testuser/Projects/im-read-scope';
    let scopeId = '';
    mockRunAgentLoop.mockImplementation(async (convId: string, _text: string, options: {
      authorizationScopeId: string;
    }) => {
      scopeId = options.authorizationScopeId;
      expect(scopeId).toBeTruthy();
      expect((await checkReadPath(`${workspace}/notes.md`, scopeId)).allowed).toBe(true);
      expect((await checkWritePath(`${workspace}/notes.md`, scopeId)).allowed).toBe(false);
      mockConversations[convId]?.messages.push({ role: 'assistant', content: 'done' });
      return { reason: 'completed' };
    });

    await getInternal().processMessage(
      makeMessage(),
      makeChannel({ workspacePaths: [workspace] }),
      'read_tools',
    );

    expect((await checkReadPath(`${workspace}/notes.md`, scopeId)).allowed).toBe(false);
  });

  it('creates a per-turn scoped write grant for safe_tools and disposes it after the turn', async () => {
    const workspace = '/Users/testuser/Projects/im-safe-scope';
    let scopeId = '';
    mockRunAgentLoop.mockImplementation(async (convId: string, _text: string, options: {
      authorizationScopeId: string;
    }) => {
      scopeId = options.authorizationScopeId;
      expect((await checkWritePath(`${workspace}/out.md`, scopeId)).allowed).toBe(true);
      mockConversations[convId]?.messages.push({ role: 'assistant', content: 'done' });
      return { reason: 'completed' };
    });

    await getInternal().processMessage(
      makeMessage(),
      makeChannel({ workspacePaths: [workspace] }),
      'safe_tools',
    );

    expect((await checkWritePath(`${workspace}/out.md`, scopeId)).allowed).toBe(false);
  });

  it('releases the IM scope and session slot after sidecar recovery finite-settles as unavailable', async () => {
    const internal = getInternal();
    const sessionKey = 'test:chat1:window';
    const workspace = '/Users/testuser/Projects/im-sidecar-unavailable';
    let scopeId = '';
    internal.runningCount = 0;
    internal.activeSessions.add(sessionKey);
    mockRunAgentLoop.mockImplementationOnce(async (_convId: string, _text: string, options: {
      authorizationScopeId: string;
    }) => {
      scopeId = options.authorizationScopeId;
      expect((await checkWritePath(`${workspace}/during.md`, scopeId)).allowed).toBe(true);
      return {
        reason: 'error',
        error: 'Sidecar run state remained unavailable during reattach',
        stopReason: 'sidecar_unavailable',
      };
    });

    await internal.processMessage(
      makeMessage(),
      makeChannel({ workspacePaths: [workspace] }),
      'safe_tools',
    );

    expect(scopeId).toBeTruthy();
    expect((await checkWritePath(`${workspace}/after.md`, scopeId)).allowed).toBe(false);
    expect(internal.activeSessions.has(sessionKey)).toBe(false);
    expect(internal.runningCount).toBe(0);
  });

  it('keeps a timed-out session and scope quarantined until its stuck run actually settles', async () => {
    vi.useFakeTimers();
    const sessionKey = 'test:chat1:window';
    const workspace = '/Users/testuser/Projects/im-timeout-quarantine';
    let settleFirst!: () => void;
    let firstScopeId = '';
    try {
      mockRunAgentLoop
        .mockImplementationOnce((_convId: string, _text: string, options: {
          authorizationScopeId: string;
        }) => {
          firstScopeId = options.authorizationScopeId;
          return new Promise<void>((resolve) => { settleFirst = resolve; });
        })
        .mockImplementationOnce(async (convId: string) => {
          mockConversations[convId]?.messages.push({ role: 'assistant', content: 'second done' });
          return { reason: 'completed' };
        });

      const first = makeMessage({ text: 'first' });
      const second = makeMessage({ text: 'second' });
      const channel = makeChannel({ workspacePaths: [workspace] });
      const internal = getInternal();
      internal.activeSessions.add(sessionKey);
      const processing = internal.processMessage(first, channel, 'safe_tools');

      await vi.advanceTimersByTimeAsync(0);
      expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
      expect(firstScopeId).toBeTruthy();
      internal.sessionQueues.set(sessionKey, [{ message: second, channel, capability: 'safe_tools' }]);

      // 10-minute run timeout + 6-second cancellation grace.  The user gets a
      // bounded error, but the next same-session turn must remain queued while
      // the original execution is still alive.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 6_000);
      await processing;
      expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
      expect(internal.activeSessions.has(sessionKey)).toBe(true);
      expect(internal.sessionQueues.get(sessionKey)).toHaveLength(1);
      expect((await checkWritePath(`${workspace}/still-owned.md`, firstScopeId)).allowed).toBe(true);

      settleFirst();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRunAgentLoop).toHaveBeenCalledTimes(2);
      expect(internal.activeSessions.has(sessionKey)).toBe(false);
      expect(internal.sessionQueues.has(sessionKey)).toBe(false);
      expect(internal.runningCount).toBe(0);
      expect((await checkWritePath(`${workspace}/released.md`, firstScopeId)).allowed).toBe(false);
    } finally {
      settleFirst?.();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it('aborts the timed-out run owner without cancelling a newer controller for the conversation', async () => {
    vi.useFakeTimers();
    const ownedController = new AbortController();
    const newerController = new AbortController();
    let settleRun!: () => void;
    try {
      abortControllerMocks.has.mockReturnValue(true);
      abortControllerMocks.get.mockReturnValue(newerController);
      mockRunAgentLoop.mockImplementationOnce((_convId: string, _text: string, options: {
        onAbortControllerReady?: (controller: AbortController) => void;
      }) => {
        options.onAbortControllerReady?.(ownedController);
        return new Promise<void>((resolve) => { settleRun = resolve; });
      });

      const processing = getInternal().processMessage(
        makeMessage({ text: 'times out' }),
        makeChannel(),
        'safe_tools',
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRunAgentLoop).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(ownedController.signal.aborted).toBe(true);
      expect(newerController.signal.aborted).toBe(false);

      settleRun();
      await vi.advanceTimersByTimeAsync(0);
      await processing;
    } finally {
      settleRun?.();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it('acquires the session lock before starting a turn from the global queue', async () => {
    const internal = getInternal();
    const sessionKey = 'test:chat1:window';
    const channel = makeChannel({ responseMode: 'all_messages' });
    const message = makeMessage({ isDirect: true, text: 'globally queued' });
    let settleRun!: () => void;
    mockChannels[channel.id] = channel;
    mockRunAgentLoop.mockImplementationOnce(() => new Promise<void>((resolve) => {
      settleRun = resolve;
    }));
    internal.runningCount = 4;
    internal.queuedMessages.push({ message, channelId: channel.id, sessionKey });

    internal.processQueue();

    expect(internal.activeSessions.has(sessionKey)).toBe(true);
    await vi.waitFor(() => expect(mockRunAgentLoop).toHaveBeenCalledOnce());
    settleRun();
    await vi.waitFor(() => expect(internal.activeSessions.has(sessionKey)).toBe(false));
    delete mockChannels[channel.id];
  });

  it('moves a global-queue item into the existing session queue instead of overlapping that session', () => {
    const internal = getInternal();
    const sessionKey = 'test:chat1:window';
    const channel = makeChannel({ responseMode: 'all_messages' });
    const message = makeMessage({ isDirect: true, text: 'same session' });
    mockChannels[channel.id] = channel;
    internal.runningCount = 4;
    internal.activeSessions.add(sessionKey);
    internal.queuedMessages.push({ message, channelId: channel.id, sessionKey });

    internal.processQueue();

    expect(mockRunAgentLoop).not.toHaveBeenCalled();
    expect(internal.runningCount).toBe(4);
    expect(internal.sessionQueues.get(sessionKey)).toEqual([
      expect.objectContaining({ message, channel }),
    ]);
    delete mockChannels[channel.id];
  });

  it('drops a global-queue item when the channel has malformed truthy enabled before recheck', () => {
    const internal = getInternal();
    const sessionKey = 'test:chat1:window';
    const channel = makeChannel({ enabled: 'yes' as never, responseMode: 'all_messages' });
    mockChannels[channel.id] = channel;
    internal.queuedMessages.push({
      message: makeMessage({ isDirect: true, text: 'queued malformed enabled' }),
      channelId: channel.id,
      sessionKey,
    });

    internal.processQueue();

    expect(mockRunAgentLoop).not.toHaveBeenCalled();
    expect(internal.queuedMessages).toHaveLength(0);
    delete mockChannels[channel.id];
  });

  it('applies the per-session queue cap even before that session starts from the global queue', () => {
    const internal = getInternal();
    const sessionKey = 'test:chat1:window';
    const channel = makeChannel({ responseMode: 'all_messages' });
    mockChannels[channel.id] = channel;
    internal.runningCount = 5;
    for (let index = 0; index < 5; index++) {
      internal.queuedMessages.push({
        message: makeMessage({ text: `queued-${index}` }),
        channelId: channel.id,
        sessionKey,
      });
    }

    internal.dispatchMessage(makeMessage({
      isDirect: true,
      text: 'one too many',
      replyContext: { platform: 'dingtalk', messageId: 'per-session-overflow' },
    }));

    expect(internal.queuedMessages).toHaveLength(5);
    delete mockChannels[channel.id];
  });

  it('bounds the total global queue when all execution slots are occupied', () => {
    const internal = getInternal();
    const channel = makeChannel({ responseMode: 'all_messages' });
    mockChannels[channel.id] = channel;
    internal.runningCount = 5;
    for (let index = 0; index < 25; index++) {
      internal.queuedMessages.push({
        message: makeMessage({ text: `global-${index}`, chatId: `chat-${index}` }),
        channelId: channel.id,
        sessionKey: `session-${index}`,
      });
    }

    internal.dispatchMessage(makeMessage({
      isDirect: true,
      text: 'global overflow',
      replyContext: { platform: 'dingtalk', messageId: 'global-overflow' },
    }));

    expect(internal.queuedMessages).toHaveLength(25);
    delete mockChannels[channel.id];
  });

  it('applies one per-session cap across both global and active-session queues', () => {
    const internal = getInternal();
    const sessionKey = 'test:chat1:window';
    const channel = makeChannel({ responseMode: 'all_messages' });
    mockChannels[channel.id] = channel;
    internal.runningCount = 5;
    internal.activeSessions.add(sessionKey);
    for (let index = 0; index < 4; index++) {
      internal.queuedMessages.push({
        message: makeMessage({ text: `older-global-${index}` }),
        channelId: channel.id,
        sessionKey,
      });
    }

    internal.dispatchMessage(makeMessage({
      isDirect: true,
      text: 'fills aggregate cap',
      replyContext: { platform: 'dingtalk', messageId: 'aggregate-cap-last' },
    }));
    internal.dispatchMessage(makeMessage({
      isDirect: true,
      text: 'exceeds aggregate cap',
      replyContext: { platform: 'dingtalk', messageId: 'aggregate-cap-overflow' },
    }));

    const queuedForSession = internal.queuedMessages.filter(
      (queued) => queued.sessionKey === sessionKey,
    ).length + (internal.sessionQueues.get(sessionKey)?.length ?? 0);
    expect(queuedForSession).toBe(5);
    expect(internal.sessionQueues.get(sessionKey)).toHaveLength(1);
    delete mockChannels[channel.id];
  });

  it('keeps a stopped run owning its session until settlement, then hands off a restarted turn', async () => {
    const internal = getInternal();
    const sessionKey = 'test:chat1:window';
    const channel = makeChannel({ responseMode: 'all_messages' });
    let settleOldRun!: () => void;
    mockChannels[channel.id] = channel;
    mockRunAgentLoop
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        settleOldRun = resolve;
      }))
      .mockImplementationOnce(async (convId: string) => {
        mockConversations[convId]?.messages.push({ role: 'assistant', content: 'restarted done' });
        return { reason: 'completed' };
      });
    internal.activeSessions.add(sessionKey);
    const oldProcessing = internal.processMessage(makeMessage({ text: 'old run' }), channel, 'safe_tools');
    await vi.waitFor(() => expect(mockRunAgentLoop).toHaveBeenCalledOnce());

    internal.stop();
    expect(internal.runningCount).toBe(1);
    expect(internal.activeSessions.has(sessionKey)).toBe(true);

    internal.dispatchMessage(makeMessage({
      isDirect: true,
      text: 'after restart',
      replyContext: { platform: 'dingtalk', messageId: 'after-restart' },
    }));
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    expect(internal.sessionQueues.get(sessionKey)).toHaveLength(1);

    settleOldRun();
    await oldProcessing;
    await vi.waitFor(() => expect(mockRunAgentLoop).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(internal.activeSessions.has(sessionKey)).toBe(false));
    expect(internal.runningCount).toBe(0);
    delete mockChannels[channel.id];
  });

  it('scopes full file callback grants to the current turn only', async () => {
    const outside = '/Users/testuser/Desktop/im-full-outside.md';
    let scopeId = '';
    mockRunAgentLoop.mockImplementation(async (convId: string, _text: string, options: {
      authorizationScopeId: string;
      filePermissionCallback: (request: { path: string; capability: 'read' | 'write'; toolName: string }) => Promise<boolean>;
    }) => {
      scopeId = options.authorizationScopeId;
      await expect(options.filePermissionCallback({
        path: outside,
        capability: 'write',
        toolName: 'write_file',
      })).resolves.toBe(true);
      expect((await checkWritePath(outside, scopeId)).allowed).toBe(true);
      mockConversations[convId]?.messages.push({ role: 'assistant', content: 'done' });
      return { reason: 'completed' };
    });

    await getInternal().processMessage(makeMessage(), makeChannel(), 'full');

    expect((await checkWritePath(outside, scopeId)).allowed).toBe(false);
  });

  it('does not strip browser tools for the higher tiers', async () => {
    mockRunAgentLoop.mockResolvedValue({ reason: 'completed' });

    await getInternal().processMessage(makeMessage(), makeChannel(), 'full');

    // request_workspace + ask_user_question are always blocked in IM (no desktop
    // UI to answer them); browser tools remain available at higher tiers.
    expect(mockRunAgentLoop.mock.calls[0][2].blockedTools).toEqual(['request_workspace', 'ask_user_question']);
  });

  it('resumes the same IM full approval promise after the exact inbound 1 reply', async () => {
    const channel = makeChannel({ capability: 'full', allowedUsers: ['u1'] });
    mockChannels[channel.id] = channel;
    authGateMocks.resolveCapability.mockReturnValue({ allowed: true, capability: 'full' });
    let sideEffects = 0;
    mockRunAgentLoop.mockImplementation(async (convId: string, _text: string, options: {
      commandConfirmCallback: (info: { command: string; level: 'safe'; reason?: string }) => Promise<boolean>;
    }) => {
      const approved = await options.commandConfirmCallback({ command: 'echo ok', level: 'safe' });
      if (approved) {
        sideEffects++;
        mockConversations[convId]?.messages.push({ role: 'assistant', content: 'approved once' });
      }
      return { reason: 'completed' };
    });

    const processing = getInternal().processMessage(makeMessage({ isDirect: true, isMention: false }), channel, 'full');
    await vi.waitFor(() => expect(getPendingIMConfirmationCount()).toBe(1));
    await waitForIMConfirmationPrompt();
    expect(sideEffects).toBe(0);

    expect(consumeIMConfirmationReply(makeMessage({ text: '1' }))).toBe(true);
    await processing;

    expect(sideEffects).toBe(1);
    delete mockChannels[channel.id];
  });

  it('fails the IM full approval promise closed when sending the prompt fails', async () => {
    const channel = makeChannel({ capability: 'full', allowedUsers: ['u1'] });
    mockChannels[channel.id] = channel;
    authGateMocks.resolveCapability.mockReturnValue({ allowed: true, capability: 'full' });
    mockSendFinal.mockResolvedValueOnce({ success: false, error: 'send failed' });
    let sideEffects = 0;
    mockRunAgentLoop.mockImplementation(async (_convId: string, _text: string, options: {
      commandConfirmCallback: (info: { command: string; level: 'safe'; reason?: string }) => Promise<boolean>;
    }) => {
      if (await options.commandConfirmCallback({ command: 'echo ok', level: 'safe' })) sideEffects++;
      return { reason: 'completed' };
    });

    await getInternal().processMessage(makeMessage(), channel, 'full');

    expect(sideEffects).toBe(0);
    expect(getPendingIMConfirmationCount()).toBe(0);
    delete mockChannels[channel.id];
  });

  it('returns false and sends no prompt when a stopped run later asks for IM confirmation', async () => {
    const channel = makeChannel({ capability: 'full', allowedUsers: ['u1'] });
    mockChannels[channel.id] = channel;
    authGateMocks.resolveCapability.mockReturnValue({ allowed: true, capability: 'full' });
    let callback!: (info: { command: string; level: 'safe'; reason?: string }) => Promise<boolean>;
    let finishRun!: () => void;
    mockRunAgentLoop.mockImplementation(async (_convId: string, _text: string, options: {
      commandConfirmCallback: (info: { command: string; level: 'safe'; reason?: string }) => Promise<boolean>;
    }) => {
      callback = options.commandConfirmCallback;
      await new Promise<void>((resolve) => { finishRun = resolve; });
      return { reason: 'completed' };
    });

    const processing = getInternal().processMessage(makeMessage({ isDirect: true, isMention: false }), channel, 'full');
    await vi.waitFor(() => expect(mockRunAgentLoop).toHaveBeenCalledOnce());
    mockSendFinal.mockClear();

    getInternal().stop();
    await expect(callback({ command: 'echo ok', level: 'safe' })).resolves.toBe(false);
    expect(getPendingIMConfirmationCount()).toBe(0);
    expect(mockSendFinal).not.toHaveBeenCalled();

    finishRun();
    await processing;
    delete mockChannels[channel.id];
  });

  it('fails an in-flight IM full approval when channel authority is downgraded before reply', async () => {
    const channel = makeChannel({ capability: 'full', allowedUsers: ['u1'] });
    mockChannels[channel.id] = channel;
    authGateMocks.resolveCapability.mockReturnValueOnce({ allowed: true, capability: 'full' });
    let sideEffects = 0;
    mockRunAgentLoop.mockImplementation(async (_convId: string, _text: string, options: {
      commandConfirmCallback: (info: { command: string; level: 'safe'; reason?: string }) => Promise<boolean>;
    }) => {
      if (await options.commandConfirmCallback({ command: 'echo ok', level: 'safe' })) sideEffects++;
      return { reason: 'completed' };
    });

    const processing = getInternal().processMessage(makeMessage({ isDirect: true, isMention: false }), channel, 'full');
    await vi.waitFor(() => expect(getPendingIMConfirmationCount()).toBe(1));
    await waitForIMConfirmationPrompt();
    mockChannels[channel.id] = { ...channel, capability: 'safe_tools', updatedAt: FIXED_TIMESTAMP + 1 };
    authGateMocks.resolveCapability.mockReturnValue({ allowed: true, capability: 'safe_tools' });

    expect(consumeIMConfirmationReply(makeMessage({ text: '1' }))).toBe(true);
    await processing;

    expect(sideEffects).toBe(0);
    delete mockChannels[channel.id];
  });

  it('does not approve a second IM full operation from a late duplicate 1 during cooldown', async () => {
    const channel = makeChannel({ capability: 'full', allowedUsers: ['u1'] });
    mockChannels[channel.id] = channel;
    authGateMocks.resolveCapability.mockReturnValue({ allowed: true, capability: 'full' });
    let sideEffects = 0;
    let secondApproved: boolean | undefined;
    mockRunAgentLoop.mockImplementation(async (convId: string, _text: string, options: {
      commandConfirmCallback: (info: { command: string; level: 'safe'; reason?: string }) => Promise<boolean>;
    }) => {
      const approved = await options.commandConfirmCallback({ command: 'echo ok', level: 'safe' });
      if (approved) {
        sideEffects++;
        mockConversations[convId]?.messages.push({ role: 'assistant', content: `approved ${sideEffects}` });
      }
      secondApproved = await options.commandConfirmCallback({ command: 'echo second', level: 'safe' });
      if (secondApproved) sideEffects++;
      return { reason: 'completed' };
    });

    const first = getInternal().processMessage(makeMessage(), channel, 'full');
    await vi.waitFor(() => expect(getPendingIMConfirmationCount()).toBe(1));
    await waitForIMConfirmationPrompt();
    expect(consumeIMConfirmationReply(makeMessage({ text: '1' }))).toBe(true);
    await first;

    expect(sideEffects).toBe(1);
    expect(secondApproved).toBe(false);
    expect(consumeIMConfirmationReply(makeMessage({ text: '1' }))).toBe(true);
    delete mockChannels[channel.id];
  });

  it('does not let a queued fresh inbound message re-arm an older active turn twice', async () => {
    const channel = makeChannel({ capability: 'full', allowedUsers: ['u1'], responseMode: 'all_messages' });
    mockChannels[channel.id] = channel;
    authGateMocks.resolveCapability.mockReturnValue({ allowed: true, capability: 'full' });
    let continueOldTurn!: () => void;
    let firstApproved: boolean | undefined;
    let oldSecondApproved: boolean | undefined;
    let queuedApproved: boolean | undefined;
    const approvalPromptCount = () => mockSendFinal.mock.calls.filter(([, body]) =>
      typeof body?.content === 'string' && body.content.includes('confirm command'),
    ).length;

    mockRunAgentLoop
      .mockImplementationOnce(async (convId: string, _text: string, options: {
        commandConfirmCallback: (info: { command: string; level: 'safe'; reason?: string }) => Promise<boolean>;
      }) => {
        firstApproved = await options.commandConfirmCallback({ command: 'echo first', level: 'safe' });
        await new Promise<void>((resolve) => { continueOldTurn = resolve; });
        oldSecondApproved = await options.commandConfirmCallback({ command: 'echo old second', level: 'safe' });
        mockConversations[convId]?.messages.push({ role: 'assistant', content: 'old done' });
        return { reason: 'completed' };
      })
      .mockImplementationOnce(async (convId: string, _text: string, options: {
        commandConfirmCallback: (info: { command: string; level: 'safe'; reason?: string }) => Promise<boolean>;
      }) => {
        queuedApproved = await options.commandConfirmCallback({ command: 'echo queued', level: 'safe' });
        mockConversations[convId]?.messages.push({ role: 'assistant', content: 'queued done' });
        return { reason: 'completed' };
      });

    getInternal().dispatchMessage(makeMessage({
      text: 'delete first file',
      isDirect: true,
      isMention: false,
      replyContext: { platform: 'dingtalk', messageId: 'old-turn' },
    }));
    await vi.waitFor(() => expect(getPendingIMConfirmationCount()).toBe(1));
    await waitForIMConfirmationPrompt();
    expect(consumeIMConfirmationReply(makeMessage({ text: '1' }))).toBe(true);
    await vi.waitFor(() => expect(firstApproved).toBe(true));
    expect(approvalPromptCount()).toBe(1);

    const queuedMessage = makeMessage({
      text: 'delete second file',
      isDirect: true,
      isMention: false,
      replyContext: { platform: 'dingtalk', messageId: 'queued-turn' },
    });
    expect(consumeIMConfirmationReply(queuedMessage)).toBe(false);
    getInternal().dispatchMessage(queuedMessage);
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    expect(getInternal().sessionQueues.get('test:chat1:window')).toHaveLength(1);

    continueOldTurn();
    await vi.waitFor(() => expect(oldSecondApproved).toBe(false));
    await vi.waitFor(() => expect(approvalPromptCount()).toBe(2));
    expect(consumeIMConfirmationReply(makeMessage({ text: '1' }))).toBe(true);
    await vi.waitFor(() => expect(queuedApproved).toBe(true));
    await vi.waitFor(() => expect(getInternal().activeSessions.size).toBe(0));
    delete mockChannels[channel.id];
  });

  it('does not rearm a route tombstone from a nonnumeric inbound turn without a stable messageId', async () => {
    const channel = makeChannel({ capability: 'full', allowedUsers: ['u1'] });
    mockChannels[channel.id] = channel;
    authGateMocks.resolveCapability.mockReturnValue({ allowed: true, capability: 'full' });
    let secondApproved: boolean | undefined;
    mockRunAgentLoop
      .mockImplementationOnce(async (_convId: string, _text: string, options: {
        commandConfirmCallback: (info: { command: string; level: 'safe'; reason?: string }) => Promise<boolean>;
      }) => {
        await options.commandConfirmCallback({ command: 'echo first', level: 'safe' });
        return { reason: 'completed' };
      })
      .mockImplementationOnce(async (_convId: string, _text: string, options: {
        commandConfirmCallback: (info: { command: string; level: 'safe'; reason?: string }) => Promise<boolean>;
      }) => {
        secondApproved = await options.commandConfirmCallback({ command: 'echo second', level: 'safe' });
        return { reason: 'completed' };
      });

    const first = getInternal().processMessage(
      makeMessage({ isDirect: true, isMention: false, replyContext: { messageId: 'first-turn' } }),
      channel,
      'full',
    );
    await vi.waitFor(() => expect(getPendingIMConfirmationCount()).toBe(1));
    await waitForIMConfirmationPrompt();
    expect(consumeIMConfirmationReply(makeMessage({ text: '2', replyContext: { messageId: 'first-cancel' } }))).toBe(true);
    await first;
    mockSendFinal.mockClear();

    await getInternal().processMessage(
      makeMessage({
        text: 'fresh ordinary turn without id',
        isDirect: true,
        isMention: false,
        replyContext: { messageId: undefined },
      }),
      channel,
      'full',
    );

    expect(secondApproved).toBe(false);
    expect(mockSendFinal.mock.calls.some(([, body]) =>
      typeof body?.content === 'string' && body.content.includes('confirm command'),
    )).toBe(false);
    delete mockChannels[channel.id];
  });

  it('redacts credentials and local user paths and bounds long IM approval prompts', async () => {
    const channel = makeChannel({ capability: 'full', allowedUsers: ['u1'] });
    mockChannels[channel.id] = channel;
    authGateMocks.resolveCapability.mockReturnValue({ allowed: true, capability: 'full' });
    const longReason = 'r'.repeat(3_000);
    mockRunAgentLoop.mockImplementation(async (_convId: string, _text: string, options: {
      commandConfirmCallback: (info: { command: string; level: 'safe'; reason?: string }) => Promise<boolean>;
    }) => {
      await options.commandConfirmCallback({
        command: 'echo sk-abcdefghijklmnopqrstuvwxyz1234567890 > /Users/shawn/Desktop/token.txt',
        level: 'safe',
        reason: longReason,
      });
      return { reason: 'completed' };
    });

    const processing = getInternal().processMessage(makeMessage({ isDirect: true, isMention: false }), channel, 'full');
    await vi.waitFor(() => expect(getPendingIMConfirmationCount()).toBe(1));
    await waitForIMConfirmationPrompt();
    const prompt = mockSendFinal.mock.calls.find(([, body]) =>
      typeof body?.content === 'string' && body.content.includes('confirm command'),
    )?.[1]?.content;

    expect(prompt).toContain('[REDACTED:openai-key]');
    expect(prompt).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234567890');
    expect(prompt).toContain('~/Desktop/token.txt');
    expect(prompt).not.toContain('/Users/shawn');
    expect(prompt.length).toBeLessThanOrEqual(2_401);
    expect(consumeIMConfirmationReply(makeMessage({ text: '2' }))).toBe(true);
    await processing;
    delete mockChannels[channel.id];
  });

  it('hides command and reason details in group IM confirmation prompts', async () => {
    const channel = makeChannel({ capability: 'full', allowedUsers: ['u1'] });
    mockChannels[channel.id] = channel;
    authGateMocks.resolveCapability.mockReturnValue({ allowed: true, capability: 'full' });
    mockRunAgentLoop.mockImplementation(async (_convId: string, _text: string, options: {
      commandConfirmCallback: (info: { command: string; level: 'danger'; reason: string }) => Promise<boolean>;
    }) => {
      await options.commandConfirmCallback({
        command: 'curl -H "X-API-Key: sk-group-secret" https://user:pass@example.com/admin?PASSWORD=hunter2',
        level: 'danger',
        reason: 'PASSWORD=hunter2 in /Users/alice/Projects/acme/private.env from https://token:secret@example.test',
      });
      return { reason: 'completed' };
    });

    const processing = getInternal().processMessage(makeMessage({ isDirect: false }), channel, 'full');
    await vi.waitFor(() => expect(getPendingIMConfirmationCount()).toBe(1));
    await waitForIMConfirmationPrompt();
    const prompt = mockSendFinal.mock.calls.find(([, body]) =>
      typeof body?.content === 'string' && body.content.includes('group confirm command'),
    )?.[1]?.content;

    expect(prompt).toContain('group confirm command');
    expect(prompt).toContain('details hidden for group chat');
    expect(prompt).toContain('reply 1/2');
    for (const secret of ['X-API-Key', 'sk-group-secret', 'PASSWORD', 'hunter2', 'user:pass', '/Users/alice', 'private.env', 'token:secret']) {
      expect(prompt).not.toContain(secret);
    }
    expect(consumeIMConfirmationReply(makeMessage({ text: '2' }))).toBe(true);
    await processing;
    delete mockChannels[channel.id];
  });

  it('hides delete_file path details in group IM confirmation prompts', async () => {
    const channel = makeChannel({ capability: 'full', allowedUsers: ['u1'] });
    mockChannels[channel.id] = channel;
    authGateMocks.resolveCapability.mockReturnValue({ allowed: true, capability: 'full' });
    mockRunAgentLoop.mockImplementation(async (_convId: string, _text: string, options: {
      filePermissionCallback: (request: { path: string; capability: 'write'; toolName: string }) => Promise<boolean>;
    }) => {
      await options.filePermissionCallback({
        path: '/Users/alice/Projects/acme/PASSWORD-hunter2-X-API-Key-secret.env',
        capability: 'write',
        toolName: 'delete_file',
      });
      return { reason: 'completed' };
    });

    const processing = getInternal().processMessage(makeMessage({ isDirect: false }), channel, 'full');
    await vi.waitFor(() => expect(getPendingIMConfirmationCount()).toBe(1));
    await waitForIMConfirmationPrompt();
    const prompt = mockSendFinal.mock.calls.find(([, body]) =>
      typeof body?.content === 'string' && body.content.includes('group confirm delete'),
    )?.[1]?.content;

    expect(prompt).toContain('group confirm delete');
    expect(prompt).toContain('details hidden for group chat');
    for (const secret of ['PASSWORD', 'hunter2', 'X-API-Key', '/Users/alice', 'secret.env']) {
      expect(prompt).not.toContain(secret);
    }
    expect(consumeIMConfirmationReply(makeMessage({ text: '2' }))).toBe(true);
    await processing;
    delete mockChannels[channel.id];
  });

  it.each([
    ['read', 'read_file', 'group confirm file read'] as const,
    ['write', 'write_file', 'group confirm file write'] as const,
  ])('hides out-of-scope %s path details in group IM confirmation prompts', async (capability, toolName, fixedPrompt) => {
    const channel = makeChannel({ capability: 'full', allowedUsers: ['u1'] });
    mockChannels[channel.id] = channel;
    authGateMocks.resolveCapability.mockReturnValue({ allowed: true, capability: 'full' });
    mockRunAgentLoop.mockImplementation(async (_convId: string, _text: string, options: {
      filePermissionCallback: (request: { path: string; capability: 'read' | 'write'; toolName: string }) => Promise<boolean>;
    }) => {
      await options.filePermissionCallback({
        path: `/Users/alice/Projects/acme/${toolName}-PASSWORD-hunter2-X-API-Key-secret.md`,
        capability,
        toolName,
      });
      return { reason: 'completed' };
    });

    const processing = getInternal().processMessage(makeMessage({ isDirect: false }), channel, 'full');
    await vi.waitFor(() => expect(getPendingIMConfirmationCount()).toBe(1));
    await waitForIMConfirmationPrompt();
    const prompt = mockSendFinal.mock.calls.find(([, body]) =>
      typeof body?.content === 'string' && body.content.includes(fixedPrompt),
    )?.[1]?.content;

    expect(prompt).toContain(fixedPrompt);
    expect(prompt).toContain('details hidden for group chat');
    for (const secret of ['PASSWORD', 'hunter2', 'X-API-Key', '/Users/alice', 'secret.md', toolName]) {
      expect(prompt).not.toContain(secret);
    }
    expect(consumeIMConfirmationReply(makeMessage({ text: '2' }))).toBe(true);
    await processing;
    delete mockChannels[channel.id];
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

  it('waits for the cancelled run to settle before surfacing timeout', async () => {
    let settleRun!: () => void;
    const slow = new Promise<void>((resolve) => { settleRun = resolve; });
    const onTimeout = vi.fn();
    let rejected = false;
    let rejection: unknown;

    const observed = getInternal().runWithTimeout(slow, 10, onTimeout).catch((error) => {
      rejected = true;
      rejection = error;
    });

    await vi.waitFor(() => expect(onTimeout).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(rejected).toBe(false);

    settleRun();
    await observed;
    expect(rejected).toBe(true);
    expect(rejection).toEqual(expect.objectContaining({ message: expect.stringContaining('timed out') }));
  });

  it('bounds abort settlement wait and exposes the still-running settlement for quarantine', async () => {
    vi.useFakeTimers();
    try {
      let settleRun!: () => void;
      const stuck = new Promise<void>((resolve) => { settleRun = resolve; });
      const onTimeout = vi.fn();
      let rejection: unknown;

      const observed = getInternal()
        .runWithTimeout(stuck, 10, onTimeout, 20)
        .catch((error) => { rejection = error; });

      await vi.advanceTimersByTimeAsync(29);
      expect(onTimeout).toHaveBeenCalledOnce();
      expect(rejection).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      await observed;
      expect(rejection).toEqual(expect.objectContaining({
        name: 'TimedOutRunStillActiveError',
        message: expect.stringContaining('timed out'),
        settlement: expect.any(Promise),
      }));

      let quarantinedRunSettled = false;
      const settlement = (rejection as { settlement: Promise<void> }).settlement
        .then(() => { quarantinedRunSettled = true; });
      await Promise.resolve();
      expect(quarantinedRunSettled).toBe(false);

      settleRun();
      await settlement;
      expect(quarantinedRunSettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
