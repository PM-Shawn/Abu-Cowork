/**
 * OutputSender Tests — message extraction, template replacement, buildMessage
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chatStore before importing outputSender
vi.mock('../../stores/chatStore', () => ({
  useChatStore: {
    getState: vi.fn(),
  },
}));

const mockImChannelStoreGetState = vi.fn(() => ({ channels: {} }));
vi.mock('../../stores/imChannelStore', () => ({
  useIMChannelStore: {
    getState: () => mockImChannelStoreGetState(),
  },
}));

const mockGetAdapter = vi.fn();
vi.mock('./adapters/registry', () => ({
  getAdapter: (...args: unknown[]) => mockGetAdapter(...args),
}));

const mockGetToken = vi.fn();
vi.mock('./tokenManager', () => ({
  tokenManager: {
    getToken: (...args: unknown[]) => mockGetToken(...args),
    invalidate: vi.fn(),
  },
}));

import { useChatStore } from '../../stores/chatStore';
import { outputSender } from './outputSender';
import type { TriggerOutput } from '../../types/trigger';
import type { OutputContext } from './adapters/types';

function mockConversation(messages: { role: string; content: string | { type: string; text?: string }[] }[]) {
  (useChatStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
    conversations: {
      'conv-1': {
        messages: messages.map((m, i) => ({
          id: `msg-${i}`,
          role: m.role,
          content: m.content,
          timestamp: 1_700_000_000_000, // filler (TESTING.md §3) — not asserted on
        })),
      },
    },
  });
}

describe('OutputSender.extractAIResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('last_message — returns last assistant message', () => {
    mockConversation([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'follow up' },
      { role: 'assistant', content: 'answer 2' },
    ]);
    expect(outputSender.extractAIResponse('conv-1', 'last_message')).toBe('answer 2');
  });

  it('last_message — no assistant → fallback', () => {
    mockConversation([{ role: 'user', content: 'question' }]);
    expect(outputSender.extractAIResponse('conv-1', 'last_message')).toBe('(无结果)');
  });

  it('full — all messages formatted', () => {
    mockConversation([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
    const result = outputSender.extractAIResponse('conv-1', 'full');
    expect(result).toContain('**事件**: q');
    expect(result).toContain('**Abu**: a');
  });

  it('custom_template — returns last assistant message', () => {
    mockConversation([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'template answer' },
    ]);
    expect(outputSender.extractAIResponse('conv-1', 'custom_template')).toBe('template answer');
  });

  it('handles multimodal content (MessageContent[])', () => {
    mockConversation([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'part 1' },
          { type: 'image', source: { data: '...' } },
          { type: 'text', text: 'part 2' },
        ],
      },
    ]);
    const result = outputSender.extractAIResponse('conv-1', 'last_message');
    expect(result).toBe('part 1\npart 2');
  });

  it('missing conversation → fallback', () => {
    (useChatStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      conversations: {},
    });
    expect(outputSender.extractAIResponse('nonexistent', 'last_message')).toBe('(无结果)');
  });
});

describe('OutputSender.buildMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('last_message mode builds correct AbuMessage', () => {
    mockConversation([
      { role: 'user', content: 'event' },
      { role: 'assistant', content: 'AI analysis result' },
    ]);

    const output: TriggerOutput = {
      enabled: true,
      target: 'webhook',
      platform: 'dchat',
      webhookUrl: 'https://example.com/hook',
      extractMode: 'last_message',
    };
    const context: OutputContext = {
      triggerName: 'Alert Monitor',
      aiResponse: '',
      timestamp: '2026-03-13 14:32',
    };

    const msg = outputSender.buildMessage('conv-1', output, context);
    expect(msg.content).toBe('AI analysis result');
    expect(msg.title).toBe('Alert Monitor');
    expect(msg.color).toBe('info');
    expect(msg.footer).toContain('Abu AI');
    expect(msg.footer).toContain('2026-03-13 14:32');
  });

  it('custom_template mode replaces variables', () => {
    mockConversation([
      { role: 'assistant', content: 'CPU is fine' },
    ]);

    const output: TriggerOutput = {
      enabled: true,
      target: 'webhook',
      platform: 'feishu',
      webhookUrl: 'https://example.com',
      extractMode: 'custom_template',
      customTemplate: '[$TRIGGER_NAME] $AI_RESPONSE (at $TIMESTAMP)',
    };
    const context: OutputContext = {
      triggerName: 'CPU Monitor',
      aiResponse: '',
      timestamp: '2026-03-13 15:00',
    };

    const msg = outputSender.buildMessage('conv-1', output, context);
    expect(msg.content).toBe('[CPU Monitor] CPU is fine (at 2026-03-13 15:00)');
  });

  it('template with all variables', () => {
    mockConversation([
      { role: 'assistant', content: 'ok' },
    ]);

    const output: TriggerOutput = {
      enabled: true,
      target: 'webhook',
      platform: 'custom',
      webhookUrl: 'https://x',
      extractMode: 'custom_template',
      customTemplate: '$TRIGGER_NAME|$EVENT_SUMMARY|$AI_RESPONSE|$RUN_TIME|$TIMESTAMP|$EVENT_DATA',
    };
    const context: OutputContext = {
      triggerName: 'T',
      eventSummary: 'E',
      aiResponse: '',
      runTime: '5s',
      timestamp: 'TS',
      eventData: '{"k":"v"}',
    };

    const msg = outputSender.buildMessage('conv-1', output, context);
    expect(msg.content).toBe('T|E|ok|5s|TS|{"k":"v"}');
  });

  /**
   * Batch-8 ruling — a `custom_template` payload is the user's, so the run's
   * ending is offered, never spliced in.
   *
   * The pin that matters is the first one: a template written before this
   * batch has to render byte-identically, because the usual template is a
   * JSON body somebody's script parses.
   */
  it('leaves a template that never asked for $RUN_OUTCOME byte-identical', () => {
    mockConversation([{ role: 'assistant', content: 'ok' }]);

    const output: TriggerOutput = {
      enabled: true,
      target: 'webhook',
      platform: 'custom',
      webhookUrl: 'https://x',
      extractMode: 'custom_template',
      customTemplate: '{"answer":"$AI_RESPONSE"}',
    };
    const context: OutputContext = {
      triggerName: 'T',
      aiResponse: '',
      timestamp: 'TS',
      runOutcome: 'Partly done: 1 of 2 browser actions failed',
    };

    const msg = outputSender.buildMessage('conv-1', output, context);
    expect(msg.content).toBe('{"answer":"ok"}');
    expect(JSON.parse(msg.content)).toEqual({ answer: 'ok' });
  });

  it('substitutes $RUN_OUTCOME where the template puts it, on one line', () => {
    mockConversation([{ role: 'assistant', content: 'ok' }]);

    const output: TriggerOutput = {
      enabled: true,
      target: 'webhook',
      platform: 'custom',
      webhookUrl: 'https://x',
      extractMode: 'custom_template',
      customTemplate: '{"outcome":"$RUN_OUTCOME","answer":"$AI_RESPONSE"}',
    };
    const context: OutputContext = {
      triggerName: 'T',
      aiResponse: '',
      timestamp: 'TS',
      runOutcome: 'Partly done: 1 of 2 browser actions failed',
    };

    const msg = outputSender.buildMessage('conv-1', output, context);
    // Still valid JSON: the variable is a single line by construction, so it
    // cannot break a string literal in the body the user wrote.
    expect(JSON.parse(msg.content)).toEqual({
      outcome: 'Partly done: 1 of 2 browser actions failed',
      answer: 'ok',
    });
  });

  it('renders an empty string when the caller reports no outcome at all', () => {
    mockConversation([{ role: 'assistant', content: 'ok' }]);

    const output: TriggerOutput = {
      enabled: true,
      target: 'webhook',
      platform: 'custom',
      webhookUrl: 'https://x',
      extractMode: 'custom_template',
      customTemplate: '[$RUN_OUTCOME]',
    };
    const context: OutputContext = { triggerName: 'T', aiResponse: '', timestamp: 'TS' };

    // Never the literal token: an unresolved `$RUN_OUTCOME` in a payload is
    // worse than nothing.
    expect(outputSender.buildMessage('conv-1', output, context).content).toBe('[]');
  });
});

describe('OutputSender.send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockImChannelStoreGetState.mockReturnValue({ channels: {} });
  });

  it('im_channel target — fails if no outputChannelId', async () => {
    const output: TriggerOutput = {
      enabled: true,
      target: 'im_channel',
      extractMode: 'last_message',
    };

    const result = await outputSender.send(output, { content: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No output channel ID');
  });

  it('im_channel target — fails if channel not found', async () => {
    mockImChannelStoreGetState.mockReturnValue({ channels: {} });

    const output: TriggerOutput = {
      enabled: true,
      target: 'im_channel',
      outputChannelId: 'nonexistent',
      extractMode: 'last_message',
    };

    const result = await outputSender.send(output, { content: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('im_channel target — sends via API token when adapter has replyToChat', async () => {
    mockImChannelStoreGetState.mockReturnValue({
      channels: {
        'ch-1': {
          id: 'ch-1',
          platform: 'feishu',
          appId: 'cli_x',
          appSecret: 'sec',
          name: 'FS Bot',
        },
      },
    });

    const mockReplyToChat = vi.fn().mockResolvedValue({ messageId: 'sent-1' });
    mockGetAdapter.mockReturnValue({
      replyToChat: mockReplyToChat,
    });
    mockGetToken.mockResolvedValue('token-123');

    const output: TriggerOutput = {
      enabled: true,
      target: 'im_channel',
      outputChannelId: 'ch-1',
      outputChatId: 'oc_target',
      extractMode: 'last_message',
    };

    const result = await outputSender.send(output, { content: 'alert result' });
    expect(result.success).toBe(true);
    expect(mockGetToken).toHaveBeenCalledWith('feishu', 'cli_x', 'sec');
    expect(mockReplyToChat).toHaveBeenCalledWith('token-123', { chatId: 'oc_target', receiveIdType: 'chat_id' }, { content: 'alert result' });
  });

  it('im_channel target — uses replyContext chatId when no outputChatId', async () => {
    mockImChannelStoreGetState.mockReturnValue({
      channels: {
        'ch-2': {
          id: 'ch-2',
          platform: 'feishu',
          appId: 'cli_y',
          appSecret: 'sec2',
          name: 'FS Bot 2',
        },
      },
    });

    const mockReplyToChat = vi.fn().mockResolvedValue({ messageId: 'sent-2' });
    mockGetAdapter.mockReturnValue({ replyToChat: mockReplyToChat });
    mockGetToken.mockResolvedValue('token-456');

    const output: TriggerOutput = {
      enabled: true,
      target: 'im_channel',
      outputChannelId: 'ch-2',
      // no outputChatId — should use replyContext
      extractMode: 'last_message',
    };

    const replyContext = { platform: 'feishu' as const, chatId: 'oc_from_reply' };

    const result = await outputSender.send(output, { content: 'reply' }, replyContext);
    expect(result.success).toBe(true);
    expect(mockReplyToChat).toHaveBeenCalledWith('token-456', { chatId: 'oc_from_reply', receiveIdType: 'chat_id' }, { content: 'reply' });
  });

  it('im_channel target — DingTalk uses sessionWebhook', async () => {
    mockImChannelStoreGetState.mockReturnValue({
      channels: {
        'ch-dt': {
          id: 'ch-dt',
          platform: 'dingtalk',
          appId: 'dt_app',
          appSecret: 'dt_sec',
          name: 'DT Bot',
        },
      },
    });

    const mockSendMessage = vi.fn().mockResolvedValue(undefined);
    mockGetAdapter.mockReturnValue({ sendMessage: mockSendMessage });

    const output: TriggerOutput = {
      enabled: true,
      target: 'im_channel',
      outputChannelId: 'ch-dt',
      extractMode: 'last_message',
    };

    const replyContext = {
      platform: 'dingtalk' as const,
      sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=xxx',
    };

    const result = await outputSender.send(output, { content: 'ding reply' }, replyContext);
    expect(result.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith(replyContext.sessionWebhook, { content: 'ding reply' });
  });

  it('webhook target — sends to webhook URL via adapter', async () => {
    const mockSendMessage = vi.fn().mockResolvedValue(undefined);
    mockGetAdapter.mockReturnValue({ sendMessage: mockSendMessage });

    const output: TriggerOutput = {
      enabled: true,
      target: 'webhook',
      platform: 'dchat',
      webhookUrl: 'https://example.com/hook',
      extractMode: 'last_message',
    };

    const result = await outputSender.send(output, { content: 'webhook msg' });
    expect(result.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith('https://example.com/hook', { content: 'webhook msg' }, undefined);
  });

  it('webhook target — fails if missing platform or URL', async () => {
    const output: TriggerOutput = {
      enabled: true,
      target: 'webhook',
      extractMode: 'last_message',
    };

    const result = await outputSender.send(output, { content: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing platform or webhookUrl');
  });
});
