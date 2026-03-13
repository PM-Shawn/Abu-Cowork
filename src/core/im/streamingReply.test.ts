/**
 * StreamingReply Tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock adapter registry
const mockSendMessage = vi.fn();
const mockReplyToChat = vi.fn();
vi.mock('./adapters/registry', () => ({
  getAdapter: vi.fn((platform: string) => {
    if (platform === 'unknown') return null;
    return {
      config: {
        supportsMessageUpdate: platform === 'feishu' || platform === 'slack',
      },
      sendMessage: mockSendMessage,
      replyToChat: platform !== 'dingtalk' ? mockReplyToChat : undefined,
    };
  }),
}));

// Mock tokenManager
const mockGetToken = vi.fn();
const mockInvalidate = vi.fn();
vi.mock('./tokenManager', () => ({
  tokenManager: {
    getToken: (...args: unknown[]) => mockGetToken(...args),
    invalidate: (...args: unknown[]) => mockInvalidate(...args),
  },
}));

// Mock imChannelStore
const mockGetChannelsByPlatform = vi.fn();
vi.mock('../../stores/imChannelStore', () => ({
  useIMChannelStore: {
    getState: () => ({
      getChannelsByPlatform: mockGetChannelsByPlatform,
    }),
  },
}));

import { sendThinking, sendFinal } from './streamingReply';
import type { IMReplyContext } from '../../types/trigger';

function makeContext(overrides: Partial<IMReplyContext> = {}): IMReplyContext {
  return {
    platform: 'dingtalk',
    ...overrides,
  };
}

describe('sendThinking', () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    mockReplyToChat.mockReset();
    mockGetToken.mockReset();
    mockGetChannelsByPlatform.mockReturnValue([]);
  });

  it('returns a handle with platform info', async () => {
    const handle = await sendThinking('dingtalk', makeContext());
    expect(handle.platform).toBe('dingtalk');
    expect(handle.supportsUpdate).toBe(false);
  });

  it('marks Feishu/Slack as supportsUpdate', async () => {
    const feishu = await sendThinking('feishu', makeContext({ platform: 'feishu' }));
    expect(feishu.supportsUpdate).toBe(true);

    const slack = await sendThinking('slack', makeContext({ platform: 'slack' }));
    expect(slack.supportsUpdate).toBe(true);
  });

  it('sends thinking via sessionWebhook when available', async () => {
    mockSendMessage.mockResolvedValue(undefined);
    await sendThinking('dingtalk', makeContext({ sessionWebhook: 'https://hook.example.com' }));
    expect(mockSendMessage).toHaveBeenCalledOnce();
    expect(mockSendMessage.mock.calls[0][1].content).toBe('收到，正在分析...');
  });

  it('uses custom thinking text', async () => {
    mockSendMessage.mockResolvedValue(undefined);
    await sendThinking('dingtalk', makeContext({ sessionWebhook: 'https://hook.example.com' }), 'Please wait...');
    expect(mockSendMessage.mock.calls[0][1].content).toBe('Please wait...');
  });

  it('does not throw if sendMessage fails (best-effort)', async () => {
    mockSendMessage.mockRejectedValue(new Error('network'));
    const handle = await sendThinking('dingtalk', makeContext({ sessionWebhook: 'https://hook.example.com' }));
    expect(handle.platform).toBe('dingtalk');
  });

  it('tries API token reply for feishu when no sessionWebhook', async () => {
    mockGetChannelsByPlatform.mockReturnValue([{ enabled: true, appId: 'app1', appSecret: 'secret1' }]);
    mockGetToken.mockResolvedValue('token123');
    mockReplyToChat.mockResolvedValue({ messageId: 'msg1' });

    const handle = await sendThinking('feishu', makeContext({ platform: 'feishu', chatId: 'chat1' }));
    expect(mockReplyToChat).toHaveBeenCalledOnce();
    expect(handle.placeholderMessageId).toBe('msg1');
  });

  it('does not crash if API token reply fails for thinking', async () => {
    mockGetChannelsByPlatform.mockReturnValue([{ enabled: true, appId: 'app1', appSecret: 'secret1' }]);
    mockGetToken.mockRejectedValue(new Error('token error'));

    const handle = await sendThinking('feishu', makeContext({ platform: 'feishu', chatId: 'chat1' }));
    expect(handle.platform).toBe('feishu');
    // Should not throw
  });
});

describe('sendFinal', () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    mockReplyToChat.mockReset();
    mockGetToken.mockReset();
    mockInvalidate.mockReset();
    mockGetChannelsByPlatform.mockReturnValue([]);
  });

  it('sends via sessionWebhook successfully', async () => {
    mockSendMessage.mockResolvedValue(undefined);
    const handle = {
      platform: 'dingtalk' as const,
      supportsUpdate: false,
      replyContext: makeContext({ sessionWebhook: 'https://hook.example.com' }),
    };
    const result = await sendFinal(handle, { content: 'Hello' });
    expect(result.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledOnce();
  });

  it('returns error if sessionWebhook send fails', async () => {
    mockSendMessage.mockRejectedValue(new Error('timeout'));
    const handle = {
      platform: 'dingtalk' as const,
      supportsUpdate: false,
      replyContext: makeContext({ sessionWebhook: 'https://hook.example.com' }),
    };
    const result = await sendFinal(handle, { content: 'Hello' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('timeout');
  });

  it('returns error for unknown platform', async () => {
    const handle = {
      platform: 'unknown' as never,
      supportsUpdate: false,
      replyContext: makeContext(),
    };
    const result = await sendFinal(handle, { content: 'Hello' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown platform');
  });

  it('uses API token reply for feishu with credentials', async () => {
    mockGetChannelsByPlatform.mockReturnValue([{ enabled: true, appId: 'app1', appSecret: 'secret1' }]);
    mockGetToken.mockResolvedValue('token123');
    mockReplyToChat.mockResolvedValue({ messageId: 'msg2' });

    const handle = {
      platform: 'feishu' as const,
      supportsUpdate: true,
      replyContext: makeContext({ platform: 'feishu', chatId: 'chat1', messageId: 'orig1' }),
    };
    const result = await sendFinal(handle, { content: 'Hello' });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(mockReplyToChat).toHaveBeenCalledOnce();
    expect(mockGetToken).toHaveBeenCalledWith('feishu', 'app1', 'secret1');
  });

  it('falls back to degraded success if API token reply fails', async () => {
    mockGetChannelsByPlatform.mockReturnValue([{ enabled: true, appId: 'app1', appSecret: 'secret1' }]);
    mockGetToken.mockRejectedValue(new Error('auth 401 error'));

    const handle = {
      platform: 'feishu' as const,
      supportsUpdate: true,
      replyContext: makeContext({ platform: 'feishu', chatId: 'chat1' }),
    };
    const result = await sendFinal(handle, { content: 'Hello' });
    expect(result.success).toBe(true);
    expect(result.error).toContain('no_direct_reply');
    // Should invalidate token on auth error
    expect(mockInvalidate).toHaveBeenCalledWith('feishu', 'app1');
  });

  it('returns degraded success when no credentials available', async () => {
    mockGetChannelsByPlatform.mockReturnValue([]);

    const handle = {
      platform: 'feishu' as const,
      supportsUpdate: true,
      replyContext: makeContext({ platform: 'feishu', chatId: 'chat1' }),
    };
    const result = await sendFinal(handle, { content: 'Hello' });
    expect(result.success).toBe(true);
    expect(result.error).toContain('no_direct_reply');
    expect(result.error).toContain('no_credentials');
  });

  it('sends via API for slack with bot token', async () => {
    mockGetChannelsByPlatform.mockReturnValue([{ enabled: true, appId: 'slack-app', appSecret: 'xoxb-token' }]);
    mockGetToken.mockResolvedValue('xoxb-token');
    mockReplyToChat.mockResolvedValue({ messageId: 'ts123' });

    const handle = {
      platform: 'slack' as const,
      supportsUpdate: true,
      replyContext: makeContext({ platform: 'slack', channelId: 'C123', threadTs: '123.456' }),
    };
    const result = await sendFinal(handle, { content: 'Hello from Slack' });
    expect(result.success).toBe(true);
    expect(mockReplyToChat).toHaveBeenCalledOnce();
  });
});
