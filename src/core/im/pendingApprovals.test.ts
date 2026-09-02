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
  createUnattendedConfirmation,
  resolveUnattendedConfirmation,
} from '../permissions/unattendedConfirmation';
import { clearLoopContext, setLoopContext } from '../agent/permissionBridge';
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

type SendCall = [{ outputChannelId?: string; outputChatId?: string; target?: string }, { content: string }];
function sendCalls(): SendCall[] {
  return mocks.send.mock.calls as unknown as SendCall[];
}
/** Prompts only. Outcome receipts go through the same sender, so a raw call
 *  count would silently conflate "asked twice" with "asked once, reported". */
function promptSends(): SendCall[] {
  return sendCalls().filter((c) => c[1].content.startsWith('⚠️'));
}
function receiptSends(): string[] {
  return sendCalls().filter((c) => !c[1].content.startsWith('⚠️')).map((c) => c[1].content);
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
  CONTENT_REPLAY_WINDOW_MS,
  MAX_PENDING_APPROVALS_PER_CONVERSATION,
  SEND_TIMEOUT_MS,
  __resetPendingApprovalsForTests,
  classifyApprovalReply,
  getImApprovalTimeoutMs,
  imApprovalResolver,
  installImApprovalResolver,
  pendingApprovalCountForTests,
  requestImApproval,
  requestImApprovalDetailed,
  resolveImTargetForConversation,
  sanitizeUntrustedPromptField,
  setImApprovalTimeoutMs,
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

/** An answer carrying the platform message id Feishu attaches in production.
 *  Two DISTINCT answers sent in the same instant must not read as one replayed
 *  message, and the id is what tells them apart. */
function answer(text: string, messageId: string): NormalizedIMMessage {
  return inbound(text, { replyContext: { platform: 'feishu', chatId: CHAT, messageId } });
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
    '同意', '允许', '批准', 'yes',
    'YES', 'Yes',                  // case-insensitive
    '  同意  ',                    // trimmed
    'ｙｅｓ',                       // full-width normalized
    '同意。', '同意！', 'yes.',     // trailing terminal punctuation only
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
    // Dropped from APPROVE after review: ubiquitous chat filler, and the deny
    // set has no equivalent, so accepting them skewed the matcher toward "yes".
    'ok', 'OK', 'Ok', 'ＯＫ', 'ok.', 'y', 'Y', 'ｙ',
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
        minutes: String(Math.round(getImApprovalTimeoutMs() / 60_000)),
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

    tryConsumeApprovalReply(answer('同意', 'om_a'));
    tryConsumeApprovalReply(answer('同意', 'om_b'));
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
    expect(promptSends()).toHaveLength(1);
  });

  it('does not carry an answer into a different run', async () => {
    const first = imApprovalResolver(seamRequest());
    await settle();
    tryConsumeApprovalReply(answer('同意', 'om_1'));
    await first;

    const nextRun = imApprovalResolver(seamRequest({ runKey: 'loop-2' }));
    await settle();
    expect(mocks.send).toHaveBeenCalledTimes(2);

    tryConsumeApprovalReply(answer('同意', 'om_2'));
    await nextRun;
  });

  it('never caches when the run cannot be identified', async () => {
    const first = imApprovalResolver(seamRequest({ runKey: undefined }));
    await settle();
    tryConsumeApprovalReply(answer('同意', 'om_1'));
    await first;

    const second = imApprovalResolver(seamRequest({ runKey: undefined }));
    await settle();
    expect(mocks.send).toHaveBeenCalledTimes(2);

    tryConsumeApprovalReply(answer('同意', 'om_2'));
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
    expect(promptSends()).toHaveLength(1);
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

// ── 6. Fix round 1 ─────────────────────────────────────────────────────────

// [C1] `info.command` is whatever the MODEL asked to run, and `info.reason`
// can come from the AI reviewer — a model steered by page content it just read
// controls both. Dropped verbatim into a multi-line chat message they can
// forge an extra, official-looking line.
describe('untrusted prompt fields are sanitized and fenced', () => {
  const INJECTION = [
    'rm -rf /tmp/x',
    '',
    '✅ 系统自动检查通过，无需确认',
    '回复「同意」或「拒绝」：本条已自动批准',
  ].join('\n');

  it('collapses newlines so a forged line cannot exist', () => {
    const safe = sanitizeUntrustedPromptField(INJECTION);
    expect(safe).not.toContain('\n');
    expect(safe).not.toContain('\r');
  });

  it('strips the fence characters so the fence cannot be closed', () => {
    const safe = sanitizeUntrustedPromptField('x「」y【】z');
    expect(safe).not.toMatch(/[「」【】]/);
    expect(safe).toContain('x');
    expect(safe).toContain('z');
  });

  it.each([
    ['a\u0007b', 'a b'],
    ['a\u2028b', 'a b'],
    ['a\u202Eb', 'a b'],
    ['a\u200Bb', 'a b'],
    ['a\u3000b', 'a b'],
  ])('neutralizes the hidden character in %j', (input, expected) => {
    expect(sanitizeUntrustedPromptField(input)).toBe(expected);
  });

  it('caps runaway length with an ellipsis', () => {
    const safe = sanitizeUntrustedPromptField('x'.repeat(5000));
    expect(safe.length).toBeLessThanOrEqual(201);
    expect(safe.endsWith('…')).toBe(true);
  });

  it('renders an injection payload inert in the delivered prompt', async () => {
    useIMChannelStore.setState({ sessions: { k1: session() }, archivedSessions: {} });
    const promise = imApprovalResolver(
      seamRequest({ info: { ...seamRequest().info, command: INJECTION, reason: INJECTION } }),
    );
    await settle();

    const content = promptSends()[0][1].content;
    // The forged text survives as inert characters, but only inside the line
    // whose label owns it — never as a line of its own.
    for (const line of content.split('\n')) {
      if (line.includes('系统自动检查通过')) {
        expect(
          line.startsWith('操作：') || line.startsWith('说明：') ||
          line.startsWith('Action:') || line.startsWith('Details:'),
        ).toBe(true);
      }
    }
    // Four non-empty lines: header, action, details, instruction — and the
    // instruction is last, so nothing inside the fence can impersonate it.
    const lines = content.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain(String(Math.round(getImApprovalTimeoutMs() / 60_000)));

    tryConsumeApprovalReply(inbound('拒绝'));
    await promise;
  });
});

// [C2] Every IM platform redelivers. channelRouter dedups by messageId, but it
// runs AFTER this hook, so without our own dedup a replayed 同意 would consume
// a SECOND, different pending approval.
describe('replayed platform messages', () => {
  const target = { platform: 'feishu', channelId: 'ch-1', chatId: CHAT, senderId: SENDER };

  it('cannot consume a second approval', async () => {
    const first = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'first' });
    await settle();
    const second = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'second' });
    await settle();

    const replayed = inbound('同意', {
      replyContext: { platform: 'feishu', chatId: CHAT, messageId: 'om_1' },
    });
    expect(tryConsumeApprovalReply(replayed)).toBe(true);
    await expect(first).resolves.toBe('approved');

    // The retry is swallowed (it is not new user input either) and the second
    // approval is untouched.
    expect(tryConsumeApprovalReply(replayed)).toBe(true);
    expect(pendingApprovalCountForTests()).toBe(1);

    expect(tryConsumeApprovalReply(
      inbound('同意', { replyContext: { platform: 'feishu', chatId: CHAT, messageId: 'om_2' } }),
    )).toBe(true);
    await expect(second).resolves.toBe('approved');
  });

  // [C2 gap] DingTalk / WeCom / Slack set no `replyContext.messageId`, so the
  // id dedup never fires there. Fallback: the same answer from the same person
  // in the same chat inside a SHORT window is a redelivery; outside it, it is a
  // person answering a second prompt with the same word.
  it('still lets a genuinely repeated answer through when the platform gives no id', async () => {
    vi.useFakeTimers();
    const first = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'first' });
    await settle();
    const second = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'second' });
    await settle();

    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(true);
    await expect(first).resolves.toBe('approved');
    await vi.advanceTimersByTimeAsync(CONTENT_REPLAY_WINDOW_MS + 1);
    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(true);
    await expect(second).resolves.toBe('approved');
  });

  it('treats the same id-less answer repeated inside the window as a replay', async () => {
    vi.useFakeTimers();
    const first = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'first' });
    await settle();
    const second = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'second' });
    await settle();

    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(true);
    await expect(first).resolves.toBe('approved');

    // Swallowed (not forwarded to the model either) and the second prompt is
    // untouched by it.
    await vi.advanceTimersByTimeAsync(CONTENT_REPLAY_WINDOW_MS - 1);
    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(true);
    expect(pendingApprovalCountForTests()).toBe(1);

    // A DIFFERENT answer is not a replay of the first one.
    expect(tryConsumeApprovalReply(inbound('拒绝'))).toBe(true);
    await expect(second).resolves.toBe('denied');
  });

  it('scopes the id-less replay window to the sender and chat', async () => {
    const groupTarget = { platform: 'feishu', channelId: 'ch-1', chatId: CHAT };
    const first = requestImApproval({
      conversationId: CONV, imTarget: groupTarget, prompt: 'first', senderId: 'alice',
    });
    await settle();
    const second = requestImApproval({
      conversationId: CONV, imTarget: groupTarget, prompt: 'second', senderId: 'bob',
    });
    await settle();

    expect(tryConsumeApprovalReply(inbound('同意', { senderId: 'alice', isDirect: false }))).toBe(true);
    await expect(first).resolves.toBe('approved');
    // Bob's identical word, seconds later, is Bob's own answer — not Alice's echo.
    expect(tryConsumeApprovalReply(inbound('同意', { senderId: 'bob', isDirect: false }))).toBe(true);
    await expect(second).resolves.toBe('approved');
  });
});

// [N1] Slots are reserved in call order but armed in DELIVERY order. The
// answer must bind to the prompt the user actually saw first, which is the
// one whose send completed first — not the one whose call came first.
describe('answers bind in delivery order, not reservation order', () => {
  const target = { platform: 'feishu', channelId: 'ch-1', chatId: CHAT, senderId: SENDER };

  it('resolves the prompt that was delivered first when sends complete out of order', async () => {
    const releases: Array<(v: { success: boolean; error: undefined }) => void> = [];
    mocks.send.mockImplementation(() => new Promise((r) => { releases.push(r as never); }));
    const first = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'first' });
    const second = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'second' });
    await settle();
    expect(releases).toHaveLength(2);
    expect(pendingApprovalCountForTests()).toBe(2);

    // The SECOND ask lands on screen first, then the first; both are armed
    // by the time the user answers — and they answer what they saw first.
    releases[1]({ success: true, error: undefined });
    await settle();
    releases[0]({ success: true, error: undefined });
    await settle();
    expect(pendingApprovalCountForTests()).toBe(2);

    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(true);
    await expect(second).resolves.toBe('approved');
    expect(pendingApprovalCountForTests()).toBe(1);

    expect(tryConsumeApprovalReply(inbound('拒绝'))).toBe(true);
    await expect(first).resolves.toBe('denied');
  });
});

// [N2] A send that never settles used to hold a cap slot forever: the abort
// listener was attached only after the awaited send, and the outbound path had
// no bound of its own.
describe('a hung send cannot hold a slot', () => {
  const target = { platform: 'feishu', channelId: 'ch-1', chatId: CHAT, senderId: SENDER };

  it('releases the slot and reports aborted when Stop arrives mid-send', async () => {
    let release!: (v: { success: boolean; error: undefined }) => void;
    mocks.send.mockReturnValue(new Promise((r) => { release = r as never; }));
    const controller = new AbortController();
    const promise = requestImApprovalDetailed({
      conversationId: CONV, imTarget: target, prompt: 'a', abortSignal: controller.signal,
    });
    await settle();
    expect(pendingApprovalCountForTests()).toBe(1);

    controller.abort();
    await expect(promise).resolves.toEqual({ outcome: 'denied', cause: 'aborted' });
    expect(pendingApprovalCountForTests()).toBe(0);

    // The send completing afterwards must not resurrect the prompt.
    release({ success: true, error: undefined });
    await settle();
    expect(pendingApprovalCountForTests()).toBe(0);
    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(false);
  });

  it('gives up on a send that never settles, and the slot is usable again', async () => {
    vi.useFakeTimers();
    mocks.send.mockReturnValue(new Promise(() => {}));
    const hung = requestImApprovalDetailed({ conversationId: CONV, imTarget: target, prompt: 'a' });
    await vi.advanceTimersByTimeAsync(1);
    expect(pendingApprovalCountForTests()).toBe(1);

    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    await expect(hung).resolves.toEqual({ outcome: 'denied', cause: 'undeliverable' });
    expect(pendingApprovalCountForTests()).toBe(0);

    // Not a permanent too_many: the next ask sends, arms and is answerable.
    mocks.send.mockResolvedValue({ success: true, error: undefined });
    const next = requestImApprovalDetailed({ conversationId: CONV, imTarget: target, prompt: 'b' });
    await vi.advanceTimersByTimeAsync(1);
    expect(pendingApprovalCountForTests()).toBe(1);
    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(true);
    await expect(next).resolves.toEqual({ outcome: 'approved', cause: 'answered' });
  });

  it('a send that settles late, after the deadline, changes nothing', async () => {
    vi.useFakeTimers();
    let release!: (v: { success: boolean; error: undefined }) => void;
    mocks.send.mockReturnValue(new Promise((r) => { release = r as never; }));
    const hung = requestImApprovalDetailed({ conversationId: CONV, imTarget: target, prompt: 'a' });
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 1);
    await expect(hung).resolves.toMatchObject({ cause: 'undeliverable' });

    release({ success: true, error: undefined });
    await vi.advanceTimersByTimeAsync(1);
    expect(pendingApprovalCountForTests()).toBe(0);
    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(false);
  });
});

// [I3 residual] The registry's run_command / self-extension paths call the
// callback as `(info, loopId)`; the wrapper must turn that loop id into the
// run's abort signal and its run key, or the live IM path gets neither.
describe('command confirmations over the live IM path', () => {
  const LOOP = 'loop-cmd';
  const commandInfo = { command: 'rm -rf ./build', level: 'warn' as const, reason: 'deletes files' };

  function installLoop(signal: AbortSignal): void {
    setLoopContext(LOOP, {
      loopId: LOOP,
      conversationId: CONV,
      signal,
      commandConfirmCallback: async () => true,
      filePermissionCallback: async () => true,
      eventRouter: {} as never,
      toolCallToStepId: new Map(),
    });
  }

  beforeEach(() => {
    useIMChannelStore.setState({ sessions: { k1: session() }, archivedSessions: {} });
    installImApprovalResolver();
  });

  afterEach(() => {
    clearLoopContext(LOOP);
  });

  it('Stop cancels a run_command prompt, and a later 同意 reaches the model', async () => {
    const controller = new AbortController();
    installLoop(controller.signal);
    const callback = createUnattendedConfirmation({ source: 'im', conversationId: CONV });

    const promise = callback(commandInfo, LOOP);
    await settle();
    expect(promptSends()).toHaveLength(1);
    expect(pendingApprovalCountForTests()).toBe(1);

    controller.abort();
    await expect(promise).resolves.toBe(false);
    expect(pendingApprovalCountForTests()).toBe(0);
    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(false);
  });

  it('coalesces repeated command asks within one run — the run key rides the loop id', async () => {
    installLoop(new AbortController().signal);
    const callback = createUnattendedConfirmation({ source: 'im', conversationId: CONV });

    const a = callback(commandInfo, LOOP);
    const b = callback(commandInfo, LOOP);
    await settle();
    expect(promptSends()).toHaveLength(1);

    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(true);
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
    // And the answer is remembered for the rest of the run.
    await expect(callback(commandInfo, LOOP)).resolves.toBe(true);
    expect(promptSends()).toHaveLength(1);
  });
});

// [I1] The cap counted outstanding entries BEFORE an awaited send, so parallel
// asks all read 0 and every one of them sent.
describe('cap slots are reserved synchronously', () => {
  const target = { platform: 'feishu', channelId: 'ch-1', chatId: CHAT, senderId: SENDER };

  it('holds the cap under fully parallel asks', async () => {
    const started = [
      requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'a' }),
      requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'b' }),
      requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'c' }),
      requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'd' }),
    ];

    await expect(started[3]).resolves.toBe('denied');
    await settle();
    // Raw send count: these prompts are bare test strings, and calling the
    // primitive directly never produces a receipt.
    expect(mocks.send).toHaveBeenCalledTimes(MAX_PENDING_APPROVALS_PER_CONVERSATION);
    expect(pendingApprovalCountForTests()).toBe(MAX_PENDING_APPROVALS_PER_CONVERSATION);
    expect(mocks.publish).toHaveBeenCalledTimes(1);

    __resetPendingApprovalsForTests();
    await Promise.all(started);
  });

  it('releases the slot when delivery fails', async () => {
    mocks.send.mockResolvedValue({ success: false, error: 'boom' });
    await requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'a' });
    expect(pendingApprovalCountForTests()).toBe(0);

    mocks.send.mockResolvedValue({ success: true, error: undefined });
    const ok = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'b' });
    await settle();
    expect(pendingApprovalCountForTests()).toBe(1);
    tryConsumeApprovalReply(inbound('同意'));
    await expect(ok).resolves.toBe('approved');
  });

  it('a reserved-but-undelivered slot cannot be answered', async () => {
    let release!: (v: { success: boolean; error: undefined }) => void;
    mocks.send.mockReturnValue(new Promise((r) => { release = r as never; }));
    const promise = requestImApproval({ conversationId: CONV, imTarget: target, prompt: 'a' });
    await settle();

    // Reserved (it occupies a cap slot) but not armed: nothing is on screen.
    expect(pendingApprovalCountForTests()).toBe(1);
    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(false);

    release({ success: true, error: undefined });
    await settle();
    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(true);
    await expect(promise).resolves.toBe('approved');
  });
});

// [I3] An approval can wait minutes. Stop must not leave it live.
describe('abort integration', () => {
  beforeEach(() => {
    useIMChannelStore.setState({ sessions: { k1: session() }, archivedSessions: {} });
  });

  it('drops the pending entry and denies when the run is stopped', async () => {
    const controller = new AbortController();
    const promise = imApprovalResolver(seamRequest({ abortSignal: controller.signal }));
    await settle();
    expect(pendingApprovalCountForTests()).toBe(1);

    controller.abort();
    await expect(promise).resolves.toMatchObject({ approved: false });
    expect(pendingApprovalCountForTests()).toBe(0);

    // A later answer is an ordinary message now — it must reach the model.
    expect(tryConsumeApprovalReply(inbound('同意'))).toBe(false);
    // And no receipt spam for a run the user stopped themselves.
    expect(receiptSends()).toEqual([]);
  });

  it('never sends when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      imApprovalResolver(seamRequest({ abortSignal: controller.signal })),
    ).resolves.toMatchObject({ approved: false });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not remember an abort as an answer for the run', async () => {
    const controller = new AbortController();
    const first = imApprovalResolver(seamRequest({ abortSignal: controller.signal }));
    await settle();
    controller.abort();
    await first;

    const second = imApprovalResolver(seamRequest());
    await settle();
    expect(promptSends()).toHaveLength(2);
    tryConsumeApprovalReply(inbound('同意'));
    await expect(second).resolves.toMatchObject({ approved: true });
  });
});

// [I4] Without a run key there is no boundary to coalesce inside: two
// overlapping runs would share one prompt, so one run's "yes" would authorize
// the other run's action.
describe('no run key means no sharing', () => {
  it('does not merge concurrent asks from unidentifiable runs', async () => {
    useIMChannelStore.setState({ sessions: { k1: session() }, archivedSessions: {} });
    const a = imApprovalResolver(seamRequest({ runKey: undefined }));
    const b = imApprovalResolver(seamRequest({ runKey: undefined }));
    await settle();

    expect(promptSends()).toHaveLength(2);
    tryConsumeApprovalReply(inbound('同意'));
    tryConsumeApprovalReply(inbound('拒绝'));
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.approved, rb.approved].sort()).toEqual([false, true]);
  });
});

// [I5] The trigger engine's tiers build their callbacks without a
// conversation, so this branch is a real production path — and it used to deny
// in total silence.
describe('runs with no conversation', () => {
  it('still raises a system notice before failing closed', async () => {
    const result = await imApprovalResolver(seamRequest({ conversationId: undefined }));

    expect(result.approved).toBe(false);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    const notice = (mocks.publish.mock.calls[0] as unknown as [
      { type: string; payload: Record<string, unknown> },
    ])[0];
    expect(notice.type).toBe('permission_request');
    expect(String(notice.payload.title)).toContain('https://example.com');
    // No conversation to jump to — the click handler must not get a dead id.
    expect(notice.payload.conversationId).toBeUndefined();
  });
});

// [Ruling U3-①]
describe('approval deadline', () => {
  it('defaults to five minutes, strictly under the IM run timeout', () => {
    expect(APPROVAL_TIMEOUT_MS).toBe(5 * 60 * 1000);
    // channelRouter.AGENT_TIMEOUT_MS — a longer approval would expire at the
    // same moment the run it belongs to was killed.
    expect(APPROVAL_TIMEOUT_MS).toBeLessThan(10 * 60 * 1000);
    expect(getImApprovalTimeoutMs()).toBe(APPROVAL_TIMEOUT_MS);
  });

  it('is configurable, and a nonsense value falls back to the default', () => {
    setImApprovalTimeoutMs(60_000);
    expect(getImApprovalTimeoutMs()).toBe(60_000);
    setImApprovalTimeoutMs(0);
    expect(getImApprovalTimeoutMs()).toBe(APPROVAL_TIMEOUT_MS);
  });
});

// [Ruling U3-④] Silence after a 拒绝 or a timeout reads as "Abu ignored me".
describe('outcome receipts', () => {
  beforeEach(() => {
    useIMChannelStore.setState({ sessions: { k1: session() }, archivedSessions: {} });
  });

  it('reports a denial back to the same chat', async () => {
    const promise = imApprovalResolver(seamRequest());
    await settle();
    tryConsumeApprovalReply(inbound('拒绝'));
    await promise;

    expect(receiptSends()).toHaveLength(1);
    const call = sendCalls().find((c) => !c[1].content.startsWith('⚠️'))!;
    expect(call[0].outputChatId).toBe(CHAT);
  });

  it('reports a timeout', async () => {
    vi.useFakeTimers();
    const promise = imApprovalResolver(seamRequest());
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(getImApprovalTimeoutMs());
    await promise;

    expect(receiptSends()).toHaveLength(1);
  });

  it('says nothing after an approval — the action speaks for itself', async () => {
    const promise = imApprovalResolver(seamRequest());
    await settle();
    tryConsumeApprovalReply(inbound('同意'));
    await promise;

    expect(receiptSends()).toEqual([]);
  });

  it('does not narrate every refused call — receipts are deduped', async () => {
    const first = imApprovalResolver(seamRequest());
    await settle();
    tryConsumeApprovalReply(answer('拒绝', 'om_1'));
    await first;

    const second = imApprovalResolver(seamRequest({ runKey: 'loop-2' }));
    await settle();
    tryConsumeApprovalReply(answer('拒绝', 'om_2'));
    await second;

    expect(promptSends()).toHaveLength(2);
    expect(receiptSends()).toHaveLength(1);
  });
});

// [M5] "Anyone in the group may approve" is not a default anybody chose.
describe('group chats with no bound owner', () => {
  it('refuses every reply rather than letting anyone approve', async () => {
    const promise = requestImApproval({
      conversationId: CONV,
      // No senderId anywhere: the binding names nobody.
      imTarget: { platform: 'feishu', channelId: 'ch-1', chatId: CHAT },
      prompt: 'p',
    });
    await settle();

    expect(tryConsumeApprovalReply(inbound('同意', { isDirect: false, senderId: 'anyone' })))
      .toBe(false);
    expect(tryConsumeApprovalReply(inbound('同意', { isDirect: false, senderId: SENDER })))
      .toBe(false);
    expect(pendingApprovalCountForTests()).toBe(1);

    // The same unowned prompt in a 1:1 chat is unambiguous and answerable.
    expect(tryConsumeApprovalReply(inbound('同意', { isDirect: true }))).toBe(true);
    await expect(promise).resolves.toBe('approved');
  });

  it('treats a blank owner id as unknown, not as a user with an empty id', async () => {
    const promise = requestImApproval({
      conversationId: CONV,
      imTarget: { platform: 'feishu', channelId: 'ch-1', chatId: CHAT, senderId: '' },
      prompt: 'p',
    });
    await settle();

    expect(tryConsumeApprovalReply(inbound('同意', { isDirect: false, senderId: '' }))).toBe(false);
    expect(tryConsumeApprovalReply(inbound('同意', { isDirect: true, senderId: '' }))).toBe(true);
    await expect(promise).resolves.toBe('approved');
  });
});
