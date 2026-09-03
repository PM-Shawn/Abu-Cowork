import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useIMChannelStore } from '../../stores/imChannelStore';
import type { IMConfirmationTarget } from './confirmationRelay';
import type { NormalizedIMMessage } from './inboundRouter';

const sendThinkingMock = vi.hoisted(() => vi.fn());
const sendFinalMock = vi.hoisted(() => vi.fn());

vi.mock('./streamingReply', () => ({
  sendThinking: (...a: unknown[]) => sendThinkingMock(...a),
  sendFinal: (...a: unknown[]) => sendFinalMock(...a),
}));

import {
  __getIMConfirmationNumericReplyGuardSizeForTests,
  __resetIMConfirmationRelayForTests,
  cancelAllIMConfirmations,
  consumeIMConfirmationReply,
  getPendingIMConfirmationCount,
  parseIMConfirmationReply,
  requestIMConfirmation,
} from './confirmationRelay';

let messageIdCounter = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function target(
  overrides: Partial<Omit<IMConfirmationTarget, 'replyContext'>> & {
    replyContext?: Partial<IMConfirmationTarget['replyContext']>;
  } = {},
): IMConfirmationTarget {
  const replyContext = {
    platform: 'slack' as const,
    chatId: 'chat-1',
    threadId: 'thread-1',
    messageId: 'target-turn-1',
    ...overrides.replyContext,
  };
  return {
    platform: 'slack',
    channelId: 'ch-1',
    senderId: 'u1',
    chatId: 'chat-1',
    threadId: 'thread-1',
    sessionKey: 'slack:chat-1:thread-1',
    conversationId: 'conv-1',
    replyContext,
    ...overrides,
    replyContext,
  };
}

function message(
  overrides: Partial<Omit<NormalizedIMMessage, 'replyContext'>> & {
    replyContext?: Partial<NormalizedIMMessage['replyContext']>;
  } = {},
): NormalizedIMMessage {
  const replyContext = {
    platform: 'slack' as const,
    chatId: 'chat-1',
    threadId: 'thread-1',
    messageId: `reply-${++messageIdCounter}`,
    ...overrides.replyContext,
  };
  return {
    platform: 'slack',
    senderId: 'u1',
    senderName: 'User',
    text: '1',
    chatId: 'chat-1',
    chatName: 'Chat',
    isDirect: true,
    isMention: false,
    replyContext,
    raw: {},
    ...overrides,
    replyContext,
  };
}

function enableChannel(): void {
  useIMChannelStore.setState({
    channels: {
      'ch-1': {
        id: 'ch-1',
        platform: 'slack',
        name: 'Slack',
        appId: 'app',
        appSecret: 'secret',
        capability: 'full',
        responseMode: 'mention_only',
        allowedUsers: ['u1'],
        workspacePaths: [],
        sessionTimeoutMinutes: 0,
        maxRoundsPerSession: 50,
        enabled: true,
        status: 'connected',
        createdAt: 1,
        updatedAt: 1,
      },
      'ch-2': {
        id: 'ch-2',
        platform: 'slack',
        name: 'Slack 2',
        appId: 'app',
        appSecret: 'secret',
        capability: 'full',
        responseMode: 'mention_only',
        allowedUsers: ['u1'],
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
}

describe('parseIMConfirmationReply', () => {
  it('accepts only trimmed ASCII 1 or 2', () => {
    expect(parseIMConfirmationReply('1')).toBe(true);
    expect(parseIMConfirmationReply(' 2\n')).toBe(false);
    expect(parseIMConfirmationReply('１')).toBeNull();
    expect(parseIMConfirmationReply('yes')).toBeNull();
    expect(parseIMConfirmationReply('1.')).toBeNull();
    expect(parseIMConfirmationReply('12')).toBeNull();
  });
});

describe('confirmationRelay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    messageIdCounter = 0;
    __resetIMConfirmationRelayForTests();
    enableChannel();
    sendThinkingMock.mockReset().mockResolvedValue({
      platform: 'slack',
      supportsUpdate: false,
      replyContext: { platform: 'slack', chatId: 'chat-1', threadId: 'thread-1' },
    });
    sendFinalMock.mockReset().mockResolvedValue({ success: true });
  });

  afterEach(() => {
    __resetIMConfirmationRelayForTests();
    vi.useRealTimers();
  });

  it('resolves true when the exact sender replies 1', async () => {
    const pending = requestIMConfirmation(target(), { content: 'confirm?' });

    expect(getPendingIMConfirmationCount()).toBe(1);
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));
    expect(consumeIMConfirmationReply(message({ text: '1' }))).toBe(true);
    await expect(pending).resolves.toBe(true);
  });

  it('matches the same session when the transport sessionWebhook token changes', async () => {
    const pending = requestIMConfirmation(
      target({ sessionWebhook: 'https://reply.example.com/token-a' }),
      { content: 'confirm?' },
    );
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));

    expect(consumeIMConfirmationReply(message({
      text: '1',
      replyContext: {
        platform: 'slack',
        chatId: 'chat-1',
        threadId: 'thread-1',
        sessionWebhook: 'https://reply.example.com/token-b',
      },
    }))).toBe(true);
    await expect(pending).resolves.toBe(true);
  });

  it('consumes but never approves numeric replies while the prompt is still sending', async () => {
    const send = deferred<{ success: boolean }>();
    sendFinalMock.mockReturnValueOnce(send.promise);

    const pending = requestIMConfirmation(target(), { content: 'confirm?' }, { timeoutMs: 1_000 });
    const earlyReply = message({ text: '1', replyContext: { messageId: 'early-1' } });

    expect(consumeIMConfirmationReply(earlyReply)).toBe(true);
    send.resolve({ success: true });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));
    expect(consumeIMConfirmationReply(earlyReply)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBe(false);
  });

  it('swallows non-matching numeric replies without settling the pending confirmation', async () => {
    const pending = requestIMConfirmation(target(), { content: 'confirm?' });

    expect(consumeIMConfirmationReply(message({ senderId: 'other', text: '1' }))).toBe(true);
    expect(getPendingIMConfirmationCount()).toBe(1);
    cancelAllIMConfirmations();
    await expect(pending).resolves.toBe(false);
  });

  it('swallows non-matching numeric chat or thread replies without settling the pending confirmation', async () => {
    const pending = requestIMConfirmation(target(), { content: 'confirm?' });

    expect(consumeIMConfirmationReply(message({ chatId: 'other-chat', text: '1' }))).toBe(true);
    expect(consumeIMConfirmationReply(message({
      text: '1',
      replyContext: { platform: 'slack', chatId: 'chat-1', threadId: 'other-thread' },
    }))).toBe(true);
    expect(getPendingIMConfirmationCount()).toBe(1);
    cancelAllIMConfirmations();
    await expect(pending).resolves.toBe(false);
  });

  it('defaults to false on timeout', async () => {
    const pending = requestIMConfirmation(target(), { content: 'confirm?' }, { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBe(false);
    expect(getPendingIMConfirmationCount()).toBe(0);
  });

  it('defaults to false on abort and clears the pending request', async () => {
    const controller = new AbortController();
    const pending = requestIMConfirmation(target(), { content: 'confirm?' }, { abortSignal: controller.signal });

    controller.abort();

    await expect(pending).resolves.toBe(false);
    expect(getPendingIMConfirmationCount()).toBe(0);
  });

  it('fails closed when sending the confirmation fails or degrades to conversation-only', async () => {
    sendFinalMock.mockResolvedValueOnce({ success: false, error: 'send failed' });
    await expect(requestIMConfirmation(target(), { content: 'confirm?' })).resolves.toBe(false);

    sendFinalMock.mockResolvedValueOnce({ success: true, error: 'no_direct_reply:slack:no_credentials' });
    await expect(requestIMConfirmation(target(), { content: 'confirm?' })).resolves.toBe(false);
  });

  it('does not let an old send-failure continuation settle a newer instance', async () => {
    const oldSend = deferred<{ success: boolean; error?: string }>();
    const newSend = deferred<{ success: boolean; error?: string }>();
    sendFinalMock
      .mockReturnValueOnce(oldSend.promise)
      .mockReturnValueOnce(newSend.promise);

    const oldPending = requestIMConfirmation(target(), { content: 'old' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));
    cancelAllIMConfirmations();
    await expect(oldPending).resolves.toBe(false);
    __resetIMConfirmationRelayForTests();
    enableChannel();

    const newPending = requestIMConfirmation(target(), { content: 'new' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(2));
    oldSend.resolve({ success: false, error: 'old failure' });
    await Promise.resolve();
    newSend.resolve({ success: true });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(consumeIMConfirmationReply(message({ text: '1' }))).toBe(true);
    await expect(newPending).resolves.toBe(true);
  });

  it('allows only one pending confirmation per session', async () => {
    const first = requestIMConfirmation(target(), { content: 'first' });

    await expect(requestIMConfirmation(target(), { content: 'second' })).resolves.toBe(false);
    cancelAllIMConfirmations();
    await expect(first).resolves.toBe(false);
  });

  it('fails closed when the channel is disabled before the user replies', async () => {
    const pending = requestIMConfirmation(target(), { content: 'confirm?' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));
    useIMChannelStore.setState((state) => ({
      channels: {
        ...state.channels,
        'ch-1': { ...state.channels['ch-1'], enabled: false },
      },
    }));

    expect(consumeIMConfirmationReply(message({ text: '1' }))).toBe(true);
    await expect(pending).resolves.toBe(false);
  });

  it('fails closed when the channel has malformed truthy enabled before the user replies', async () => {
    const pending = requestIMConfirmation(target(), { content: 'confirm?' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));
    useIMChannelStore.setState((state) => ({
      channels: {
        ...state.channels,
        'ch-1': { ...state.channels['ch-1'], enabled: 'yes' as never },
      },
    }));

    expect(consumeIMConfirmationReply(message({ text: '1' }))).toBe(true);
    await expect(pending).resolves.toBe(false);
  });

  it('fails closed when whitelist/capability no longer resolve to full before reply', async () => {
    const pending = requestIMConfirmation(target(), { content: 'confirm?' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));
    useIMChannelStore.setState((state) => ({
      channels: {
        ...state.channels,
        'ch-1': { ...state.channels['ch-1'], allowedUsers: ['someone-else'], updatedAt: 2 },
      },
    }));

    expect(consumeIMConfirmationReply(message({ text: '1' }))).toBe(true);
    await expect(pending).resolves.toBe(false);
  });

  it('fails closed when the channel platform changes before reply', async () => {
    const pending = requestIMConfirmation(target(), { content: 'confirm?' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));
    useIMChannelStore.setState((state) => ({
      channels: {
        ...state.channels,
        'ch-1': { ...state.channels['ch-1'], platform: 'feishu', updatedAt: 2 },
      },
    }));

    expect(consumeIMConfirmationReply(message({ text: '1' }))).toBe(true);
    await expect(pending).resolves.toBe(false);
  });

  it('fails closed on channel authority ABA even if it is enabled again before reply', async () => {
    const pending = requestIMConfirmation(target(), { content: 'confirm?' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));
    useIMChannelStore.setState((state) => ({
      channels: {
        ...state.channels,
        'ch-1': { ...state.channels['ch-1'], enabled: false, updatedAt: 2 },
      },
    }));
    useIMChannelStore.setState((state) => ({
      channels: {
        ...state.channels,
        'ch-1': { ...state.channels['ch-1'], enabled: true, updatedAt: 3 },
      },
    }));

    expect(consumeIMConfirmationReply(message({ text: '1' }))).toBe(true);
    await expect(pending).resolves.toBe(false);
  });

  it('consumes invalid text for the exact pending target, reminds once, and keeps waiting', async () => {
    const pending = requestIMConfirmation(
      target(),
      { content: 'confirm?' },
      { invalidReplyMessage: '只回复 1 或 2' },
    );
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));

    expect(consumeIMConfirmationReply(message({ text: 'ok' }))).toBe(true);
    expect(getPendingIMConfirmationCount()).toBe(1);
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(2));
    expect(sendFinalMock.mock.calls[1][1]).toEqual({ content: '只回复 1 或 2' });

    expect(consumeIMConfirmationReply(message({ text: '2' }))).toBe(true);
    await expect(pending).resolves.toBe(false);
  });

  it('lets invalid text from a wrong target continue through the normal path', async () => {
    const pending = requestIMConfirmation(target(), { content: 'confirm?' });

    expect(consumeIMConfirmationReply(message({ senderId: 'other', text: 'ok' }))).toBe(false);
    cancelAllIMConfirmations();
    await expect(pending).resolves.toBe(false);
  });

  it('keeps late numeric replies isolated until a fresh nonnumeric inbound intent opens a new boundary', async () => {
    const first = requestIMConfirmation(target(), { content: 'confirm?' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));

    expect(consumeIMConfirmationReply(message({ text: '2' }))).toBe(true);
    await expect(first).resolves.toBe(false);

    await expect(requestIMConfirmation(target(), { content: 'second?' })).resolves.toBe(false);
    expect(consumeIMConfirmationReply(message({ text: '1' }))).toBe(true);
    await expect(requestIMConfirmation(target(), { content: 'still blocked?' })).resolves.toBe(false);

    expect(consumeIMConfirmationReply(message({ text: 'delete that file' }))).toBe(false);
    await expect(requestIMConfirmation(target(), { content: 'still needs turn permit?' })).resolves.toBe(false);
    const second = requestIMConfirmation(
      target(),
      { content: 'confirm new intent?' },
      { allowRouteRearm: true },
    );
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(2));

    expect(consumeIMConfirmationReply(message({ text: '1' }))).toBe(true);
    await expect(second).resolves.toBe(true);
  });

  it('does not let an old confirmed 1 replay approve the next rearmed pending confirmation', async () => {
    const first = requestIMConfirmation(target(), { content: 'first?' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));

    expect(consumeIMConfirmationReply(message({ text: '1', replyContext: { messageId: 'id-A' } }))).toBe(true);
    await expect(first).resolves.toBe(true);

    expect(consumeIMConfirmationReply(message({ text: 'fresh turn', replyContext: { messageId: 'id-B' } }))).toBe(false);
    const second = requestIMConfirmation(target(), { content: 'second?' }, { allowRouteRearm: true });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(2));

    expect(consumeIMConfirmationReply(message({ text: '1', replyContext: { messageId: 'id-A' } }))).toBe(true);
    expect(getPendingIMConfirmationCount()).toBe(1);
    expect(consumeIMConfirmationReply(message({ text: '1', replyContext: { messageId: 'id-C' } }))).toBe(true);
    await expect(second).resolves.toBe(true);
  });

  it('does not let a numeric 1 first seen without a pending confirmation approve a later pending confirmation', async () => {
    expect(consumeIMConfirmationReply(message({ text: '1', replyContext: { messageId: 'id-A' } }))).toBe(true);

    const pending = requestIMConfirmation(target(), { content: 'confirm?' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));

    expect(consumeIMConfirmationReply(message({ text: '1', replyContext: { messageId: 'id-A' } }))).toBe(true);
    expect(getPendingIMConfirmationCount()).toBe(1);
    expect(consumeIMConfirmationReply(message({ text: '1', replyContext: { messageId: 'id-B' } }))).toBe(true);
    await expect(pending).resolves.toBe(true);
  });

  it('does not let an old cancelled 2 replay cancel the next rearmed pending confirmation', async () => {
    const first = requestIMConfirmation(target(), { content: 'first?' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));

    expect(consumeIMConfirmationReply(message({ text: '2', replyContext: { messageId: 'id-A' } }))).toBe(true);
    await expect(first).resolves.toBe(false);

    expect(consumeIMConfirmationReply(message({ text: 'fresh turn', replyContext: { messageId: 'id-B' } }))).toBe(false);
    const second = requestIMConfirmation(target(), { content: 'second?' }, { allowRouteRearm: true });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(2));

    expect(consumeIMConfirmationReply(message({ text: '2', replyContext: { messageId: 'id-A' } }))).toBe(true);
    expect(getPendingIMConfirmationCount()).toBe(1);
    expect(consumeIMConfirmationReply(message({ text: '1', replyContext: { messageId: 'id-C' } }))).toBe(true);
    await expect(second).resolves.toBe(true);
  });

  it('scopes numeric reply replay by route even when messageId is the same', async () => {
    const first = requestIMConfirmation(target(), { content: 'first?' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));
    expect(consumeIMConfirmationReply(message({ text: '1', replyContext: { messageId: 'shared-id' } }))).toBe(true);
    await expect(first).resolves.toBe(true);

    const otherTarget = target({
      chatId: 'chat-2',
      threadId: 'thread-2',
      sessionKey: 'slack:chat-2:thread-2',
      conversationId: 'conv-2',
      replyContext: { platform: 'slack', chatId: 'chat-2', threadId: 'thread-2' },
    });
    const second = requestIMConfirmation(otherTarget, { content: 'second?' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(2));
    expect(consumeIMConfirmationReply(message({
      text: '1',
      chatId: 'chat-2',
      replyContext: { chatId: 'chat-2', threadId: 'thread-2', messageId: 'shared-id' },
    }))).toBe(true);
    await expect(second).resolves.toBe(true);
  });

  it('fails closed for missing-ID 1 but still allows missing-ID 2 to cancel', async () => {
    const approve = requestIMConfirmation(target(), { content: 'approve?' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));

    expect(consumeIMConfirmationReply(message({ text: '1', replyContext: { messageId: undefined } }))).toBe(true);
    await expect(approve).resolves.toBe(false);

    __resetIMConfirmationRelayForTests();
    enableChannel();
    sendFinalMock.mockClear();

    const cancel = requestIMConfirmation(target(), { content: 'cancel?' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));
    expect(consumeIMConfirmationReply(message({ text: '2', replyContext: { messageId: undefined } }))).toBe(true);
    await expect(cancel).resolves.toBe(false);
  });

  it('does not retain or approve an overlong numeric reply messageId', async () => {
    const overlongMessageId = 'x'.repeat(513);
    const approve = requestIMConfirmation(target(), { content: 'approve?' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));

    expect(consumeIMConfirmationReply(message({ text: '1', replyContext: { messageId: overlongMessageId } }))).toBe(true);
    expect(__getIMConfirmationNumericReplyGuardSizeForTests()).toBe(0);
    await expect(approve).resolves.toBe(false);
  });

  it('does not retain numeric reply identities whose total key is too long', () => {
    expect(consumeIMConfirmationReply(message({
      platform: 'p'.repeat(500),
      senderId: 's'.repeat(500),
      chatId: 'c'.repeat(500),
      text: '1',
      replyContext: {
        platform: 'p'.repeat(500),
        chatId: 'c'.repeat(500),
        threadId: 't'.repeat(500),
        messageId: 'm'.repeat(500),
      },
    }))).toBe(true);
    expect(__getIMConfirmationNumericReplyGuardSizeForTests()).toBe(0);
  });

  it('keeps the numeric reply guard capped without evicting old IDs', async () => {
    for (let i = 0; i < 10_000; i++) {
      expect(consumeIMConfirmationReply(message({
        text: '1',
        replyContext: { messageId: `bulk-${i}` },
      }))).toBe(true);
    }
    expect(__getIMConfirmationNumericReplyGuardSizeForTests()).toBe(10_000);

    expect(consumeIMConfirmationReply(message({ text: '1', replyContext: { messageId: 'bulk-0' } }))).toBe(true);
    expect(__getIMConfirmationNumericReplyGuardSizeForTests()).toBe(10_000);

    const pending = requestIMConfirmation(target(), { content: 'overflow?' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));
    expect(consumeIMConfirmationReply(message({ text: '1', replyContext: { messageId: 'overflow' } }))).toBe(true);
    expect(__getIMConfirmationNumericReplyGuardSizeForTests()).toBe(10_000);
    await expect(pending).resolves.toBe(false);
  });

  it('keeps numeric reply IDs across cancellation and clears them only on test reset', async () => {
    const pending = requestIMConfirmation(target(), { content: 'confirm?' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(1));
    expect(consumeIMConfirmationReply(message({ text: '1', replyContext: { messageId: 'durable-id' } }))).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(__getIMConfirmationNumericReplyGuardSizeForTests()).toBe(1);

    cancelAllIMConfirmations();
    expect(__getIMConfirmationNumericReplyGuardSizeForTests()).toBe(1);

    __resetIMConfirmationRelayForTests();
    expect(__getIMConfirmationNumericReplyGuardSizeForTests()).toBe(0);
  });

  it('blocks re-arming the same inbound route during cooldown even if conversation, session, or channel changed', async () => {
    const pending = requestIMConfirmation(target(), { content: 'confirm?' }, { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe(false);

    await expect(requestIMConfirmation(
      target({ conversationId: 'conv-2' }),
      { content: 'new conversation?' },
    )).resolves.toBe(false);
    await expect(requestIMConfirmation(
      target({ sessionKey: 'slack:chat-1:thread-1:new-window', conversationId: 'conv-3' }),
      { content: 'new session?' },
    )).resolves.toBe(false);
    await expect(requestIMConfirmation(
      target({ channelId: 'ch-2', sessionKey: 'slack:chat-1:thread-1:ch-2', conversationId: 'conv-4' }),
      { content: 'new channel?' },
    )).resolves.toBe(false);
  });

  it('clears only the fresh nonnumeric inbound route and leaves other route tombstones active', async () => {
    const first = requestIMConfirmation(target(), { content: 'first?' }, { timeoutMs: 1_000 });
    const otherTarget = target({
      chatId: 'chat-2',
      threadId: 'thread-2',
      sessionKey: 'slack:chat-2:thread-2',
      conversationId: 'conv-2',
      replyContext: { platform: 'slack', chatId: 'chat-2', threadId: 'thread-2' },
    });
    const second = requestIMConfirmation(otherTarget, { content: 'second?' }, { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);

    expect(consumeIMConfirmationReply(message({ text: 'new work' }))).toBe(false);

    const rearmed = requestIMConfirmation(target(), { content: 'rearmed?' }, { allowRouteRearm: true });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(3));
    expect(consumeIMConfirmationReply(message({ text: '1' }))).toBe(true);
    await expect(rearmed).resolves.toBe(true);

    await expect(requestIMConfirmation(otherTarget, { content: 'other still blocked?' })).resolves.toBe(false);
    expect(consumeIMConfirmationReply(message({
      text: '1',
      chatId: 'chat-2',
      replyContext: { platform: 'slack', chatId: 'chat-2', threadId: 'thread-2' },
    }))).toBe(true);
  });

  it('does not consume a route tombstone for allowRouteRearm when the target has no stable messageId', async () => {
    const first = requestIMConfirmation(target(), { content: 'first?' }, { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBe(false);

    await expect(requestIMConfirmation(
      target({ replyContext: { messageId: undefined } }),
      { content: 'missing stable id?' },
      { allowRouteRearm: true },
    )).resolves.toBe(false);
  });

  it('allows the same route to arm again after the 180s cooldown expires', async () => {
    const pending = requestIMConfirmation(target(), { content: 'confirm?' }, { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe(false);

    await vi.advanceTimersByTimeAsync(180_001);
    const next = requestIMConfirmation(target(), { content: 'next?' });
    await vi.waitFor(() => expect(sendFinalMock).toHaveBeenCalledTimes(2));
    expect(consumeIMConfirmationReply(message({ text: '1' }))).toBe(true);
    await expect(next).resolves.toBe(true);
  });
});
