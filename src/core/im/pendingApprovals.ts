/**
 * Pending IM approvals — the "ask a human over chat" primitive.
 *
 * An unattended run (scheduler / trigger / IM channel) whose operation policy
 * says **ask** has, until now, had nowhere to ask: `unattendedConfirmation.ts`
 * shipped with a fail-closed default resolver, so "每次都问" meant "always
 * refuse". This module is the missing exit — it pushes the request into the
 * IM chat the conversation is bound to and waits for a plain-text answer.
 *
 * Three properties are load-bearing, and each exists because of a specific way
 * this can go wrong:
 *
 * 1. **The reply matcher is whole-message only.** WorkBuddy's IM approval
 *    matched substrings, so an emoji or a sentence that merely contained the
 *    word approved actions nobody approved. Here a reply counts only when the
 *    ENTIRE message, after trimming and full-width normalization, is one of a
 *    small closed set. `同意书在哪` and `同意👍` are not answers; they fall
 *    through to the model as ordinary messages and the approval stays pending.
 *
 * 2. **Requests coalesce per (conversation, run, origin, operation class).**
 *    `execute_js` can be called dozens of times in one turn. Without this, an
 *    approved run would push a separate approval message per call — the fastest
 *    way to make a user turn the whole feature off. Concurrent asks share one
 *    Promise, and the answer is cached for the rest of that run.
 *
 * 3. **Every failure is a denial.** No IM binding, undelivered message, too
 *    many prompts outstanding, nobody answered in time — all resolve to "no".
 *    An approval channel that cannot deliver must never read as approval.
 *
 * The inbound hook (`tryConsumeApprovalReply`) runs in `inboundDispatcher`
 * BEFORE trigger matching and channel routing, so an answer is consumed rather
 * than handed to the model as a new instruction.
 */

import { format, getI18n } from '../../i18n';
import { publish } from '../notice/bus';
import { useIMChannelStore } from '../../stores/imChannelStore';
import { outputSender } from './outputSender';
import {
  setUnattendedConfirmationResolver,
  type UnattendedConfirmationRequest,
  type UnattendedConfirmationResolver,
  type UnattendedConfirmationResult,
  type UnattendedImTarget,
} from '../permissions/unattendedConfirmation';
import type { NormalizedIMMessage } from './inboundRouter';
import { createLogger } from '../logging/logger';

const log = createLogger('im-approval');

/** How long a prompt waits for an answer before failing closed. Ten minutes:
 *  long enough for someone to notice a phone notification, short enough that a
 *  scheduled run does not hold a browser tab hostage all night. */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Most approval prompts one conversation may have outstanding at once.
 *
 * The cap is a spam bound AND an ambiguity bound: a bare `同意` answers the
 * OLDEST outstanding prompt (the one the user saw first), so the fewer that
 * can be in flight, the smaller the chance an answer lands on the wrong ask.
 */
export const MAX_PENDING_APPROVALS_PER_CONVERSATION = 3;

/** Bound on remembered per-run answers. A run key is unique per run, so
 *  entries are never reused — this only stops unbounded growth in a
 *  long-running app. Oldest-first eviction. */
const MAX_CACHED_ANSWERS = 200;

export type ImApprovalOutcome = 'approved' | 'denied' | 'timeout';

/**
 * Why an approval ended the way it did. A 'denied' outcome has four very
 * different stories behind it — the user said no, nobody could be asked, too
 * many asks were already waiting, or the message never arrived — and a run
 * result that says "denied" without saying which is a support ticket.
 */
export type ImApprovalCause =
  | 'answered'
  | 'timeout'
  | 'no_binding'
  | 'too_many'
  | 'undeliverable';

export interface ImApprovalResult {
  outcome: ImApprovalOutcome;
  cause: ImApprovalCause;
}

// ── Reply classification ───────────────────────────────────────────────────

/**
 * The complete set of messages that mean "yes". Closed on purpose: every
 * addition is a new way for an ordinary sentence to be mistaken for consent.
 */
const APPROVE_REPLIES: ReadonlySet<string> = new Set([
  '同意', '允许', '批准', 'yes', 'y', 'ok',
]);

/** The complete set that means "no". Checked first, so a value that somehow
 *  appears in both sets can only ever refuse. */
const DENY_REPLIES: ReadonlySet<string> = new Set([
  '拒绝', '不同意', '不行', 'no', 'n',
]);

/**
 * Trailing sentence-final punctuation stripped before matching. Deliberately
 * NOT a general "strip non-word characters": emoji stay, so `同意👍` is not a
 * bare answer (that is exactly the WorkBuddy false positive). `同意。` is.
 */
const TRAILING_PUNCTUATION = /[.。!！~～]+$/;

/** Full-width ASCII (Ｙ, Ｅ, Ｓ, ...) → ASCII, and ideographic space → space,
 *  so a Chinese IME's `ｙｅｓ` is the same answer as `yes`. */
function normalizeReply(text: string): string {
  return text
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .trim()
    .replace(TRAILING_PUNCTUATION, '')
    .trim()
    .toLowerCase();
}

/**
 * Whether a message IS an answer to a pending approval — not whether it
 * contains one. Returns null for everything else, which the dispatcher treats
 * as an ordinary message.
 */
export function classifyApprovalReply(text: string): 'approve' | 'deny' | null {
  const normalized = normalizeReply(text);
  if (normalized.length === 0) return null;
  if (DENY_REPLIES.has(normalized)) return 'deny';
  if (APPROVE_REPLIES.has(normalized)) return 'approve';
  return null;
}

// ── The pending registry ───────────────────────────────────────────────────

interface PendingApproval {
  conversationId: string;
  platform: string;
  chatId: string;
  /** When the binding names the person who owns this conversation, only they
   *  may answer — a bystander in a group chat must not be able to approve
   *  browser automation running in someone else's logged-in sessions. */
  senderId?: string;
  timer: ReturnType<typeof setTimeout>;
  settle: (outcome: ImApprovalOutcome) => void;
}

/** Insertion-ordered: index 0 is the oldest outstanding prompt. */
const pending: PendingApproval[] = [];

export function pendingApprovalCountForTests(): number {
  return pending.length;
}

/**
 * Drop every outstanding prompt and remembered answer. Test-only: production
 * entries are removed by an answer or by their own timer.
 */
export function __resetPendingApprovalsForTests(): void {
  for (const entry of pending.splice(0)) {
    clearTimeout(entry.timer);
    entry.settle('denied');
  }
  inFlight.clear();
  answered.clear();
}

/**
 * Inbound hook — call this BEFORE routing a message to triggers or the model.
 *
 * Returns true when the message was an answer to a pending approval and has
 * been consumed (the caller must NOT forward it: "同意" as a prompt to the
 * model is meaningless at best and an instruction at worst). Returns false for
 * everything else, including a LATE answer to a prompt that already timed out
 * — that is an ordinary message and belongs to the conversation.
 */
export function tryConsumeApprovalReply(message: NormalizedIMMessage): boolean {
  if (pending.length === 0) return false;
  const index = pending.findIndex(
    (entry) =>
      entry.platform === message.platform &&
      entry.chatId === message.chatId &&
      (entry.senderId === undefined || entry.senderId === message.senderId),
  );
  if (index === -1) return false;

  const verdict = classifyApprovalReply(message.text);
  if (verdict === null) return false;

  const [entry] = pending.splice(index, 1);
  clearTimeout(entry.timer);
  entry.settle(verdict === 'approve' ? 'approved' : 'denied');
  return true;
}

// ── Conversation → IM chat binding ─────────────────────────────────────────

/** An IM target complete enough to actually deliver a message to. */
export interface DeliverableImTarget extends UnattendedImTarget {
  channelId: string;
  chatId: string;
  senderId?: string;
}

/**
 * Find the IM chat a conversation is bound to.
 *
 * The binding is `IMSession` in `imChannelStore` — created by `sessionMapper`
 * when an IM message opens a conversation, and persisted, so it survives a
 * restart. Archived sessions count as a fallback: the session window closed,
 * but the chat still exists and the user still reads it.
 *
 * Returns null when nothing binds the conversation to a chat (a scheduled task
 * created from the desktop UI, say) — the caller must then fail closed.
 */
export function resolveImTargetForConversation(
  conversationId: string,
): DeliverableImTarget | null {
  const store = useIMChannelStore.getState();
  const match =
    Object.values(store.sessions ?? {}).find((s) => s.conversationId === conversationId) ??
    Object.values(store.archivedSessions ?? {}).find((s) => s.conversationId === conversationId);
  if (!match || !match.chatId || !match.channelId) return null;
  return {
    platform: match.platform,
    channelId: match.channelId,
    chatId: match.chatId,
    ...(match.userId ? { senderId: match.userId } : {}),
  };
}

// ── Outbound + notice ──────────────────────────────────────────────────────

/**
 * Raise the approval request as a system notification instead of an IM
 * message. Used when the run has nothing to ask through: the user still learns
 * that something wanted permission, rather than only seeing a run that
 * achieved nothing. Fail-closed either way — this notice is not answerable.
 */
function publishApprovalNotice(conversationId: string, prompt: string): void {
  try {
    publish({
      type: 'permission_request',
      source: 'agent',
      payload: { title: prompt, conversationId },
      // Time-based: the same action asked again an hour later is news again,
      // but a chatty run must not raise one notice per tool call.
      dedupKey: `im_approval_unreachable:${conversationId}:${prompt}`,
    });
  } catch (error) {
    log.warn('failed to publish approval notice', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Ask a human over IM and wait for a plain-text answer.
 *
 * Sends FIRST and registers the pending entry only once delivery succeeded: a
 * reply cannot arrive before the message does, and registering first would
 * leave a window where an unrelated `同意` resolves a prompt nobody ever saw.
 */
export interface RequestImApprovalOptions {
  conversationId: string;
  imTarget: UnattendedImTarget;
  prompt: string;
  /** Only this user's replies count. Defaults to "anyone in that chat". */
  senderId?: string;
  timeoutMs?: number;
}

export async function requestImApprovalDetailed(
  options: RequestImApprovalOptions,
): Promise<ImApprovalResult> {
  const { conversationId, imTarget, prompt } = options;
  const timeoutMs = options.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  const senderId = options.senderId ?? imTarget.senderId;
  const { channelId, chatId } = imTarget;
  if (!channelId || !chatId) return { outcome: 'denied', cause: 'no_binding' };

  const outstanding = pending.filter((e) => e.conversationId === conversationId).length;
  if (outstanding >= MAX_PENDING_APPROVALS_PER_CONVERSATION) {
    publishApprovalNotice(conversationId, prompt);
    return { outcome: 'denied', cause: 'too_many' };
  }

  const sent = await outputSender
    .send(
      {
        enabled: true,
        target: 'im_channel',
        outputChannelId: channelId,
        outputChatId: chatId,
        extractMode: 'last_message',
      },
      { content: prompt },
    )
    .catch((error: unknown) => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  if (!sent.success) {
    log.warn(`approval prompt undelivered (${chatId}): ${sent.error ?? 'unknown error'}`);
    return { outcome: 'denied', cause: 'undeliverable' };
  }

  const outcome = await new Promise<ImApprovalOutcome>((resolve) => {
    const entry: PendingApproval = {
      conversationId,
      platform: imTarget.platform,
      chatId,
      ...(senderId !== undefined ? { senderId } : {}),
      timer: setTimeout(() => {
        const index = pending.indexOf(entry);
        if (index !== -1) pending.splice(index, 1);
        resolve('timeout');
      }, timeoutMs),
      settle: resolve,
    };
    pending.push(entry);
  });
  return { outcome, cause: outcome === 'timeout' ? 'timeout' : 'answered' };
}

/** The primitive in its contract shape — the outcome only. */
export async function requestImApproval(
  options: RequestImApprovalOptions,
): Promise<ImApprovalOutcome> {
  return (await requestImApprovalDetailed(options)).outcome;
}

// ── The seam resolver ──────────────────────────────────────────────────────

/** In-flight requests, so concurrent asks with the same key share one prompt. */
const inFlight = new Map<string, Promise<ImApprovalResult>>();
/** Answers remembered for the rest of the run that produced them. */
const answered = new Map<string, UnattendedConfirmationResult>();

/**
 * The coalescing identity: one outstanding request per conversation, run,
 * target origin and operation class.
 *
 * Origin and class are part of the key on purpose — "yes, click on
 * example.com" is not consent to run a script on bank.com, and collapsing them
 * would turn one approval into a blanket one.
 */
function coalesceKey(request: UnattendedConfirmationRequest, conversationId: string): string {
  const origin = request.info.browserOrigin ?? 'origin-unknown';
  const opClass = request.info.browserOperationClass ?? 'scripting';
  const kind = request.info.kind ?? 'command';
  return [conversationId, request.runKey ?? '', kind, opClass, origin, request.info.command].join(
    ' ',
  );
}

function rememberAnswer(key: string, answer: UnattendedConfirmationResult): void {
  answered.set(key, answer);
  while (answered.size > MAX_CACHED_ANSWERS) {
    const oldest = answered.keys().next();
    if (oldest.done) break;
    answered.delete(oldest.value);
  }
}

/** The IM-facing prompt: what, where, how to answer, and the deadline. */
function buildPrompt(request: UnattendedConfirmationRequest, timeoutMs: number): string {
  const t = getI18n();
  return format(t.imChannel.approvalPrompt, {
    action: request.info.command,
    reason: request.info.reason,
    minutes: String(Math.round(timeoutMs / 60_000)),
  });
}

function refuse(reason: string, userFacingReason?: string): UnattendedConfirmationResult {
  return {
    approved: false,
    reason,
    ...(userFacingReason !== undefined ? { userFacingReason } : {}),
  };
}

async function askOverIm(
  request: UnattendedConfirmationRequest,
  conversationId: string,
  prompt: string,
): Promise<ImApprovalResult> {
  // A caller that already knows where it is answering (the IM channel router
  // builds its callbacks with the live reply target) beats the store lookup,
  // which can only find the session mapper's record.
  const supplied = request.imTarget;
  const target: DeliverableImTarget | null =
    supplied?.channelId && supplied.chatId
      ? {
          platform: supplied.platform,
          channelId: supplied.channelId,
          chatId: supplied.chatId,
          ...(supplied.senderId !== undefined ? { senderId: supplied.senderId } : {}),
        }
      : resolveImTargetForConversation(conversationId);

  if (!target) {
    publishApprovalNotice(conversationId, prompt);
    return { outcome: 'denied', cause: 'no_binding' };
  }

  return await requestImApprovalDetailed({ conversationId, imTarget: target, prompt });
}

/** Turn the primitive's outcome into what the seam's callers need to say. */
function describeOutcome(result: ImApprovalResult): UnattendedConfirmationResult {
  const t = getI18n();
  const minutes = String(Math.round(APPROVAL_TIMEOUT_MS / 60_000));
  switch (result.cause) {
    case 'answered':
      return result.outcome === 'approved'
        ? { approved: true, reason: 'approved over IM' }
        : refuse('denied over IM by the user', t.commandConfirm.browserUnattendedImDenied);
    case 'timeout':
      return refuse(
        'the IM approval request expired with no answer',
        format(t.commandConfirm.browserUnattendedImTimeout, { minutes }),
      );
    case 'no_binding':
      return refuse(
        'the conversation is bound to no IM chat, so nobody could be asked',
        t.commandConfirm.browserUnattendedImNoBinding,
      );
    case 'too_many':
      return refuse(
        'too many IM approval requests are already outstanding for this conversation',
        format(t.commandConfirm.browserUnattendedImTooMany, {
          max: String(MAX_PENDING_APPROVALS_PER_CONVERSATION),
        }),
      );
    case 'undeliverable':
      return refuse(
        'the IM approval request could not be delivered',
        t.commandConfirm.browserUnattendedImUndeliverable,
      );
  }
}

/**
 * The real unattended-confirmation resolver: an IM round-trip.
 *
 * Installed at app init via `installImApprovalResolver`. Exported directly so
 * tests can drive it without touching the global seam.
 */
export const imApprovalResolver: UnattendedConfirmationResolver = async (request) => {
  const t = getI18n();
  const conversationId = request.conversationId;
  if (conversationId === undefined) {
    // No conversation means no binding to look up and nothing to notify about.
    return refuse(
      'no conversation on the unattended confirmation request, so no IM chat to ask in',
      t.commandConfirm.browserUnattendedImNoBinding,
    );
  }

  const key = coalesceKey(request, conversationId);

  // An answer already given for this exact ask in this run. A timeout is
  // remembered as a refusal too: someone who ignored the prompt for ten
  // minutes must not be prompted again on the next tool call.
  const cached = request.runKey !== undefined ? answered.get(key) : undefined;
  if (cached !== undefined) return cached;

  const prompt = buildPrompt(request, APPROVAL_TIMEOUT_MS);

  // Concurrent asks with the same key wait on the one prompt already out.
  let outcomePromise = inFlight.get(key);
  const owned = outcomePromise === undefined;
  if (outcomePromise === undefined) {
    outcomePromise = askOverIm(request, conversationId, prompt);
    inFlight.set(key, outcomePromise);
  }

  let outcome: ImApprovalResult;
  try {
    outcome = await outcomePromise;
  } finally {
    // Only the owner clears: a follower must not drop a newer entry.
    if (owned && inFlight.get(key) === outcomePromise) inFlight.delete(key);
  }

  const result = describeOutcome(outcome);

  // Remembering requires a run boundary. Without a run key the answer would
  // have no scope to expire in, and a stale "yes" is the one failure this
  // whole layer exists to prevent.
  if (request.runKey !== undefined) rememberAnswer(key, result);

  return result;
};

/**
 * Install the IM approval channel as the app's unattended confirmation
 * resolver. Called once at startup, alongside the other core singletons.
 *
 * Until this runs, `resolveUnattendedConfirmation` keeps its fail-closed
 * default — which is the correct behavior for a build (or a test) that has no
 * IM channel at all.
 */
export function installImApprovalResolver(): void {
  setUnattendedConfirmationResolver(imApprovalResolver);
}
