import type { Message } from '@/types';
import { getMessageText } from '@/core/context/contextUtils';

/**
 * Where a full-text search hit lands in the transcript: the first message the
 * user can see whose text contains the query, and the index of the shown group
 * that holds it. Null when nothing matches or the match is in no shown group.
 */
export function searchJumpTarget(
  messages: readonly Message[],
  groups: readonly (readonly Message[])[],
  query: string,
  messageId?: string,
): { groupIndex: number; messageId: string } | null {
  const q = query.trim().toLowerCase();
  const target = messages.find(
    (m) => messageId ? m.id === messageId : (!m.isSystem || m.isRecoveryNotice)
      && getMessageText(m.content).toLowerCase().includes(q),
  );
  if (!target) return null;
  const groupIndex = groups.findIndex((group) => group.some((m) => m.id === target.id));
  return groupIndex < 0 ? null : { groupIndex, messageId: target.id };
}
