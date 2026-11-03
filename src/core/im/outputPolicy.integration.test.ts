import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriggerOutput } from '@/types/trigger';

let sender: typeof import('./outputSender')['outputSender'];
let channels: typeof import('@/stores/imChannelStore')['useIMChannelStore'];
let tokens: typeof import('./tokenManager')['tokenManager'];
let scheduler: typeof import('@/core/scheduler/scheduler')['schedulerEngine'];
const requests: { url: string; body: Record<string, unknown> }[] = [];
const fetchBoundary = vi.fn<typeof fetch>();
let channelId: string;

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchBoundary);
  sender = (await import('./outputSender')).outputSender;
  channels = (await import('@/stores/imChannelStore')).useIMChannelStore;
  tokens = (await import('./tokenManager')).tokenManager;
  scheduler = (await import('@/core/scheduler/scheduler')).schedulerEngine;
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
  channels.setState({ channels: {} });
  tokens.clear();
  requests.length = 0;
  fetchBoundary.mockReset().mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
    return Response.json(url.includes('/auth/')
      ? { code: 0, tenant_access_token: 'test-token', expire: 7200 }
      : { code: 0, data: { message_id: 'sent-message' } });
  });
  channelId = channels.getState().addChannel({
    name: 'Output policy', platform: 'feishu', appId: 'test-app', appSecret: 'test-secret',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function output(overrides: Partial<TriggerOutput> = {}): TriggerOutput {
  return {
    enabled: true, target: 'im_channel', outputChannelId: channelId,
    outputChatIds: 'chat-one', extractMode: 'last_message', ...overrides,
  };
}

describe('automatic IM output policy through real adapters', () => {
  it('does not acquire credentials or send results for a disabled channel', async () => {
    channels.getState().updateChannel(channelId, { enabled: false });
    expect((await sender.send(output(), { content: 'Completed' })).success).toBe(false);
    expect(requests).toEqual([]);
  });

  it('rechecks the channel after token acquisition', async () => {
    fetchBoundary.mockImplementationOnce(async (input) => {
      requests.push({ url: String(input), body: {} });
      channels.getState().updateChannel(channelId, { enabled: false });
      return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    });
    expect((await sender.send(output(), { content: 'Completed' })).success).toBe(false);
    expect(requests.map(request => request.url)).toEqual([
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    ]);
  });

  it('does not send when the channel is removed during token acquisition', async () => {
    fetchBoundary.mockImplementationOnce(async () => {
      channels.getState().removeChannel(channelId);
      return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    });
    expect((await sender.send(output(), { content: 'Completed' })).success).toBe(false);
    expect(fetchBoundary).toHaveBeenCalledTimes(1);
  });

  it('blocks a disabled DingTalk channel before its session webhook', async () => {
    const id = channels.getState().addChannel({
      platform: 'dingtalk', name: 'DingTalk', appId: 'ding-app', appSecret: 'ding-secret',
    });
    channels.getState().updateChannel(id, { enabled: false });
    const result = await sender.send(output({ outputChannelId: id, outputChatIds: undefined }),
      { content: 'Completed' }, { platform: 'dingtalk', sessionWebhook: 'https://oapi.dingtalk.com/test-session' });
    expect(result.success).toBe(false);
    expect(requests).toEqual([]);
  });

  it('sends each recipient once while preserving chat and user address types', async () => {
    expect(await sender.send(output({
      outputChatIds: ' shared,shared, ,second ', outputUserIds: 'shared, shared',
    }), { content: 'Completed' })).toEqual({ success: true });
    expect(requests.filter(request => request.url.includes('/im/')).map(request => [
      new URL(request.url).searchParams.get('receive_id_type'), request.body.receive_id,
    ])).toEqual([['chat_id', 'shared'], ['chat_id', 'second'], ['open_id', 'shared']]);
  });

  it('deduplicates scheduled recipients before their separate sender calls', async () => {
    const taskData = {
      name: 'Scheduled result', outputChatIds: 'chat-one, chat-one',
      outputUserIds: 'person-one, person-one', outputChannelId: channelId,
    };
    const send = scheduler as unknown as {
      sendToTaskChats(task: typeof taskData, config: TriggerOutput, message: { content: string }): Promise<void>;
    };
    await send.sendToTaskChats(taskData, output({ outputChatIds: undefined }), { content: 'Completed' });
    expect(requests.filter(request => request.url.includes('/im/')).map(request => request.body.receive_id))
      .toEqual(['chat-one', 'person-one']);
  });

  it('keeps separate legitimate deliveries with identical content', async () => {
    await sender.send(output(), { content: 'Completed' });
    await sender.send(output(), { content: 'Completed' });
    expect(requests.filter(request => request.url.includes('/im/'))).toHaveLength(2);
  });
});
