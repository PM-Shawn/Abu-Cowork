/**
 * inboundDispatcher — adapter-provided text/images must survive the re-parse.
 *
 * Regression: the dispatcher re-parses the raw payload via parseInboundMessage,
 * which can only produce a bare "[文件: name]" for an attachment. That silently
 * overwrote the adapter's own text, dropping the local path it had just
 * downloaded the file to — so the agent was handed a filename it could not open
 * and answered "拒绝访问" for a file the user had just sent.
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

vi.mock('../../utils/tauriEnv', () => ({ isTauriEnv: () => false }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const mockConsume = vi.fn(() => false);
vi.mock('./pendingApprovals', () => ({
  tryConsumeApprovalReply: (...a: unknown[]) => mockConsume(...(a as [])),
}));

import { dispatchDirect } from './inboundDispatcher';

function parsed(overrides: Partial<NormalizedIMMessage> = {}): NormalizedIMMessage {
  return {
    senderId: 'u1', senderName: 'u', text: '[文件: report.pdf]',
    isMention: false, isDirect: true, chatId: 'c1',
    platform: 'wechat',
    replyContext: { platform: 'wechat', chatId: 'c1' },
    raw: {},
    ...overrides,
  };
}

describe('dispatchDirect', () => {
  beforeEach(() => {
    mockParse.mockReset().mockReturnValue(parsed());
    mockDispatchMessage.mockReset();
    mockTryMatch.mockReset().mockReturnValue(0);
    mockConsume.mockReset().mockReturnValue(false);
  });

  // A pending approval's answer ("同意") is a reply to a question Abu asked,
  // not a new instruction. Forwarding it would leave the blocked run waiting
  // AND hand the model a one-word prompt to invent work from.
  it('consumes an approval answer before triggers or the model see it', () => {
    mockConsume.mockReturnValue(true);

    dispatchDirect('feishu', {}, undefined, '同意');

    expect(mockConsume).toHaveBeenCalledTimes(1);
    // The hook sees the FINAL message, after the adapter's text won.
    expect((mockConsume.mock.calls[0] as unknown as [{ text: string }])[0].text).toBe('同意');
    expect(mockTryMatch).not.toHaveBeenCalled();
    expect(mockDispatchMessage).not.toHaveBeenCalled();
  });

  it('routes normally when the message is not an approval answer', () => {
    dispatchDirect('feishu', {}, undefined, '同意书在哪');

    expect(mockConsume).toHaveBeenCalledTimes(1);
    expect(mockDispatchMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the adapter's text, which carries the downloaded file path", () => {
    const adapterText = '[文件: report.pdf, 路径: /tmp/wechat-1-ab.pdf]';
    dispatchDirect('wechat', {}, undefined, adapterText);

    expect(mockDispatchMessage).toHaveBeenCalledTimes(1);
    expect(mockDispatchMessage.mock.calls[0][0].text).toBe(adapterText);
  });

  it('falls back to the parsed text when the adapter supplies none', () => {
    dispatchDirect('wechat', {});
    expect(mockDispatchMessage.mock.calls[0][0].text).toBe('[文件: report.pdf]');
  });

  it('attaches adapter images alongside', () => {
    const images = [{ id: 'i1', data: 'AAA', mediaType: 'image/jpeg' as const }];
    dispatchDirect('wechat', {}, images, '');
    expect(mockDispatchMessage.mock.calls[0][0].images).toEqual(images);
    expect(mockDispatchMessage.mock.calls[0][0].text).toBe('');
  });
});
