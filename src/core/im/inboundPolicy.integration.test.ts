import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Trigger } from '@/types/trigger';

let channels: typeof import('@/stores/imChannelStore')['useIMChannelStore'];
let triggers: typeof import('@/stores/triggerStore')['useTriggerStore'];
let engine: typeof import('@/core/trigger/triggerEngine')['triggerEngine'];
let inbound: typeof import('./inboundDispatcher');
let parse: typeof import('./inboundRouter')['parseInboundMessage'];
let approvals: typeof import('./pendingApprovals');
let channelId: string;
let triggerId: string;

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, ts: 'sent' })));
  channels = (await import('@/stores/imChannelStore')).useIMChannelStore;
  triggers = (await import('@/stores/triggerStore')).useTriggerStore;
  engine = (await import('@/core/trigger/triggerEngine')).triggerEngine;
  inbound = await import('./inboundDispatcher');
  parse = (await import('./inboundRouter')).parseInboundMessage;
  approvals = await import('./pendingApprovals');
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
  inbound.stopInboundDispatcher();
  approvals.__resetPendingApprovalsForTests();
  engine.stop();
  channels.setState({ channels: {} });
  triggers.setState({ triggers: {} });
  channelId = channels.getState().addChannel({
    platform: 'feishu', name: 'Inbound policy', appId: 'test-app', appSecret: 'test-secret',
  });
  triggerId = triggers.getState().createTrigger({
    name: 'Incoming event', source: { type: 'im', channelId, listenScope: 'all' },
    filter: { type: 'always' }, action: { prompt: 'Summarize the event.' },
    debounce: { enabled: false, windowSeconds: 60 },
  });
  const registration = engine as unknown as { registerIMTrigger(trigger: Trigger): void };
  registration.registerIMTrigger(triggers.getState().triggers[triggerId]);
});

afterEach(async () => {
  await vi.advanceTimersByTimeAsync(120_000);
  engine.stop();
  inbound.stopInboundDispatcher();
  vi.useRealTimers();
});

function event(id: string, chatId = 'chat-one') {
  return { event: {
    sender: { sender_type: 'user', sender_id: { open_id: 'person-one' } },
    message: { message_id: id, chat_id: chatId, chat_type: 'p2p', content: JSON.stringify({ text: 'Hello' }) },
  } };
}

function runs() {
  return triggers.getState().triggers[triggerId].runs;
}

describe('inbound policy through real parsing and trigger execution', () => {
  it('preserves DingTalk message identity independently from its reply webhook', () => {
    const message = parse('dingtalk', {
      msgId: 'ding-message', conversationId: 'ding-chat', senderStaffId: 'ding-user',
      text: { content: 'Hello' }, sessionWebhook: 'https://oapi.dingtalk.com/test-session',
    });
    expect(message).toMatchObject({ messageId: 'ding-message', chatId: 'ding-chat' });
    expect(message?.replyContext).toEqual({
      platform: 'dingtalk', chatId: 'ding-chat', sessionWebhook: 'https://oapi.dingtalk.com/test-session',
    });
  });

  it('accepts one platform event once even with content debounce disabled', async () => {
    inbound.dispatchDirect('feishu', event('repeated'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs()).toHaveLength(1);
    inbound.dispatchDirect('feishu', event('repeated'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs()).toHaveLength(1);
  });

  it('accepts identical text in distinct messages and distinct chats', async () => {
    for (const payload of [event('first'), event('second'), event('second', 'chat-two')]) {
      inbound.dispatchDirect('feishu', payload);
      await vi.advanceTimersByTimeAsync(120_000);
    }
    expect(runs()).toHaveLength(3);
  });

  it('expires replay protection after thirty minutes', async () => {
    inbound.dispatchDirect('feishu', event('expired'));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    inbound.dispatchDirect('feishu', event('expired'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs()).toHaveLength(2);
  });

  it('accepts messages without an identity and clears identities when stopped', async () => {
    for (const id of ['', '', 'restart']) {
      inbound.dispatchDirect('feishu', event(id));
      await vi.advanceTimersByTimeAsync(120_000);
    }
    inbound.stopInboundDispatcher();
    inbound.dispatchDirect('feishu', event('restart'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs()).toHaveLength(4);
  });

  it('does not match a disabled channel while another channel remains enabled', () => {
    channels.getState().addChannel({ platform: 'feishu', name: 'Other', appId: 'other', appSecret: 'secret' });
    channels.getState().updateChannel(channelId, { enabled: false });
    expect(engine.tryMatchIMTriggers(parse('feishu', event('disabled'))!)).toBe(0);
    expect(runs()).toHaveLength(0);
  });

  it.each(['bot', 'app'])('rejects Feishu sender_type=%s before any trigger runs', (senderType) => {
    const payload = event('robot');
    payload.event.sender.sender_type = senderType;
    expect(parse('feishu', payload)).toBeNull();
  });

  it('rejects a queued IM event when its channel was disabled before retry', async () => {
    const first = engine.handleEvent(triggerId, { data: { text: 'First event' } });
    await engine.handleEvent(triggerId, { data: { text: 'Queued event' } });
    channels.getState().updateChannel(channelId, { enabled: false });
    await vi.advanceTimersByTimeAsync(120_000);
    await first;
    expect(runs()).toHaveLength(1);
  });

  it('does not let a replayed Slack approval answer the next pending question', async () => {
    const id = channels.getState().addChannel({
      platform: 'slack', name: 'Approvals', appId: 'slack', appSecret: 'test-token',
    });
    const imTarget = { platform: 'slack' as const, channelId: id, chatId: 'C1', senderId: 'U1' };
    const first = approvals.requestImApproval({ conversationId: 'first', imTarget, prompt: 'Approve first?' });
    const second = approvals.requestImApproval({ conversationId: 'second', imTarget, prompt: 'Approve second?' });
    await vi.advanceTimersByTimeAsync(0);
    expect(approvals.pendingApprovalCountForTests()).toBe(2);
    const answer = (ts: string) => ({ event: {
      type: 'message', ts, user: 'U1', channel: 'C1', channel_type: 'im', text: 'yes',
    } });
    inbound.dispatchDirect('slack', answer('1.000001'));
    expect(await first).toBe('approved');
    await vi.advanceTimersByTimeAsync(11_000);
    inbound.dispatchDirect('slack', answer('1.000001'));
    expect(approvals.pendingApprovalCountForTests()).toBe(1);
    expect(runs()).toHaveLength(0);
    inbound.dispatchDirect('slack', answer('2.000001'));
    expect(await second).toBe('approved');
    expect(approvals.pendingApprovalCountForTests()).toBe(0);
  });

  it.each([{ bot_id: 'B123' }, { bot_profile: { id: 'B123' } }])(
    'rejects Slack robot messages without a subtype: %j', (robot) => {
      expect(parse('slack', { event: {
        type: 'message', user: 'U123', channel: 'C123', text: 'Automated result', ...robot,
      } })).toBeNull();
    },
  );
});
