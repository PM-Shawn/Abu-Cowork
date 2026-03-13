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
          timestamp: Date.now(),
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
});
