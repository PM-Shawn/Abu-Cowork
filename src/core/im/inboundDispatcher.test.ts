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
import { useIMChannelStore } from '../../stores/imChannelStore';

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

const mockConsumeConfirmation = vi.fn(() => false);
vi.mock('./confirmationRelay', () => ({
  consumeIMConfirmationReply: (...a: unknown[]) => mockConsumeConfirmation(...a),
}));

const mockIsTauriEnv = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../utils/tauriEnv', () => ({ isTauriEnv: () => mockIsTauriEnv() }));

const mockListen = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => mockListen(...a) }));

import { dispatchDirect, startInboundDispatcher } from './inboundDispatcher';

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
    mockConsumeConfirmation.mockReset().mockReturnValue(false);
    mockIsTauriEnv.mockReturnValue(false);
    mockListen.mockReset().mockResolvedValue(vi.fn());
    useIMChannelStore.setState({ channels: {}, sessions: {}, archivedSessions: {} });
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

  it('does not consume direct WeChat messages with the webhook enabled-platform gate', () => {
    dispatchDirect('wechat', {});

    expect(mockParse).toHaveBeenCalledWith('wechat', {});
    expect(mockDispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('consumes numeric IM confirmation replies before triggers or channel routing', () => {
    mockConsumeConfirmation.mockReturnValue(true);
    dispatchDirect('wechat', {});

    expect(mockConsumeConfirmation).toHaveBeenCalledTimes(1);
    expect(mockTryMatch).not.toHaveBeenCalled();
    expect(mockDispatchMessage).not.toHaveBeenCalled();
  });

  it('also consumes exact-target invalid confirmation text before triggers or channel routing', () => {
    mockParse.mockReturnValue(parsed({ text: 'yes' }));
    mockConsumeConfirmation.mockReturnValue(true);
    dispatchDirect('wechat', {});

    expect(mockConsumeConfirmation).toHaveBeenCalledTimes(1);
    expect(mockTryMatch).not.toHaveBeenCalled();
    expect(mockDispatchMessage).not.toHaveBeenCalled();
  });

  it('lets wrong-target invalid text continue through the normal path', () => {
    mockParse.mockReturnValue(parsed({ text: 'yes' }));
    mockConsumeConfirmation.mockReturnValue(false);
    dispatchDirect('wechat', {});

    expect(mockTryMatch).toHaveBeenCalledTimes(1);
    expect(mockDispatchMessage).toHaveBeenCalledTimes(1);
  });
});

describe('startInboundDispatcher webhook gate', () => {
  beforeEach(() => {
    mockParse.mockReset().mockReturnValue(parsed({ platform: 'slack' }));
    mockDispatchMessage.mockReset();
    mockTryMatch.mockReset().mockReturnValue(0);
    mockConsumeConfirmation.mockReset().mockReturnValue(false);
    mockIsTauriEnv.mockReturnValue(true);
    mockListen.mockReset().mockResolvedValue(vi.fn());
    useIMChannelStore.setState({ channels: {}, sessions: {}, archivedSessions: {} });
  });

  it('drops webhook messages when no enabled channel exists for the platform', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await startInboundDispatcher();
    const listener = mockListen.mock.calls[0][1] as (event: { payload: { platform: string; payload: Record<string, unknown> } }) => void;

    listener({ payload: { platform: 'slack', payload: { text: 'secret' } } });

    expect(mockParse).not.toHaveBeenCalled();
    expect(mockTryMatch).not.toHaveBeenCalled();
    expect(mockDispatchMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[InboundDispatcher] Dropped webhook message for disabled platform: slack');
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('secret');
    warnSpy.mockRestore();
  });

  it('drops webhook messages when the platform channel has malformed truthy enabled', async () => {
    useIMChannelStore.setState({
      channels: {
        ch1: {
          id: 'ch1',
          platform: 'slack',
          name: 'Slack',
          appId: 'app',
          appSecret: 'secret',
          capability: 'safe_tools',
          responseMode: 'mention_only',
          allowedUsers: [],
          workspacePaths: [],
          sessionTimeoutMinutes: 0,
          maxRoundsPerSession: 50,
          enabled: 'yes' as never,
          status: 'connected',
          createdAt: 1,
          updatedAt: 1,
        },
      },
      sessions: {},
      archivedSessions: {},
    });
    await startInboundDispatcher();
    const listener = mockListen.mock.calls[0][1] as (event: { payload: { platform: string; payload: Record<string, unknown> } }) => void;

    listener({ payload: { platform: 'slack', payload: { text: 'hello' } } });

    expect(mockParse).not.toHaveBeenCalled();
    expect(mockDispatchMessage).not.toHaveBeenCalled();
  });

  it('allows webhook messages when the platform has an enabled channel', async () => {
    useIMChannelStore.setState({
      channels: {
        ch1: {
          id: 'ch1',
          platform: 'slack',
          name: 'Slack',
          appId: 'app',
          appSecret: 'secret',
          capability: 'safe_tools',
          responseMode: 'mention_only',
          allowedUsers: [],
          workspacePaths: [],
          sessionTimeoutMinutes: 0,
          maxRoundsPerSession: 50,
          enabled: true,
          status: 'connected',
          createdAt: 1,
          updatedAt: 1,
        },
      },
      sessions: {},
      archivedSessions: {},
    });
    await startInboundDispatcher();
    const listener = mockListen.mock.calls[0][1] as (event: { payload: { platform: string; payload: Record<string, unknown> } }) => void;

    listener({ payload: { platform: 'slack', payload: { text: 'hello' } } });

    expect(mockParse).toHaveBeenCalledWith('slack', { text: 'hello' });
    expect(mockDispatchMessage).toHaveBeenCalledTimes(1);
  });
});
