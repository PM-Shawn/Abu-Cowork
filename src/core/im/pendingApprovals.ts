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
  type UnattendedApprovalOutcome,
  type UnattendedConfirmationResult,
  type UnattendedImTarget,
} from '../permissions/unattendedConfirmation';
import type { NormalizedIMMessage } from './inboundRouter';
import type { IMPlatform } from '../../types/im';
import { createLogger } from '../logging/logger';

const log = createLogger('im-approval');

/**
 * How long a prompt waits for an answer before failing closed.
 *
 * FIVE minutes, not ten: `channelRouter.AGENT_TIMEOUT_MS` aborts an
 * IM-originated run after ten, so a ten-minute approval would routinely expire
 * at the same moment the run it belongs to was killed — the user's answer
 * would land on nothing. This has to stay strictly below that bound.
 */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

let approvalTimeoutMs: number = APPROVAL_TIMEOUT_MS;

/** The deadline the resolver applies. Configurable (no UI exposes it yet) so
 *  the bound can be tuned without a settings-store migration; callers of
 *  `requestImApproval` can also override it per request. */
export function getImApprovalTimeoutMs(): number {
  return approvalTimeoutMs;
}

export function setImApprovalTimeoutMs(ms: number): void {
  approvalTimeoutMs = ms > 0 ? ms : APPROVAL_TIMEOUT_MS;
}

/**
 * Most approval prompts that may be outstanding at once — counted BOTH per
 * conversation and per destination chat, with the tighter one binding (R4).
 *
 * The cap is a spam bound AND an ambiguity bound: a bare `同意` answers the
 * OLDEST outstanding prompt (the one the user saw first), so the fewer that
 * can be in flight, the smaller the chance an answer lands on the wrong ask.
 *
 * Both scopes are needed because an automation defeats the conversation one by
 * construction: every scheduled run gets a brand-new conversation, so N runs
 * of one task could pile 3N prompts into a single chat while no conversation
 * ever exceeded three.
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
  | 'undeliverable'
  | 'aborted';

export interface ImApprovalResult {
  outcome: ImApprovalOutcome;
  cause: ImApprovalCause;
}

// ── Reply classification ───────────────────────────────────────────────────

/**
 * The complete set of messages that mean "yes". Closed on purpose: every
 * addition is a new way for an ordinary sentence to be mistaken for consent.
 *
 * `ok` and `y` were removed after review: both are ubiquitous chat filler —
 * "ok" acknowledges anything, "y" is a typo away from nothing — and the deny
 * set has no comparable filler, so keeping them made the matcher asymmetric in
 * the dangerous direction. A user who types `ok` gets an ordinary message and,
 * at worst, a timeout; that is the side to err on.
 */
const APPROVE_REPLIES: ReadonlySet<string> = new Set([
  '同意', '允许', '批准', 'yes',
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
  /**
   * The channel this prompt was sent THROUGH.
   *
   * Only the DM branch reads it, and it has to: that branch matches on owner +
   * privacy rather than chat identity, so without the channel a prompt armed
   * via one channel is answerable from a different channel on the same
   * platform (two Feishu apps in one workspace — an entirely ordinary setup,
   * and one of them may be a bot the approver does not control). The chat
   * branch is already pinned by `chatId`, which is channel-specific in
   * practice, but the field is set for every entry so the rule cannot silently
   * become "sometimes checked".
   */
  channelId?: string;
  chatId: string;
  /** When the binding names the person who owns this conversation, only they
   *  may answer — a bystander in a group chat must not be able to approve
   *  browser automation running in someone else's logged-in sessions. */
  senderId?: string;
  /**
   * False while the slot is RESERVED but the prompt has not been delivered
   * yet. A reservation occupies a cap slot (so parallel asks cannot all read
   * "0 outstanding" and blow past the cap) but must not be answerable — there
   * is no message on screen for anyone to be answering.
   */
  armed: boolean;
  /** How `chatId` addressed its recipient — decides which matching rule the
   *  inbound hook applies to this entry. See `tryConsumeApprovalReply`. */
  chatIdType?: 'chat_id' | 'open_id';
  timer?: ReturnType<typeof setTimeout>;
  detachAbort?: () => void;
  settle?: (outcome: ImApprovalOutcome) => void;
}

/**
 * Ordered by ARMING, not by reservation: an entry is pushed when its slot is
 * reserved and moved to the end when its prompt is delivered, so among the
 * armed entries index order is the order the user saw them. A bare `同意`
 * answers the first armed entry, and "first" must mean "delivered first" —
 * two parallel asks whose sends complete out of order would otherwise resolve
 * the ask the user has not seen yet.
 */
const pending: PendingApproval[] = [];

/**
 * Platform message ids already consumed as an approval answer, with the time
 * they were consumed.
 *
 * Every IM platform redelivers: a Feishu webhook retries when Abu is slow to
 * ack, and a reconnect replays up to five minutes of history. Without this, a
 * replayed `同意` would be a second consumption and would answer the NEXT
 * pending prompt — a different ask, silently approved by a message the user
 * sent once. `channelRouter` does the same dedup, but it runs AFTER this hook.
 */
const consumedMessageIds = new Map<string, number>();
const CONSUMED_MESSAGE_TTL_MS = 30 * 60 * 1000;
const MAX_CONSUMED_MESSAGE_IDS = 500;

/**
 * Fallback for platforms whose adapters supply no message id (DingTalk, WeCom,
 * Slack): the same answer, from the same person, in the same chat, within
 * this window is a redelivery. Outside it, it is a person answering a second
 * prompt with the same word — which is why the window is short. A redelivery
 * arrives within seconds; a human answering two prompts takes longer.
 */
export const CONTENT_REPLAY_WINDOW_MS = 10 * 1000;
const consumedContents = new Map<string, number>();

function remember(map: Map<string, number>, key: string, now: number, ttlMs: number): void {
  map.set(key, now);
  for (const [id, at] of map) {
    if (now - at >= ttlMs) map.delete(id);
  }
  while (map.size > MAX_CONSUMED_MESSAGE_IDS) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function seenWithin(map: Map<string, number>, key: string, now: number, ttlMs: number): boolean {
  const at = map.get(key);
  return at !== undefined && now - at < ttlMs;
}

function releasePending(entry: PendingApproval): void {
  const index = pending.indexOf(entry);
  if (index !== -1) pending.splice(index, 1);
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  entry.detachAbort?.();
}

export function pendingApprovalCountForTests(): number {
  return pending.length;
}

/**
 * Drop every outstanding prompt and remembered answer. Test-only: production
 * entries are removed by an answer, an abort, or their own timer.
 */
export function __resetPendingApprovalsForTests(): void {
  for (const entry of pending.splice(0)) {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.detachAbort?.();
    entry.settle?.('denied');
  }
  inFlight.clear();
  answered.clear();
  consumedMessageIds.clear();
  consumedContents.clear();
  sentReceipts.clear();
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
/**
 * R3 — can a DM reply be attributed to this entry's channel at all?
 *
 * The DM branch trades chat identity for owner + privacy, which also drops the
 * only thing that tied an entry to the channel it was sent through. Inbound
 * messages carry no channel id (see the matcher's note), so provenance is only
 * unambiguous while the entry's platform has exactly ONE enabled channel.
 *
 * Re-checked at ANSWER time, not just at send time: a second channel enabled
 * while a prompt is outstanding makes that outstanding prompt ambiguous too,
 * and the safe reading of an ambiguous answer is "not an answer".
 */
function dmReplyProvenanceIsUnambiguous(entry: PendingApproval): boolean {
  if (entry.channelId === undefined) return false;
  const enabled = useIMChannelStore
    .getState()
    .getChannelsByPlatform(entry.platform as IMPlatform)
    .filter((c) => c.enabled);
  return enabled.length === 1 && enabled[0]?.id === entry.channelId;
}

export function tryConsumeApprovalReply(message: NormalizedIMMessage): boolean {
  const messageId = message.replyContext.messageId;
  const idKey = messageId ? `${message.platform}:${messageId}` : null;
  const now = Date.now();

  // A redelivery of a message we already consumed. Swallow it rather than
  // returning false: it is not new user input either, and forwarding it would
  // hand the model a bare "同意".
  if (idKey && seenWithin(consumedMessageIds, idKey, now, CONSUMED_MESSAGE_TTL_MS)) return true;

  const verdict = classifyApprovalReply(message.text);
  // Without a platform id, the content itself is the only replay signal. The
  // key carries the normalized reply verbatim rather than a digest: it is a
  // member of a closed set of a handful of short words (only answers are ever
  // remembered), so there is nothing a hash would bound or hide, and the hook
  // is synchronous — the renderer has no synchronous digest to call.
  const contentKey =
    idKey === null && verdict !== null
      ? `${message.platform}:${message.chatId}:${message.senderId}:${normalizeReply(message.text)}`
      : null;
  if (contentKey && seenWithin(consumedContents, contentKey, now, CONTENT_REPLAY_WINDOW_MS)) {
    return true;
  }

  if (pending.length === 0) return false;
  const index = pending.findIndex(
    (entry) =>
      entry.armed &&
      entry.platform === message.platform &&
      (entry.chatIdType === 'open_id'
        /*
          Addressed to a PERSON, not a conversation. The adapter opened (or
          reused) a 1:1 chat to deliver it, and the answer comes back carrying
          THAT chat's id — never the user id we addressed — so chat identity
          cannot be the check here.

          What replaces it is strictly tighter than the chat rule, not looser:
          the owner is known exactly (we chose whom to message), the reply must
          come from that exact person, it must be private, AND it must arrive
          through the same channel the prompt went out on. That last clause is
          R3 from the security review: dropping chat identity also dropped the
          only thing tying the entry to its channel, so one workspace running
          two apps on the same platform could answer either app's prompt from
          the other.

          🔴 Abu cannot TELL those two apart today: an inbound message arrives
          as `{ platform, payload }` and carries no channel identity at all
          (`inboundDispatcher.dispatch`), which is also why the router picks a
          channel by platform rather than by provenance. So the check that can
          be enforced is the one below — a DM prompt is answerable only while
          its channel is the ONLY enabled one on its platform, i.e. only while
          "a feishu DM from this person" can mean exactly one thing. With two
          enabled channels the prompt becomes unanswerable rather than
          cross-answerable: fail-closed, in the direction that matters.
        */
        ? entry.senderId !== undefined
          && entry.senderId === message.senderId
          && message.isDirect === true
          && dmReplyProvenanceIsUnambiguous(entry)
        : entry.chatId === message.chatId
          // No bound owner means we do not know whose approval this is. In a
          // 1:1 chat there is only one candidate, so the reply is unambiguous;
          // in a group it is not, and "anyone in the group may approve" is not
          // a default anybody chose. Such a prompt simply expires.
          && (entry.senderId !== undefined
            ? entry.senderId === message.senderId
            : message.isDirect === true)),
  );
  if (index === -1) return false;
  if (verdict === null) return false;

  const [entry] = pending.splice(index, 1);
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  entry.detachAbort?.();
  if (idKey) remember(consumedMessageIds, idKey, now, CONSUMED_MESSAGE_TTL_MS);
  else if (contentKey) remember(consumedContents, contentKey, now, CONTENT_REPLAY_WINDOW_MS);
  entry.settle?.(verdict === 'approve' ? 'approved' : 'denied');
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
function publishApprovalNotice(conversationId: string | null, prompt: string): void {
  try {
    publish({
      type: 'permission_request',
      source: 'agent',
      payload: {
        title: prompt,
        // Omitted when the run carries no conversation (trigger tiers): the
        // notification's click handler jumps to a conversation, and a null one
        // would be a dead click.
        ...(conversationId !== null ? { conversationId } : {}),
      },
      // The same action asked again later is news again, but a chatty run must
      // not raise one notice per tool call.
      dedupKey: `im_approval_unreachable:${conversationId ?? 'no-conversation'}:${prompt}`,
    });
  } catch (error) {
    log.warn('failed to publish approval notice', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Push one line into an IM chat. Returns delivery success.
 *
 * `chatIdType` is forwarded to `outputSender` because a DM is addressed by a
 * USER id, and the adapter has to be told that — `sendViaIMChannel` otherwise
 * defaults a bare `outputChatId` to `'chat_id'` and the send fails or lands
 * nowhere. Same argument `pushToIMChannel` already passes for results.
 */
async function sendToChat(
  channelId: string,
  chatId: string,
  content: string,
  chatIdType?: 'chat_id' | 'open_id',
): Promise<{ success: boolean; error?: string }> {
  return await outputSender
    .send(
      {
        enabled: true,
        target: 'im_channel',
        outputChannelId: channelId,
        outputChatId: chatId,
        extractMode: 'last_message',
      },
      { content },
      undefined,
      chatIdType ?? 'chat_id',
    )
    .catch((error: unknown) => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
}

/** Receipts already sent, keyed by chat + cause, so a run that trips the same
 *  outcome repeatedly does not narrate every tool call back into the chat. */
const sentReceipts = new Map<string, number>();
const RECEIPT_DEDUP_MS = 60 * 1000;

/**
 * Tell the chat what happened to the prompt it was asked to answer.
 *
 * Only for outcomes the user would otherwise never see: a denial they typed
 * (so they know it landed), a timeout (so the silence is explained), and the
 * over-cap refusal (so they know to answer the ones already up). An APPROVAL
 * needs no receipt — the action's own result follows it. An abort needs none
 * either: the user stopped the run themselves.
 */
async function sendOutcomeReceipt(
  target: DeliverableImTarget,
  cause: ImApprovalCause,
  timeoutMs: number,
): Promise<void> {
  if (cause !== 'answered' && cause !== 'timeout' && cause !== 'too_many') return;
  const key = `${target.platform}:${target.chatId}:${cause}`;
  const now = Date.now();
  const lastAt = sentReceipts.get(key);
  if (lastAt !== undefined && now - lastAt < RECEIPT_DEDUP_MS) return;
  sentReceipts.set(key, now);
  for (const [k, at] of sentReceipts) {
    if (now - at >= RECEIPT_DEDUP_MS * 10) sentReceipts.delete(k);
  }

  const t = getI18n();
  const text =
    cause === 'answered'
      ? t.imChannel.approvalReceiptDenied
      : cause === 'timeout'
        ? format(t.imChannel.approvalReceiptTimeout, {
            minutes: String(Math.round(timeoutMs / 60_000)),
          })
        : format(t.imChannel.approvalReceiptTooMany, {
            max: String(MAX_PENDING_APPROVALS_PER_CONVERSATION),
          });
  const sent = await sendToChat(target.channelId, target.chatId, text, target.chatIdType);
  if (!sent.success) log.warn(`approval receipt undelivered: ${sent.error ?? 'unknown error'}`);
}

/**
 * Longest an outbound prompt may take to be delivered before the ask is
 * abandoned as undeliverable. The adapters have no bound of their own, and an
 * unbounded send would hold a cap slot forever — three hung sends and every
 * later ask in that conversation is refused as `too_many` until restart.
 */
export const SEND_TIMEOUT_MS = 30 * 1000;

/**
 * Ask a human over IM and wait for a plain-text answer.
 *
 * Slot handling is two-phase on purpose. The cap slot is RESERVED
 * synchronously, before the awaited send, because a `Promise.allSettled` of
 * parallel asks would otherwise all read "0 outstanding" and every one of them
 * would send. But the reservation is not `armed`, so nothing can answer it
 * until the message is actually on screen — which preserves the reason the
 * original code sent first: an unrelated `同意` must never resolve a prompt
 * nobody ever saw.
 *
 * Every way out — an answer, the deadline, an abort, a failed or hung send —
 * goes through one `finish`, so the slot is released exactly once and a send
 * that settles after the ask has already ended cannot resurrect it. The abort
 * listener is attached BEFORE the send: Stop during delivery must release the
 * slot too, not wait on an adapter that may never come back.
 */
export interface RequestImApprovalOptions {
  conversationId: string;
  imTarget: UnattendedImTarget;
  prompt: string;
  /** Only this user's replies count. Defaults to "the 1:1 chat's only user". */
  senderId?: string;
  timeoutMs?: number;
  /** The run's cancellation signal — Stop must not leave a prompt hanging. */
  abortSignal?: AbortSignal;
}

export async function requestImApprovalDetailed(
  options: RequestImApprovalOptions,
): Promise<ImApprovalResult> {
  const { conversationId, imTarget, prompt } = options;
  const timeoutMs = options.timeoutMs ?? getImApprovalTimeoutMs();
  // A blank owner id is "unknown owner", not "user with an empty id".
  const senderId = (options.senderId ?? imTarget.senderId) || undefined;
  const { channelId, chatId } = imTarget;
  if (!channelId || !chatId) return { outcome: 'denied', cause: 'no_binding' };
  if (options.abortSignal?.aborted) return { outcome: 'denied', cause: 'aborted' };

  /*
    R4 — the cap is per CONVERSATION and per DESTINATION, and the tighter of
    the two wins.

    Per-conversation alone was a spam bound that automations walked straight
    through: a scheduled run mints a fresh conversation every time, so three
    runs of one nightly task put nine prompts into one chat, each with its own
    "answer within 5 minutes" deadline. The destination is what a human
    actually experiences, so it has to carry a bound of its own.

    It is also the ambiguity bound the per-conversation cap was reaching for:
    a bare 同意 answers the OLDEST armed prompt in that chat, and the fewer
    that can be waiting there, the smaller the chance an answer lands on the
    wrong one — which is a property of the CHAT, not of the conversation.

    Keyed by platform + chatId, which for a DM entry is the owner's id, so one
    person's inbox is bounded whether they are addressed as a chat or by name.
  */
  const outstandingInConversation =
    pending.filter((e) => e.conversationId === conversationId).length;
  const outstandingAtDestination = pending.filter(
    (e) => e.platform === imTarget.platform && e.chatId === chatId,
  ).length;
  if (
    Math.max(outstandingInConversation, outstandingAtDestination)
    >= MAX_PENDING_APPROVALS_PER_CONVERSATION
  ) {
    publishApprovalNotice(conversationId, prompt);
    return { outcome: 'denied', cause: 'too_many' };
  }

  const entry: PendingApproval = {
    conversationId,
    platform: imTarget.platform,
    channelId,
    chatId,
    ...(imTarget.chatIdType !== undefined ? { chatIdType: imTarget.chatIdType } : {}),
    ...(senderId !== undefined ? { senderId } : {}),
    armed: false,
  };
  pending.push(entry);

  return await new Promise<ImApprovalResult>((resolve) => {
    let done = false;
    // Fires asynchronously, so `finish` below is initialized by the time it runs.
    const sendTimer = setTimeout(() => {
      log.warn(`approval prompt send timed out (${chatId}) after ${SEND_TIMEOUT_MS}ms`);
      finish({ outcome: 'denied', cause: 'undeliverable' });
    }, SEND_TIMEOUT_MS);
    const finish = (result: ImApprovalResult) => {
      if (done) return;
      done = true;
      clearTimeout(sendTimer);
      releasePending(entry);
      resolve(result);
    };
    // The inbound hook settles an answered entry through here.
    entry.settle = (outcome) =>
      finish({ outcome, cause: outcome === 'timeout' ? 'timeout' : 'answered' });

    const signal = options.abortSignal;
    if (signal) {
      const onAbort = () => finish({ outcome: 'denied', cause: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
      entry.detachAbort = () => signal.removeEventListener('abort', onAbort);
    }

    void sendToChat(channelId, chatId, prompt, imTarget.chatIdType).then((sent) => {
      clearTimeout(sendTimer);
      // Aborted or timed out while the message was in flight: the ask is
      // already over, whatever the adapter now says.
      if (done) return;
      if (!sent.success) {
        log.warn(`approval prompt undelivered (${chatId}): ${sent.error ?? 'unknown error'}`);
        finish({ outcome: 'denied', cause: 'undeliverable' });
        return;
      }
      // Delivered: arm, and move to the END so armed entries stay in the
      // order the user saw them (see `pending`).
      const at = pending.indexOf(entry);
      if (at !== -1) {
        pending.splice(at, 1);
        pending.push(entry);
      }
      entry.armed = true;
      entry.timer = setTimeout(() => entry.settle?.('timeout'), timeoutMs);
    });
  });
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
 *
 * The separator is written below as an ESCAPE, never as a literal U+0000
 * byte: a raw NUL made `file`(1) classify this source as binary "data", made
 * `grep` skip it by default, and was invisible in a diff — so a formatter could
 * strip it and silently make two different requests share one cache key. Same
 * lesson as `browserSignals.ts`'s `KEY_SEP`.
 */
function coalesceKey(request: UnattendedConfirmationRequest, conversationId: string): string {
  const origin = request.info.browserOrigin ?? 'origin-unknown';
  const opClass = request.info.browserOperationClass ?? 'scripting';
  const kind = request.info.kind ?? 'command';
  return [conversationId, request.runKey ?? '', kind, opClass, origin, request.info.command].join(
    '\u0000',
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

/** Longest untrusted fragment allowed into the prompt. A 5 KB shell command
 *  would push the instruction line off a phone screen, which is its own attack. */
const UNTRUSTED_FIELD_MAX = 200;

/**
 * Characters a fenced fragment must never contain: the fence itself (so the
 * content cannot close it and write outside), C0/C1 control codes, and the
 * Unicode line/paragraph separators and bidi overrides that render as line
 * breaks or reverse text.
 */
const UNSAFE_PROMPT_CHARS =
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\u3000\u300C\u300D\u3010\u3011]/g;

/**
 * Make a model-authored string safe to show a human in a chat message.
 *
 * `ConfirmationInfo.command` and `.reason` are NOT trusted text: `command` is
 * whatever the model asked to run (and the model can be steered by page
 * content it just read), and `reason` can come from the AI reviewer. Dropped
 * verbatim into a multi-line prompt, either could forge a second, official
 * looking line — "系统自动检查通过，无需确认" — or a whole fake prompt below
 * the real one. Collapsing every whitespace run to a single space keeps an
 * untrusted fragment on ONE line inside its fence, so the template's framing
 * (and the instruction line that follows it) cannot be impersonated.
 */
export function sanitizeUntrustedPromptField(
  text: string,
  maxLength = UNTRUSTED_FIELD_MAX,
): string {
  const flattened = text
    .replace(UNSAFE_PROMPT_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened.length <= maxLength) return flattened;
  return `${flattened.slice(0, maxLength).trimEnd()}…`;
}

/**
 * The IM-facing prompt: what, why, how to answer, and the deadline.
 *
 * Both untrusted fields are sanitized and fenced; the locale template puts the
 * "reply 同意/拒绝 + deadline" instruction AFTER the fenced region, so nothing
 * inside the fence can appear to be part of the instruction.
 */
function buildPrompt(request: UnattendedConfirmationRequest, timeoutMs: number): string {
  const t = getI18n();
  /*
    WHICH automation is asking, and WHERE it is acting.

    A prompt that arrives in a chat at 03:00 saying only "Abu wants to click a
    button" cannot be answered responsibly: the reader has several automations
    and no way to tell them apart, so the safe reply is always 拒绝 — which
    turns the whole channel into noise. The task name and the target origin are
    what make the ask decidable.

    Both go through `sanitizeUntrustedPromptField` like the other two: a task
    can be created by the model, and an origin comes from a page. And both sit
    INSIDE the fenced region — `approvalPrompt` keeps the reply instruction and
    the deadline after it, so nothing here can forge them.
  */
  const context: string[] = [];
  if (request.runLabel !== undefined && request.runLabel.trim() !== '') {
    context.push(
      format(t.imChannel.approvalPromptTask, {
        task: sanitizeUntrustedPromptField(request.runLabel),
      }),
    );
  }
  if (request.info.browserOrigin !== undefined && request.info.browserOrigin !== '') {
    context.push(
      format(t.imChannel.approvalPromptOrigin, {
        origin: sanitizeUntrustedPromptField(request.info.browserOrigin),
      }),
    );
  }
  return format(t.imChannel.approvalPrompt, {
    context: context.length > 0 ? `${context.join('\n')}\n` : '',
    action: sanitizeUntrustedPromptField(request.info.command),
    reason: sanitizeUntrustedPromptField(request.info.reason),
    minutes: String(Math.round(timeoutMs / 60_000)),
  });
}

function refuse(
  reason: string,
  userFacingReason?: string,
  outcome?: UnattendedApprovalOutcome,
): UnattendedConfirmationResult {
  return {
    approved: false,
    reason,
    ...(userFacingReason !== undefined ? { userFacingReason } : {}),
    // `audit` is required (B5): a refusal with no outcome code still has to
    // say so explicitly rather than by omission.
    audit: outcome !== undefined ? { outcome } : {},
  };
}

/**
 * U7 / G2 — the channel's own cause vocabulary, mapped onto the seam's audit
 * code. A straight renaming, kept exhaustive so a new cause cannot be added
 * without deciding what the report should say about it.
 */
function auditOutcomeFor(result: ImApprovalResult): UnattendedApprovalOutcome {
  switch (result.cause) {
    case 'answered': return result.outcome === 'approved' ? 'approved' : 'declined';
    case 'timeout': return 'timeout';
    case 'no_binding': return 'no-channel';
    case 'too_many': return 'too-many';
    case 'undeliverable': return 'undeliverable';
    case 'aborted': return 'aborted';
  }
}

async function askOverIm(
  request: UnattendedConfirmationRequest,
  conversationId: string,
  prompt: string,
): Promise<ImApprovalResult> {
  /*
    A caller that already knows where it is answering beats the store lookup,
    which can only find the session mapper's record.

    Two kinds of caller supply one now: the IM channel router (the live reply
    target of the message that started the run) and — since approvals were
    wired to automations — the scheduler and the trigger engine, which build
    it from the automation's own IM output binding
    (`core/im/approvalTarget.ts`). Without that second kind, an automatic
    run's conversation is bound to no session and every「每次询问」refused
    itself with `no_binding`.
  */
  const supplied = request.imTarget;
  const target: DeliverableImTarget | null =
    supplied?.channelId && supplied.chatId
      ? {
          platform: supplied.platform,
          channelId: supplied.channelId,
          chatId: supplied.chatId,
          ...(supplied.chatIdType !== undefined ? { chatIdType: supplied.chatIdType } : {}),
          ...(supplied.senderId !== undefined ? { senderId: supplied.senderId } : {}),
        }
      : resolveImTargetForConversation(conversationId);

  if (!target) {
    publishApprovalNotice(conversationId, prompt);
    return { outcome: 'denied', cause: 'no_binding' };
  }

  const timeoutMs = getImApprovalTimeoutMs();
  const result = await requestImApprovalDetailed({
    conversationId,
    imTarget: target,
    prompt,
    timeoutMs,
    ...(request.abortSignal !== undefined ? { abortSignal: request.abortSignal } : {}),
  });
  if (result.outcome !== 'approved') {
    // Best-effort: a receipt that fails to send must not change the decision.
    await sendOutcomeReceipt(target, result.cause, timeoutMs).catch(() => {});
  }
  return result;
}

/** Turn the primitive's outcome into what the seam's callers need to say. */
function describeOutcome(result: ImApprovalResult): UnattendedConfirmationResult {
  const t = getI18n();
  const minutes = String(Math.round(getImApprovalTimeoutMs() / 60_000));
  const auditOutcome = auditOutcomeFor(result);
  switch (result.cause) {
    case 'answered':
      return result.outcome === 'approved'
        ? { approved: true, reason: 'approved over IM', audit: { outcome: auditOutcome } }
        : refuse('denied over IM by the user', t.commandConfirm.browserUnattendedImDenied, auditOutcome);
    case 'timeout':
      return refuse(
        'the IM approval request expired with no answer',
        format(t.commandConfirm.browserUnattendedImTimeout, { minutes }),
        auditOutcome,
      );
    case 'no_binding':
      return refuse(
        'the conversation is bound to no IM chat, so nobody could be asked',
        t.commandConfirm.browserUnattendedImNoBinding,
        auditOutcome,
      );
    case 'too_many':
      return refuse(
        'too many IM approval requests are already outstanding for this conversation',
        format(t.commandConfirm.browserUnattendedImTooMany, {
          max: String(MAX_PENDING_APPROVALS_PER_CONVERSATION),
        }),
        auditOutcome,
      );
    case 'undeliverable':
      return refuse(
        'the IM approval request could not be delivered',
        t.commandConfirm.browserUnattendedImUndeliverable,
        auditOutcome,
      );
    case 'aborted':
      return refuse(
        'the run was stopped while its IM approval was outstanding',
        t.commandConfirm.browserUnattendedImAborted,
        auditOutcome,
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
  const prompt = buildPrompt(request, getImApprovalTimeoutMs());
  const conversationId = request.conversationId;
  if (conversationId === undefined) {
    // No conversation to look a binding up from — the trigger engine's tiers
    // build their callbacks without one. Still notify: a refusal the user
    // never hears about looks exactly like a run that silently did nothing,
    // which is the failure the notice exit exists to prevent.
    publishApprovalNotice(null, prompt);
    const refusal = refuse(
      'no conversation on the unattended confirmation request, so no IM chat to ask in',
      t.commandConfirm.browserUnattendedImNoBinding,
      'no-channel',
    );
    return { ...refusal, audit: { ...refusal.audit, fresh: true } };
  }

  // Coalescing and answer caching are BOTH scoped to a run. Without a run key
  // there is no boundary: two overlapping runs would share one prompt (so one
  // run's "yes" would authorize the other's action), and a remembered answer
  // would never expire. Ask separately instead — a duplicate prompt is a
  // nuisance; a shared one is a security bug.
  const runScoped = request.runKey !== undefined;
  const key = coalesceKey(request, conversationId);

  // An answer already given for this exact ask in this run. A timeout is
  // remembered as a refusal too: someone who ignored the prompt for its whole
  // window must not be prompted again on the next tool call.
  const cached = runScoped ? answered.get(key) : undefined;
  // A replay of an answer already given. `fresh: false` so an audit counting
  // human decisions counts ONE "同意", not one per tool call that reused it.
  if (cached !== undefined) return { ...cached, audit: { ...cached.audit, fresh: false } };

  // Concurrent asks with the same key wait on the one prompt already out.
  let outcomePromise = runScoped ? inFlight.get(key) : undefined;
  const owned = outcomePromise === undefined;
  if (outcomePromise === undefined) {
    outcomePromise = askOverIm(request, conversationId, prompt);
    if (runScoped) inFlight.set(key, outcomePromise);
  }

  let outcome: ImApprovalResult;
  try {
    outcome = await outcomePromise;
  } finally {
    // Only the owner clears: a follower must not drop a newer entry.
    if (owned && runScoped && inFlight.get(key) === outcomePromise) inFlight.delete(key);
  }

  const result = describeOutcome(outcome);

  // An abort is not a decision — it is the run ending. Remembering it would
  // make a resumed/retried ask inherit a "no" nobody gave.
  //
  // Cached WITHOUT the freshness flag: `fresh` describes this particular call,
  // not the answer, and a replay must never be able to inherit a `true`.
  if (runScoped && outcome.cause !== 'aborted') rememberAnswer(key, result);

  // Only the call that owned the round-trip reports it. A follower that waited
  // on someone else's prompt did not produce a human decision of its own.
  return { ...result, audit: { ...result.audit, fresh: owned } };
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
