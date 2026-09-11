/**
 * The turn-cap notice: the marker message the agent loop appends when a run
 * hits its turn cap, plus what the global setting offers.
 *
 * Kept pure (no store, no clock, no id generator) so both halves can be tested
 * as functions of their inputs — the impure edges are `agentLoop` (which
 * appends the marker) and `MaxTurnsNoticeCard` (which acts on it).
 */
import type { Message } from '../../types';

export const MAX_TURNS_NOTICE_ID_PREFIX = 'max-turns-';

/**
 * What the GLOBAL 「最大轮次」 setting offers, in order.
 *
 * A fixed list rather than a free number field, so the two values that would
 * defeat the cap can't be entered at all: `0` (which `resolveMaxTurns` reads as
 * `Infinity`) and a number so large it is unlimited in practice. The ceiling
 * makes "the run always stops" true rather than nominal.
 *
 * `resolveMaxTurns` itself is NOT restricted — a skill's `max-turns`, an agent
 * definition and a hand-edited config keep the opt-in unlimited path.
 */
export const AGENT_MAX_TURNS_OPTIONS: readonly number[] = [50, 100, 200, 500, 1000];

/**
 * The values the setting should show, given what is currently stored.
 *
 * Normally just the presets. A value that is NOT one of them can only come from
 * outside this control — a hand-edited config, or an older build — and it is
 * kept in the list rather than rounded away, because the menu has to show the
 * cap that is actually in force. A non-positive stored value is that same case
 * at its extreme: it means unlimited, and hiding it would leave the user
 * reading "200" while the loop runs without a cap.
 *
 * Sorted ascending with unlimited (`0`) last, where "no cap" belongs.
 */
export function buildAgentMaxTurnsOptions(stored: number | undefined): number[] {
  const presets = [...AGENT_MAX_TURNS_OPTIONS];
  if (stored === undefined || presets.includes(stored)) return presets;
  if (stored <= 0) return [...presets, 0];
  return [...presets, stored].sort((a, b) => a - b);
}

/** What the user did with a notice card. Absent = still actionable. */
export type MaxTurnsNoticeAction = 'continued';

export interface MaxTurnsNotice {
  /** The cap this run actually ran into (may differ from the global setting). */
  limit: number;
  /**
   * 1 on the first cap hit, 2+ when the previous notice's 「继续执行」 is what
   * started the run that hit the cap again. A run the user started themselves
   * resets it — see {@link deriveMaxTurnsStreak}.
   */
  streak: number;
  /** Set once the user acts, so the choice stays visible in the transcript. */
  action?: MaxTurnsNoticeAction;
}

/**
 * True iff `msg` is a turn-cap marker: the id prefix AND the payload.
 *
 * Both halves are required, exactly as `isCompactBoundary` and
 * `isBrowserRunReportMessage` require both — a prefixed message with no
 * payload would render as an empty card.
 */
export function isMaxTurnsNoticeMessage(msg: Message): boolean {
  return msg.id.startsWith(MAX_TURNS_NOTICE_ID_PREFIX) && msg.maxTurnsNotice !== undefined;
}

/**
 * Build the marker the card renders from.
 *
 * `role: 'system'` with no `isSystem` flag — the same combination the
 * compaction boundary and the browser run report use, and load-bearing on both
 * sides: `isSystem` would HIDE it from the chat, while `role: 'system'` keeps
 * it out of the LLM context, so a continuation neither re-reads the notice nor
 * pays tokens for it.
 *
 * No `loopId`: the notice belongs to the run that just ended, not to a turn,
 * and an id-less message always starts its own group in `groupMessagesByLoop`,
 * which is what lets `ChatView` render it as a standalone card.
 *
 * `timestamp` is injected rather than read from the clock so the caller owns
 * time.
 */
export function createMaxTurnsNoticeMessage(options: {
  id: string;
  timestamp: number;
  limit: number;
  streak: number;
}): Message {
  return {
    id: `${MAX_TURNS_NOTICE_ID_PREFIX}${options.id}`,
    role: 'system',
    content: '',
    timestamp: options.timestamp,
    maxTurnsNotice: { limit: options.limit, streak: options.streak },
  };
}

/**
 * How many times in a row this conversation has run into the cap.
 *
 * Called with the messages as they stand BEFORE the new marker is appended.
 *
 * The streak only grows along one causal chain: a notice whose 「继续执行」 was
 * clicked, whose continuation then hit the cap again. That chain has a
 * signature we can read off the transcript — the continuation is dispatched as
 * an ordinary user message, so between the previous marker and the end there is
 * EXACTLY ONE user message. Anything else means the user drove in between (they
 * typed their own follow-up, or the continued run finished and a later,
 * unrelated run hit the cap), and the count starts over at 1.
 *
 * System-injected user messages (max-tokens recovery and friends) are not the
 * user driving, so they don't count.
 */
export function deriveMaxTurnsStreak(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const previous = messages[i];
    if (!isMaxTurnsNoticeMessage(previous)) continue;

    const notice = previous.maxTurnsNotice!;
    if (notice.action !== 'continued') return 1;

    let userMessagesSince = 0;
    for (let j = i + 1; j < messages.length; j++) {
      const message = messages[j];
      if (message.role === 'user' && !message.isSystem) userMessagesSince++;
    }
    return userMessagesSince === 1 ? notice.streak + 1 : 1;
  }
  return 1;
}
