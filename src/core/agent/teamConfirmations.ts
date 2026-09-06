import { confirmationKey, useTeamConfirmationStore, type TeamConfirmationInput } from '@/stores/teamConfirmationStore';
import { notifyTeamConfirmationPending } from '@/utils/notifications';
import { getI18n, format } from '@/i18n';
import { getConversationReader } from './ports/conversationReader';

export type TeamConfirmationDecision = 'ask' | 'approved' | 'pending';

/**
 * Team conversations never wait for a person (aligned with DSH, whose
 * delegated children are pinned to approval policy 'never'): an action that
 * would ask is refused now and recorded as "needs your confirmation"; an
 * identical request after the user approved it goes through once.
 *
 * 'ask' = not a team conversation, use the normal dialog.
 */
export function decideTeamConfirmation(
  conversationId: string,
  item: Omit<TeamConfirmationInput, 'conversationId'>,
): TeamConfirmationDecision {
  if (!conversationId) return 'ask';
  // Synchronous on purpose: the dialog path must keep enqueueing before the
  // caller's promise settles (existing callers read the pending entry right
  // after calling). The reader port avoids a store import cycle.
  if (!getConversationReader().getConversation(conversationId)?.teamId) return 'ask';

  const store = useTeamConfirmationStore.getState();
  if (store.consumeApproval(conversationId, confirmationKey(item))) return 'approved';
  const added = store.add({ ...item, conversationId });
  if (added) {
    const t = getI18n().team;
    notifyTeamConfirmationPending(
      format(t.confirmationNotice, { member: added.member ?? t.confirmationLeader, detail: added.detail }),
      conversationId,
    );
  }
  return 'pending';
}
