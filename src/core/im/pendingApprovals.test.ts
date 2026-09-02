// The IM approval primitive — "ask a human over chat" for unattended runs.
//
// Two hazards drive almost every case here:
//  1. FALSE POSITIVES in the reply matcher. WorkBuddy's IM approval matched
//     substrings and let an emoji ("🚭") approve an action nobody approved.
//     The negatives below (`同意书在哪`, `同意👍`, a long sentence containing
//     the word) are the point of the whole-message rule, not decoration.
//  2. IM SPAM from a chatty tool. `execute_js` can be called dozens of times
//     in one run; without coalescing every call would push a separate approval
//     message. One outstanding request per (conversation, run, origin, class),
//     answer cached for the rest of the run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedIMMessage } from './inboundRouter';
import type { UnattendedConfirmationRequest } from '../permissions/unattendedConfirmation';
import {
  __resetUnattendedConfirmationForTests,
  resolveUnattendedConfirmation,
} from '../permissions/unattendedConfirmation';
import { useIMChannelStore } from '../../stores/imChannelStore';
import type { IMSession } from '../../types/imChannel';
import { format, getI18n } from '../../i18n';
import zhCN from '../../i18n/locales/zh-CN';
import enUS from '../../i18n/locales/en-US';

/** Let the outbound send (a mocked promise chain) settle so the pending entry
 *  is registered. The primitive deliberately sends BEFORE it registers, so a
 *  single microtask is not enough. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const mocks = vi.hoisted(() => ({
  send: vi.fn(async () => ({ success: true as boolean, error: undefined as string | undefined })),
  publish: vi.fn(() => 'ntc_test'),
}));

vi.mock('./outputSender', () => ({
  outputSender: { send: (...a: unknown[]) => mocks.send(...(a as [])) },
}));

vi.mock('../notice/bus', () => ({
  publish: (...a: unknown[]) => mocks.publish(...(a as [])),
}));

import {
  APPROVAL_TIMEOUT_MS,
  MAX_PENDING_APPROVALS_PER_CONVERSATION,
  __resetPendingApprovalsForTests,
  classifyApprovalReply,
  imApprovalResolver,
  installImApprovalResolver,
  pendingApprovalCountForTests,
  requestImApproval,
  resolveImTargetForConversation,
  tryConsumeApprovalReply,
} from './pendingApprovals';

const CONV = 'conv-im-1';
const CHAT = 'chat-1';
const SENDER = 'user-1';

function session(overrides: Partial<IMSession> = {}): IMSession {
  return {
    key: 'feishu:chat-1:window',
    channelId: 'ch-1',
    conversationId: CONV,
    lastActiveAt: 1,
    messageCount: 1,
    userId: SENDER,
    userName: 'Someone',
    capability: 'full',
    platform: 'feishu',
    chatId: CHAT,
    ...overrides,
  };
}

function inbound(text: string, overrides: Partial<NormalizedIMMessage> = {}): NormalizedIMMessage {
  return {
    senderId: SENDER,
    senderName: 'Someone',
    text,
    isMention: false,
    isDirect: true,
    chatId: CHAT,
    platform: 'feishu',
    replyContext: { platform: 'feishu', chatId: CHAT },
    raw: {},
    ...overrides,
  };
}

/** A gate-shaped seam request: what `registry.ts` hands the resolver for an
 *  unattended browser action whose operation class resolved to 'ask'. */
function seamRequest(
  overrides: Partial<UnattendedConfirmationRequest> = {},
): UnattendedConfirmationRequest {
  return {
    info: {
      command: '浏览器操作: abu-browser__execute_js (https://example.com)',
      level: 'warn',
      reason: 'runs a script in the page',
      kind: 'browser',
      browserOperationClass: 'scripting',
      browserOrigin: 'https://example.com',
      allowPersistentGrant: false,
    },
    source: 'scheduler',
    conversationId: CONV,
    runKey: 'loop-1',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.send.mockReset().mockResolvedValue({ success: true, error: undefined });
  mocks.publish.mockReset().mockReturnValue('ntc_test');
  __resetPendingApprovalsForTests();
  __resetUnattendedConfirmationForTests();
  useIMChannelStore.setState({ sessions: {}, archivedSessions: {} });
});

afterEach(() => {
  __resetPendingApprovalsForTests();
  __resetUnattendedConfirmationForTests();
  vi.useRealTimers();
});

// ── 1. Reply classification ────────────────────────────────────────────────

describe('classifyApprovalReply', () => {
  it.each([
    '同意', '允许', '批准', 'yes', 'y', 'ok',
    'YES', 'Y', 'OK', 'Ok',       // case-insensitive
    '  同意  ',                    // trimmed
    'ｙｅｓ', 'ＯＫ',               // full-width normalized
    '同意。', '同意！', 'ok.',      // trailing terminal punctuation only
  ])('reads %j as an approval', (text) => {
    expect(classifyApprovalReply(text)).toBe('approve');
  });

  it.each([
    '拒绝', '不同意', '不行', 'no', 'n', 'NO', 'N', ' 拒绝 ', '拒绝！', 'ｎｏ',
  ])('reads %j as a denial', (text) => {
    expect(classifyApprovalReply(text)).toBe('deny');
  });

  it.each([
    // The WorkBuddy trap: a message that merely CONTAINS the word.
    '同意书在哪',
    '同意书',
    '我同意这个方案，你先去把报告拉下来',
    '不同意吗',
    '同意吗',
    // Emoji is not punctuation — an emoji-decorated word is not a bare answer.
    '同意👍',
    '👍',
    '🚭',
    'yes please',
    'okay',
    // Long text that happens to start with the word.
    '同意，但是先确认一下这个站点是不是我们自己的，另外顺便把上周的数据也导出来',
    // Empty / whitespace / unrelated.
    '', '   ', '好的', '嗯', 'maybe', 'noop', 'nope',
  ])('does not treat %j as an answer', (text) => {
    expect(classifyApprovalReply(text)).toBeNull();
  });

  it('never lets 不同意 read as 同意 (no substring matching)', () => {
    expect(classifyApprovalReply('不同意')).toBe('deny');
    expect(classifyApprovalReply('同意')).toBe('approve');
  });
});

// ── 1b. Prompt copy ────────────────────────────────────────────────────────

describe('approval prompt copy', () => {
  // The prompt is the ONLY place a user learns that a bare word is expected.
  // A translation that drops that instruction turns every approval into a
  // 10-minute timeout, so both locales are pinned.
  it.each([
    ['zh-CN', zhCN.imChannel.approvalPrompt, '同意', '拒绝'],
    ['en-US', enUS.imChannel.approvalPrompt, 'yes', 'no'],
  ])('%s names the action, both answers and the deadline', (_locale, template, ok, nope) => {
    expect(template).toContain('{action}');
    expect(template).toContain('{reason}');
    expect(template).toContain('{minutes}');
    expect(template).toContain(ok);
    expect(template).toContain(nope);
    // Whatever words the copy offers must actually be answers the matcher
    // accepts — copy and matcher drifting apart is a silent dead end.
    expect(classifyApprovalReply(ok)).toBe('approve');
    expect(classifyApprovalReply(nope)).toBe('deny');
  });
});

// ── 2. resolveImTargetForConversation ──────────────────────────────────────

describe('resolveImTargetForConversation', () => {
  it('finds the active IM session that owns the conversation', () => {
    useIMChannelStore.setState({ sessions: { 'k1': session() }, archivedSessions: {} });

    expect(resolveImTargetForConversation(CONV)).toEqual({
      platform: 'feishu',
      channelId: 'ch-1',
      chatId: CHAT,
      senderId: SENDER,
    });
  });

  it('falls back to an archived session (the chat still exists)', () => {
    useIMChannelStore.setState({
      sessions: {},
      archivedSessions: { 'k1': session({ chatId: 'chat-archived' }) },
    });

    expect(resolveImTargetForConversation(CONV)?.chatId).toBe('chat-archived');
  });

  it('returns null when no IM session is bound to the conversation', () => {
    useIMChannelStore.setState({ sessions: { 'k1': session({ conversationId: 'other' }) } });

    expect(resolveImTargetForConversation(CONV)).toBeNull();
  });

  it('returns null when the binding carries no chat to reply to', () => {
    useIMChannelStore.setState({ sessions: { 'k1': session({ chatId: '' }) } });

    expect(resolveImTargetForConversation(CONV)).toBeNull();
  });
});

// ── 3. requestImApproval ───────────────────────────────────────────────────

describe('requestImApproval', () => {
  const target = { platform: 'feishu', channelId: 'ch-1', chatId: CHAT, senderId: SENDER };

  it('pushes exactly one outbound message carrying the prompt', async () => {
    const promise = requestImApproval({
      conversationId: CONV, imTarget: target, prompt: 'PROMPT-TEXT',
    });
    await settle();

    expect(mocks.send).toHaveBeenCalledTimes(1);
    const [output, message] = mocks.send.mock.calls[0] as unknown as [
      { target: string; outputChannelId: string; outputChatId: string },
      { content: string },
    ];
    expect(output.target).toBe('im_channel');
    expect(output.outputChannelId).toBe('ch-1');
    expect(output.outputChatId).toBe(CHAT);
    expect(message.content).toContain('PROMPT-TEXT');

    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(true);
    await expect(promise).resolves.toBe('approved');
  });

  it('resolves denied on a 拒绝 reply', async () => {
    const promise = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'p' });
    await settle();

    expect(tryConsumeApprovalReply(inbound('拒绝'))).toBe(true);
    await expect(promise).resolves.toBe('denied');
  });

  it('times out to "timeout" and removes the pending entry', async () => {
    vi.useFakeTimers();
    const promise = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'p' });
    await vi.advanceTimersByTimeAsync(1);
    expect(pendingApprovalCountForTests()).toBe(1);

    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);

    await expect(promise).resolves.toBe('timeout');
    expect(pendingApprovalCountForTests()).toBe(0);
  });

  it('does not consume a LATE reply — it is an ordinary message, forward it', async () => {
    vi.useFakeTimers();
    const promise = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'p' });
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);
    await expect(promise).resolves.toBe('timeout');

    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(false);
  });

  it('leaves the approval pending when the message is not an answer', async () => {
    const promise = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'p' });
    await settle();

    expect(tryConsumeApprovalReply(inbound('同意书在哪'))).toBe(false);
    expect(pendingApprovalCountForTests()).toBe(1);

    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(true);
    await expect(promise).resolves.toBe('approved');
  });

  it('ignores an answer from a different chat', async () => {
    const promise = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'p' });
    await settle();

    expect(tryConsumeApprovalReply(inbound('同意', { chatId: 'other-chat' }))).toBe(false);
    expect(tryConsumeApprovalReply(inbound('同意', { platform: 'slack' }))).toBe(false);
    expect(pendingApprovalCountForTests()).toBe(1);

    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(true);
    await expect(promise).resolves.toBe('approved');
  });

  it('ignores a bystander in a group chat when the binding names the asker', async () => {
    const promise = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'p' });
    await settle();

    expect(tryConsumeApprovalReply(inbound('同意', { senderId: 'someone-else' }))).toBe(false);
    expect(pendingApprovalCountForTests()).toBe(1);

    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(true);
    await expect(promise).resolves.toBe('approved');
  });

  it('denies when the outbound push fails — an undelivered ask is not an ask', async () => {
    mocks.send.mockResolvedValue({ success: false, error: 'boom' });

    await expect(
      requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'p' }),
    ).resolves.toBe('denied');
    expect(pendingApprovalCountForTests()).toBe(0);
  });

  it('denies without sending when the target has no channel', async () => {
    await expect(
      requestImApproval({
        conversationId: CONV,
        imTarget: { platform: 'feishu', chatId: CHAT },
        prompt: 'p',
      }),
    ).resolves.toBe('denied');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('caps outstanding prompts per conversation and notifies instead', async () => {
    const started: Promise<string>[] = [];
    for (let i = 0; i < MAX_PENDING_APPROVALS_PER_CONVERSATION; i++) {
      started.push(requestImApproval({ conversationId: CONV, imTarget: target, prompt: `p${i}` }));
    }
    await settle();
    expect(pendingApprovalCountForTests()).toBe(MAX_PENDING_APPROVALS_PER_CONVERSATION);

    const overflow = await requestImApproval({
      conversationId: CONV, imTarget: target, prompt: 'one too many',
    });

    expect(overflow).toBe('denied');
    expect(mocks.send).toHaveBeenCalledTimes(MAX_PENDING_APPROVALS_PER_CONVERSATION);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(
      (mocks.publish.mock.calls[0] as unknown as [{ type: string }])[0].type,
    ).toBe('permission_request');

    // Drain so the test does not leave dangling timers.
    __resetPendingApprovalsForTests();
    await Promise.all(started);
  });

  it('answers the OLDEST outstanding prompt first', async () => {
    const first = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'first' });
    await settle();
    const second = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'second' });
    await settle();

    expect(tryConsumeApprovalReply(inbound('拒绝'))).toBe(true);
    await expect(first).resolves.toBe('denied');
    expect(pendingApprovalCountForTests()).toBe(1);

    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(true);
    await expect(second).resolves.toBe('approved');
  });
});

// ── 4. The resolver (the seam implementation) ──────────────────────────────

describe('imApprovalResolver', () => {
  beforeEach(() => {
    useIMChannelStore.setState({ sessions: { k1: session() }, archivedSessions: {} });
  });

  it('asks over IM and approves on 同意', async () => {
    const promise = imApprovalResolver(seamRequest());
    await settle();

    expect(mocks.send).toHaveBeenCalledTimes(1);
    const message = (mocks.send.mock.calls[0] as unknown as [unknown, { content: string }])[1];
    // The prompt is the locale's template filled with WHAT, WHY and the
    // deadline. (The template's own duties — how to answer, the timeout — are
    // pinned per-locale in the copy test below, which is where a translator
    // dropping the instruction would show up.)
    expect(message.content).toBe(
      format(getI18n().imChannel.approvalPrompt, {
        action: '浏览器操作: abu-browser__execute_js (https://example.com)',
        reason: 'runs a script in the page',
        minutes: '10',
      }),
    );
    expect(message.content).toContain('https://example.com');

    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(true);
    await expect(promise).resolves.toMatchObject({ approved: true });
  });

  it('denies on 拒绝 and says so in the user-facing reason', async () => {
    const promise = imApprovalResolver(seamRequest());
    await settle();
    tryConsumeApprovalReply(inbound('拒绝'));

    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.userFacingReason).toBeTruthy();
    expect(result.userFacingReason).not.toBe(result.userFacingReason?.toUpperCase?.() ?? '');
  });

  it('falls back to a system notice and fails closed with no IM binding', async () => {
    useIMChannelStore.setState({ sessions: {}, archivedSessions: {} });

    const result = await imApprovalResolver(seamRequest());

    expect(result.approved).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    const notice = (mocks.publish.mock.calls[0] as unknown as [
      { type: string; payload: Record<string, unknown> },
    ])[0];
    expect(notice.type).toBe('permission_request');
    // Same prompt the IM channel would have carried.
    expect(String(notice.payload.title)).toContain('https://example.com');
    expect(notice.payload.conversationId).toBe(CONV);
    expect(result.reason).toContain('no IM');
  });

  it('raises the no-binding notice once per run, not once per tool call', async () => {
    useIMChannelStore.setState({ sessions: {}, archivedSessions: {} });

    await imApprovalResolver(seamRequest());
    await imApprovalResolver(seamRequest());
    await imApprovalResolver(seamRequest());

    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it('fails closed without a conversation to look a binding up from', async () => {
    const result = await imApprovalResolver(seamRequest({ conversationId: undefined }));
    expect(result.approved).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('coalesces concurrent asks with the same key into ONE outbound message', async () => {
    const a = imApprovalResolver(seamRequest());
    const b = imApprovalResolver(seamRequest());
    const c = imApprovalResolver(seamRequest());
    await settle();

    expect(mocks.send).toHaveBeenCalledTimes(1);

    tryConsumeApprovalReply(inbound('同意'));
    const results = await Promise.all([a, b, c]);
    expect(results.map((r) => r.approved)).toEqual([true, true, true]);
  });

  it('does NOT coalesce a different origin or a different operation class', async () => {
    const a = imApprovalResolver(seamRequest());
    await settle();
    const b = imApprovalResolver(
      seamRequest({ info: { ...seamRequest().info, browserOrigin: 'https://other.com' } }),
    );
    await settle();

    expect(mocks.send).toHaveBeenCalledTimes(2);

    tryConsumeApprovalReply(inbound('同意'));
    tryConsumeApprovalReply(inbound('同意'));
    await Promise.all([a, b]);
  });

  it('caches the answer for the rest of the run — no second prompt', async () => {
    const first = imApprovalResolver(seamRequest());
    await settle();
    tryConsumeApprovalReply(inbound('同意'));
    await expect(first).resolves.toMatchObject({ approved: true });

    const second = await imApprovalResolver(seamRequest());
    const third = await imApprovalResolver(seamRequest());

    expect(second.approved).toBe(true);
    expect(third.approved).toBe(true);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('caches a denial too — a refused action is not re-asked all run', async () => {
    const first = imApprovalResolver(seamRequest());
    await settle();
    tryConsumeApprovalReply(inbound('拒绝'));
    await first;

    await expect(imApprovalResolver(seamRequest())).resolves.toMatchObject({ approved: false });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('does not carry an answer into a different run', async () => {
    const first = imApprovalResolver(seamRequest());
    await settle();
    tryConsumeApprovalReply(inbound('同意'));
    await first;

    const nextRun = imApprovalResolver(seamRequest({ runKey: 'loop-2' }));
    await settle();
    expect(mocks.send).toHaveBeenCalledTimes(2);

    tryConsumeApprovalReply(inbound('同意'));
    await nextRun;
  });

  it('never caches when the run cannot be identified', async () => {
    const first = imApprovalResolver(seamRequest({ runKey: undefined }));
    await settle();
    tryConsumeApprovalReply(inbound('同意'));
    await first;

    const second = imApprovalResolver(seamRequest({ runKey: undefined }));
    await settle();
    expect(mocks.send).toHaveBeenCalledTimes(2);

    tryConsumeApprovalReply(inbound('同意'));
    await second;
  });

  it('prefers the imTarget the caller supplied over the store lookup', async () => {
    const promise = imApprovalResolver(
      seamRequest({ imTarget: { platform: 'slack', channelId: 'ch-slack', chatId: 'C999' } }),
    );
    await settle();

    const output = (mocks.send.mock.calls[0] as unknown as [
      { outputChannelId: string; outputChatId: string },
    ])[0];
    expect(output.outputChannelId).toBe('ch-slack');
    expect(output.outputChatId).toBe('C999');

    tryConsumeApprovalReply(inbound('同意', { platform: 'slack', chatId: 'C999', senderId: 'x' }));
    await promise;
  });

  it('a timeout is cached as a refusal — an ignored prompt is not re-sent all run', async () => {
    vi.useFakeTimers();
    const first = imApprovalResolver(seamRequest());
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);
    await expect(first).resolves.toMatchObject({ approved: false });

    await expect(imApprovalResolver(seamRequest())).resolves.toMatchObject({ approved: false });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});

// ── 5. Wiring ──────────────────────────────────────────────────────────────

describe('installImApprovalResolver', () => {
  it('makes the seam route through the IM approval channel', async () => {
    useIMChannelStore.setState({ sessions: { k1: session() }, archivedSessions: {} });
    installImApprovalResolver();

    const promise = resolveUnattendedConfirmation(seamRequest());
    await settle();
    expect(mocks.send).toHaveBeenCalledTimes(1);

    tryConsumeApprovalReply(inbound('同意'));
    await expect(promise).resolves.toMatchObject({ approved: true });
  });

  it('leaves the seam fail-closed for a run with no binding', async () => {
    installImApprovalResolver();

    await expect(resolveUnattendedConfirmation(seamRequest())).resolves.toMatchObject({
      approved: false,
    });
  });
});
