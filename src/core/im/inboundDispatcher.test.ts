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
