import { useCallback, useEffect, useRef } from 'react';
import { useConfirm } from '@/components/ds/confirm-context';
import { format, useI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { computeRewindImpact } from '@/utils/rewindImpact';

export interface RewindTarget {
  conversationId: string;
  /** How many later turns the redo deletes, as counted when the action was pressed. */
  laterTurnsCount: number;
  /** The turn that is redone, the way `computeRewindImpact` is told about it. */
  loopId: string | undefined;
  fallbackMessageId: string;
  /** Messages the redo needs in the conversation: the one it was pressed on, the one it cuts at. */
  messageIds: string[];
}

/**
 * The question asked before a redo (regenerate, retry, edit and resend) that deletes the turns
 * after it. It resolves true when the redo may run now: the user confirmed, the message row that
 * asked is still on the page, and the conversation still holds the same messages to redo and the
 * same number of later turns the question named. Otherwise nothing is deleted.
 */
export function useRewindQuestion(): (target: RewindTarget) => Promise<boolean> {
  const confirm = useConfirm();
  const { t } = useI18n();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  return useCallback(async (target: RewindTarget) => {
    const confirmed = await confirm({
      title: t.chat.rewindConfirmTitle,
      message: format(t.chat.rewindConfirmMessage, { count: String(target.laterTurnsCount) }),
      confirmLabel: t.common.confirm,
      tone: 'danger',
    });
    if (!confirmed || !mounted.current) return false;
    const messages = useChatStore.getState().conversations[target.conversationId]?.messages ?? [];
    if (!target.messageIds.every((id) => messages.some((message) => message.id === id))) return false;
    return computeRewindImpact(messages, target.loopId, target.fallbackMessageId).laterTurnsCount === target.laterTurnsCount;
  }, [confirm, t]);
}
