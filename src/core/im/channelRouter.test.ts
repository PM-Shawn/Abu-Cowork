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

// ── Import after mocks ──

import { imChannelRouter } from './channelRouter';

// Access private methods via type cast for testing
type RouterInternal = {
  processMessage(msg: NormalizedIMMessage, channel: IMChannel, capability: string): Promise<void>;
  runWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T>;
  runningCount: number;
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
    // Reset runningCount
    getInternal().runningCount = 0;
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
