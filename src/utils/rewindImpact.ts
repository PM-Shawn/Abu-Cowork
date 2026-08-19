import type { Message } from '@/types';

/**
 * Rewind entry points (edit-resend, regenerate, run-retry, loop-level retry)
 * all funnel into `chatStore.deleteMessagesFrom`, which truncates a
 * conversation's messages from a given point onward — durably discarding
 * everything after it (see plan stage 3). When the turn being redone is the
 * conversation's last turn, that's a no-op loss (nothing after it). When it
 * is NOT the last turn, any later turns are silently and permanently deleted.
 *
 * This computes whether such later turns exist, so callers can gate the
 * destructive rewind behind a confirmation dialog — and how many turns would
 * be lost, for the dialog copy.
 *
 * @param messages - the full conversation's messages, in order.
 * @param loopId - the loopId of the turn being redone. Messages sharing a
 *   loopId are contiguous (agentLoop appends in order; a new loop starts with
 *   a new user message), so the redone turn's last message is the last one
 *   in `messages` sharing this id.
 * @param fallbackMessageId - message id to anchor on when `loopId` is absent
 *   (legacy transcripts predating loopId, or a message that never got one).
 */
export function computeRewindImpact(
  messages: Message[],
  loopId: string | undefined,
  fallbackMessageId: string,
): { hasLaterTurns: boolean; laterTurnsCount: number } {
  let lastIdx = -1;
  if (loopId) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].loopId === loopId) {
        lastIdx = i;
        break;
      }
    }
  }
  if (lastIdx === -1) {
    lastIdx = messages.findIndex((m) => m.id === fallbackMessageId);
  }
  if (lastIdx === -1 || lastIdx >= messages.length - 1) {
    return { hasLaterTurns: false, laterTurnsCount: 0 };
  }

  // Count distinct turns after the cut point. A "turn" is a group of messages
  // sharing a loopId; messages without one (legacy) each count as their own
  // turn. Using distinct loopIds (rather than counting user messages) keeps
  // this robust even if a trailing turn's user message was itself removed by
  // an earlier edit, and guarantees a non-zero count whenever later messages
  // exist — cheap to compute, no additional lookups needed.
  const laterLoopIds = new Set<string>();
  let anonymousCount = 0;
  for (const m of messages.slice(lastIdx + 1)) {
    if (m.loopId) laterLoopIds.add(m.loopId);
    else anonymousCount++;
  }

  return { hasLaterTurns: true, laterTurnsCount: laterLoopIds.size + anonymousCount };
}
