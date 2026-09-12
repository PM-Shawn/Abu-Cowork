/**
 * Webhook ingress gate (PR #312 P0-B, ported onto dev 2026-09-08).
 *
 * The trigger server's callback endpoint is reachable by anything that can
 * reach the port. A platform the user never enabled — or disabled since — must
 * be refused BEFORE its payload is parsed: turning a channel off is meant to
 * stop it, and the parser is the widest surface here.
 *
 * `dispatchDirect` is deliberately outside the gate: it carries messages a
 * polling adapter already authenticated and fetched itself (WeChat iLink), so
 * gating it would break a channel that never touches this endpoint. That
 * asymmetry is the point of the separate file — this one runs with
 * `isTauriEnv()` true so the listener actually installs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedIMMessage } from './inboundRouter';

const mockParse = vi.fn();
vi.mock('./inboundRouter', () => ({
  parseInboundMessage: (...args: unknown[]) => mockParse(...args),
}));
const mockTryMatch = vi.fn(() => 0);
vi.mock('../trigger/triggerEngine', () => ({
  triggerEngine: { tryMatchIMTriggers: (...a: unknown[]) => mockTryMatch(...a) },
}));
const mockDispatchMessage = vi.fn();
vi.mock('./channelRouter', () => ({
  imChannelRouter: { dispatchMessage: (...a: unknown[]) => mockDispatchMessage(...a) },
}));
vi.mock('./pendingApprovals', () => ({ tryConsumeApprovalReply: () => false }));
vi.mock('../../utils/tauriEnv', () => ({ isTauriEnv: () => true }));

type Listener = (event: { payload: { platform: string; payload: Record<string, unknown> } }) => void;
let listener: Listener | null = null;
vi.mock('@tauri-apps/api/event', () => ({
  listen: (_name: string, handler: Listener) => {
    listener = handler;
    return Promise.resolve(() => {});
  },
}));

const channels: Array<{ platform: string; enabled: unknown }> = [];
vi.mock('../../stores/imChannelStore', () => ({
  useIMChannelStore: {
    getState: () => ({
      getChannelsByPlatform: (platform: string) => channels.filter((c) => c.platform === platform),
    }),
  },
}));

import { dispatchDirect, startInboundDispatcher, stopInboundDispatcher } from './inboundDispatcher';

function parsed(): NormalizedIMMessage {
  return {
    senderId: 'u1', senderName: 'u', text: 'hello', isMention: false, isDirect: true,
    chatId: 'c1', platform: 'feishu', replyContext: { platform: 'feishu', chatId: 'c1' }, raw: {},
  };
}

async function fireWebhook(platform: string): Promise<void> {
  await startInboundDispatcher();
  listener?.({ payload: { platform, payload: { text: 'hello' } } });
}

describe('webhook ingress gate', () => {
  beforeEach(() => {
    channels.length = 0;
    listener = null;
    mockParse.mockReset().mockReturnValue(parsed());
    mockTryMatch.mockReset().mockReturnValue(0);
    mockDispatchMessage.mockReset();
    stopInboundDispatcher();
  });

  it('drops a webhook message for a platform with no channel at all — before parsing', async () => {
    await fireWebhook('feishu');
    expect(mockParse).not.toHaveBeenCalled();
    expect(mockTryMatch).not.toHaveBeenCalled();
    expect(mockDispatchMessage).not.toHaveBeenCalled();
  });

  it('drops it when every channel on that platform is disabled', async () => {
    channels.push({ platform: 'feishu', enabled: false });
    await fireWebhook('feishu');
    expect(mockParse).not.toHaveBeenCalled();
  });

  it('requires enabled to be exactly true, so a malformed store does not reopen ingress', async () => {
    channels.push({ platform: 'feishu', enabled: 'yes' });
    await fireWebhook('feishu');
    expect(mockParse).not.toHaveBeenCalled();
  });

  it('lets the message through when the platform has an enabled channel', async () => {
    channels.push({ platform: 'feishu', enabled: false }, { platform: 'feishu', enabled: true });
    await fireWebhook('feishu');
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(mockDispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('does not gate a channel that fetched the message itself (dispatchDirect)', () => {
    dispatchDirect('wechat', { text: 'hi' });
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(mockDispatchMessage).toHaveBeenCalledTimes(1);
  });
});
