import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useIMChannelStore } from '@/stores/imChannelStore';
import type { IMChannel } from '@/types/imChannel';

let manager: typeof import('./wechatConnectionManager');
const expiredTokens = new Set<string>();
const pendingResponses = new Set<(response: Response) => void>();

const fetchUpdates: typeof fetch = async (input, init) => {
  if (String(input) !== 'https://wechat.example.test/ilink/bot/getupdates') {
    throw new Error(`Unexpected network request: ${String(input)}`);
  }
  const token = new Headers(init?.headers).get('authorization');
  if (token && expiredTokens.has(token)) return Response.json({ ret: -14 });
  return new Promise<Response>((resolve) => pendingResponses.add(resolve));
};

function channel(id: string, appSecret = JSON.stringify({
  botToken: id, baseurl: 'wechat.example.test', ilinkBotId: id,
})): IMChannel {
  return {
    id, platform: 'wechat', name: id, appId: id, appSecret,
    capability: 'safe_tools', responseMode: 'mention_only', allowedUsers: [],
    workspacePaths: [], sessionTimeoutMinutes: 0, maxRoundsPerSession: 0,
    enabled: true, status: 'disconnected', createdAt: 0, updatedAt: 0,
  };
}

describe('WeChat connection error classification', () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchUpdates);
    manager = await import('./wechatConnectionManager');
    useIMChannelStore.setState({ channels: {}, sessions: {}, archivedSessions: {} });
    manager.startWeChatManager();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    initLanguage('en-US');
    expiredTokens.clear();
    useIMChannelStore.setState({ channels: {}, sessions: {}, archivedSessions: {} });
  });

  afterEach(async () => {
    manager.stopWeChatManager();
    await Promise.resolve();
    for (const respond of pendingResponses) respond(Response.json({ ret: 0, msgs: [] }));
    pendingResponses.clear();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });

  afterAll(() => vi.unstubAllGlobals());

  it('classifies an explicit iLink expiry separately from a service error', async () => {
    expiredTokens.add('Bearer first');
    useIMChannelStore.setState({ channels: { first: channel('first') } });
    await vi.advanceTimersByTimeAsync(0);
    expect(useIMChannelStore.getState().channels.first.status).toBe('auth_expired');
  });

  it('attributes each expiry to the account whose polling response reported it', async () => {
    expiredTokens.add('Bearer first');
    expiredTokens.add('Bearer second');
    useIMChannelStore.setState({ channels: { first: channel('first') } });
    await vi.advanceTimersByTimeAsync(0);
    useIMChannelStore.setState((state) => ({
      channels: { ...state.channels, second: channel('second') },
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(useIMChannelStore.getState().channels.second.status).toBe('auth_expired');
    expect(useIMChannelStore.getState().channels.first.status).toBe('auth_expired');
  });

  it('keeps a connection setup failure as a general error', async () => {
    useIMChannelStore.setState({ channels: { first: channel('first', 'invalid-json') } });
    await vi.advanceTimersByTimeAsync(0);
    const failed = useIMChannelStore.getState().channels.first;
    expect(failed.status).toBe('error');
    expect(failed.lastError).toMatch(/JSON|Unexpected token/);
  });

  it('preserves authentication expiry until a new connection lifecycle begins', async () => {
    expiredTokens.add('Bearer first');
    useIMChannelStore.setState({ channels: { first: channel('first') } });
    await vi.advanceTimersByTimeAsync(0);
    const { setChannelStatus } = useIMChannelStore.getState();
    setChannelStatus('first', 'connected');
    setChannelStatus('first', 'error', 'A pending task failed');
    expect(useIMChannelStore.getState().channels.first.status).toBe('auth_expired');
    expect(useIMChannelStore.getState().channels.first.lastError).toBeUndefined();
    setChannelStatus('first', 'connecting');
    setChannelStatus('first', 'connected');
    expect(useIMChannelStore.getState().channels.first.status).toBe('connected');
    setChannelStatus('first', 'error', 'Connection failed');
    expect(useIMChannelStore.getState().channels.first.lastError).toBe('Connection failed');
    setChannelStatus('first', 'disconnected');
    expect(useIMChannelStore.getState().channels.first.status).toBe('disconnected');
  });
});
