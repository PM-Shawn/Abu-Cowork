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

vi.mock('../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      conversations: { 'conv-new': { messages: [] } },
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
    replyContext: { platform: 'dchat', vchannelId: 'vc1' },
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
      replyContext: { platform: 'slack', channelId: 'C1', threadTs: '123.456' },
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
});
