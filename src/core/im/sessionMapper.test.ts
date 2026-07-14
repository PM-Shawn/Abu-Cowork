/**
 * SessionMapper Tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock stores
vi.mock('../../stores/imChannelStore', () => {
  const channels: Record<string, unknown> = {};
  const sessions: Record<string, unknown> = {};
  const archivedSessions: Record<string, unknown> = {};
  return {
    useIMChannelStore: {
      getState: () => ({
        channels,
        sessions,
        archivedSessions,
        upsertSession: vi.fn((key: string, session: unknown) => {
          sessions[key] = session;
        }),
        removeSession: vi.fn((key: string) => {
          delete sessions[key];
        }),
        incrementSessionRound: vi.fn((key: string) => {
          const s = sessions[key] as { messageCount: number; lastActiveAt: number } | undefined;
          if (s) {
            s.messageCount++;
            s.lastActiveAt = Date.now();
          }
        }),
        archiveSession: vi.fn((windowKey: string, session: unknown) => {
          archivedSessions[windowKey] = session;
        }),
        removeArchivedSession: vi.fn((windowKey: string) => {
          delete archivedSessions[windowKey];
        }),
      }),
    },
  };
});

// Mutable so individual tests can seed conversation messages (e.g. the
// getSessionContext "true first user message" test). Reset in beforeEach.
const mockConversations: Record<string, { messages: unknown[] }> = { 'conv-new': { messages: [] } };
vi.mock('../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      conversations: mockConversations,
      conversationIndex: { 'conv-new': { id: 'conv-new', title: '', messageCount: 0, createdAt: 0, updatedAt: 0 } },
      createConversation: vi.fn(() => 'conv-new'),
      renameConversation: vi.fn(),
    }),
  },
}));

import { SessionMapper } from './sessionMapper';
import type { NormalizedIMMessage } from './inboundRouter';
import type { IMChannel } from '../../types/imChannel';
import { useIMChannelStore } from '../../stores/imChannelStore';

function makeMessage(overrides: Partial<NormalizedIMMessage> = {}): NormalizedIMMessage {
  return {
    senderId: 'u1',
    senderName: '张三',
    text: 'hello',
    isMention: true,
    isDirect: false,
    chatId: 'chat1',
    platform: 'dchat',
    replyContext: { platform: 'dchat', chatId: 'vc1' },
    raw: {},
    ...overrides,
  };
}

function makeChannel(overrides: Partial<IMChannel> = {}): IMChannel {
  return {
    id: 'ch1',
    platform: 'dchat',
    name: 'Test',
    appId: 'app1',
    appSecret: 'secret1',
    capability: 'safe_tools',
    responseMode: 'mention_only',
    allowedUsers: [],
    workspacePaths: [],
    sessionTimeoutMinutes: 0,
    maxRoundsPerSession: 50,
    enabled: true,
    status: 'connected',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('SessionMapper', () => {
  let mapper: SessionMapper;

  beforeEach(() => {
    mapper = new SessionMapper();
    const store = useIMChannelStore.getState();
    for (const key of Object.keys(store.channels)) {
      delete store.channels[key];
    }
    for (const key of Object.keys(store.sessions)) {
      delete store.sessions[key];
    }
    for (const key of Object.keys(store.archivedSessions)) {
      delete store.archivedSessions[key];
    }
    // Reset the mutable conversations mock to the shared default.
    for (const key of Object.keys(mockConversations)) delete mockConversations[key];
    mockConversations['conv-new'] = { messages: [] };
  });

  it('creates new session for first message', () => {
    const result = mapper.resolve(makeMessage(), makeChannel(), 'safe_tools');
    expect(result.isNew).toBe(true);
    expect(result.session.userId).toBe('u1');
    expect(result.session.platform).toBe('dchat');
  });

  it('reuses existing session within timeout', () => {
    const msg = makeMessage();
    const channel = makeChannel();
    const first = mapper.resolve(msg, channel, 'safe_tools');
    expect(first.isNew).toBe(true);
    const second = mapper.resolve(msg, channel, 'safe_tools');
    expect(second.isNew).toBe(false);
  });

  it('never expires session when timeout=0', () => {
    const msg = makeMessage();
    const channel = makeChannel({ sessionTimeoutMinutes: 0 });
    mapper.resolve(msg, channel, 'safe_tools');

    const store = useIMChannelStore.getState();
    const session = store.sessions['dchat:chat1:u1:window'] as { lastActiveAt: number };
    if (session) session.lastActiveAt = Date.now() - 365 * 24 * 60 * 60 * 1000;

    const result = mapper.resolve(msg, channel, 'safe_tools');
    expect(result.isNew).toBe(false);
  });

  it('uses thread key for Slack with thread_ts', () => {
    const msg = makeMessage({
      platform: 'slack',
      replyContext: { platform: 'slack', chatId: 'C1', threadId: '123.456' },
    });
    const result = mapper.resolve(msg, makeChannel({ platform: 'slack' }), 'safe_tools');
    expect(result.session.key).toBe('slack:chat1:123.456');
  });

  it('uses window key with senderId for group chats', () => {
    const result = mapper.resolve(makeMessage(), makeChannel(), 'safe_tools');
    expect(result.session.key).toBe('dchat:chat1:u1:window');
  });

  it('uses window key without senderId for direct chats', () => {
    const result = mapper.resolve(
      makeMessage({ isDirect: true }),
      makeChannel(),
      'safe_tools',
    );
    expect(result.session.key).toBe('dchat:chat1:window');
  });

  it('creates new session after timeout (when timeout > 0)', () => {
    const msg = makeMessage();
    const channel = makeChannel({ sessionTimeoutMinutes: 30 });
    mapper.resolve(msg, channel, 'safe_tools');

    const store = useIMChannelStore.getState();
    const session = store.sessions['dchat:chat1:u1:window'] as { lastActiveAt: number };
    if (session) session.lastActiveAt = Date.now() - 31 * 60 * 1000;

    const result = mapper.resolve(msg, channel, 'safe_tools');
    expect(result.isNew).toBe(true);
  });

  it('does not use maxRoundsPerSession for session cutoff', () => {
    const msg = makeMessage();
    const channel = makeChannel({ maxRoundsPerSession: 2 });
    mapper.resolve(msg, channel, 'safe_tools');

    const store = useIMChannelStore.getState();
    const session = store.sessions['dchat:chat1:u1:window'] as { messageCount: number };
    if (session) session.messageCount = 100;

    const result = mapper.resolve(msg, channel, 'safe_tools');
    expect(result.isNew).toBe(false);
  });

  it('creates new session when conversation was deleted', () => {
    const msg = makeMessage();
    mapper.resolve(msg, makeChannel(), 'safe_tools');

    const store = useIMChannelStore.getState();
    const session = store.sessions['dchat:chat1:u1:window'] as { conversationId: string };
    if (session) session.conversationId = 'conv-deleted';

    const result = mapper.resolve(msg, makeChannel(), 'safe_tools');
    expect(result.isNew).toBe(true);
  });

  it('returns hasRecoverableSession hint after timeout', () => {
    const msg = makeMessage();
    const channel = makeChannel({ sessionTimeoutMinutes: 30 });
    mapper.resolve(msg, channel, 'safe_tools');

    const store = useIMChannelStore.getState();
    const session = store.sessions['dchat:chat1:u1:window'] as { lastActiveAt: number };
    if (session) session.lastActiveAt = Date.now() - 31 * 60 * 1000;

    const result = mapper.resolve(msg, channel, 'safe_tools');
    expect(result.isNew).toBe(true);
    expect(result.hasRecoverableSession).toBe(true);
  });

  it('recovers previous session on "继续上次"', () => {
    const channel = makeChannel({ sessionTimeoutMinutes: 30 });
    mapper.resolve(makeMessage(), channel, 'safe_tools');

    const store = useIMChannelStore.getState();
    const session = store.sessions['dchat:chat1:u1:window'] as { lastActiveAt: number };
    if (session) session.lastActiveAt = Date.now() - 31 * 60 * 1000;

    mapper.resolve(makeMessage({ text: 'new topic' }), channel, 'safe_tools');

    const recovered = mapper.resolve(
      makeMessage({ text: '继续上次' }),
      channel,
      'safe_tools',
    );
    expect(recovered.isRecovered).toBe(true);
  });

  it('resets session on "新对话"', () => {
    const channel = makeChannel();
    mapper.resolve(makeMessage(), channel, 'safe_tools');

    const result = mapper.resolve(
      makeMessage({ text: '新对话' }),
      channel,
      'safe_tools',
    );
    expect(result.isNew).toBe(true);
    expect(result.isReset).toBe(true);
  });

  it('peekSessionKey returns key without side effects', () => {
    const key = mapper.peekSessionKey(makeMessage());
    expect(key).toBe('dchat:chat1:u1:window');
    expect(Object.keys(useIMChannelStore.getState().sessions).length).toBe(0);
  });

  describe('cleanup', () => {
    it('removes expired sessions and archives them (when timeout > 0)', () => {
      const msg = makeMessage();
      const channel = makeChannel({ id: 'ch1', sessionTimeoutMinutes: 30 });
      mapper.resolve(msg, channel, 'safe_tools');

      const store = useIMChannelStore.getState();
      const key = 'dchat:chat1:u1:window';
      const session = store.sessions[key] as { lastActiveAt: number; channelId: string };
      if (session) session.lastActiveAt = Date.now() - 31 * 60 * 1000;
      (store.channels as Record<string, unknown>)['ch1'] = channel;

      mapper.cleanup();
      expect(store.sessions[key]).toBeUndefined();
    });

    it('does not expire sessions when timeout=0', () => {
      const msg = makeMessage();
      const channel = makeChannel({ id: 'ch1', sessionTimeoutMinutes: 0 });
      mapper.resolve(msg, channel, 'safe_tools');

      const store = useIMChannelStore.getState();
      const key = 'dchat:chat1:u1:window';
      const session = store.sessions[key] as { lastActiveAt: number; channelId: string };
      if (session) session.lastActiveAt = Date.now() - 365 * 24 * 60 * 60 * 1000;
      (store.channels as Record<string, unknown>)['ch1'] = channel;

      mapper.cleanup();
      expect(store.sessions[key]).toBeDefined();
    });

    it('cleans up archived sessions older than 24h', () => {
      const channel = makeChannel({ sessionTimeoutMinutes: 30 });
      mapper.resolve(makeMessage(), channel, 'safe_tools');

      const store = useIMChannelStore.getState();
      const key = 'dchat:chat1:u1:window';
      const session = store.sessions[key] as { lastActiveAt: number; channelId: string };
      if (session) session.lastActiveAt = Date.now() - 31 * 60 * 1000;
      (store.channels as Record<string, unknown>)['ch1'] = channel;

      mapper.cleanup();

      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
      mapper.cleanup();

      const recovered = mapper.resolve(
        makeMessage({ text: '继续上次' }),
        channel,
        'safe_tools',
      );
      expect(recovered.isRecovered).toBeUndefined();
      vi.restoreAllMocks();
    });
  });

  // message-storage P1 Step 7: getSessionContext must summarize from the TRUE
  // first user message + last AI message. Today conv.messages is full so
  // userMsgs[0] is the real first; this test pins that invariant so the
  // step-9 windowing follow-up (read __pinnedFirstRound) preserves it.
  describe('getSessionContext (P1 Step 7)', () => {
    // getSessionContext is private; access via bracket notation for a focused
    // unit test rather than routing through the recovery path.
    const ctx = (m: SessionMapper, convId: string): string =>
      (m as unknown as { getSessionContext: (id: string) => string }).getSessionContext(convId);

    it('summarizes the true first user message and the last AI message', () => {
      mockConversations['conv-ctx'] = {
        messages: [
          { id: 'u1', role: 'user', content: 'the very first question', timestamp: 1 },
          { id: 'a1', role: 'assistant', content: 'first answer', timestamp: 2 },
          { id: 'u2', role: 'user', content: 'a later follow-up', timestamp: 3 },
          { id: 'a2', role: 'assistant', content: 'the most recent answer', timestamp: 4 },
        ],
      };

      const summary = ctx(mapper, 'conv-ctx');

      // First half = true first user message (NOT the later follow-up).
      expect(summary).toContain('the very first question');
      expect(summary).not.toContain('a later follow-up');
      // Second half = last AI message (NOT the first answer).
      expect(summary).toContain('the most recent answer');
      expect(summary).not.toContain('first answer');
      expect(summary).toContain('→');
    });

    it('returns the empty-context placeholder when the conversation has no messages', () => {
      expect(ctx(mapper, 'conv-new')).toBe('(无上下文)');
    });

    it('returns empty string for an unknown conversation', () => {
      expect(ctx(mapper, 'does-not-exist')).toBe('');
    });
  });
});
