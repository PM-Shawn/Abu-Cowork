import { useId, useSyncExternalStore } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { getConversationBranchEligibility } from '@/core/session/conversationBranchHistory';
import { isConversationBranchCreating, requestConversationBranch, subscribeConversationBranches } from '@/core/session/conversationBranch';
import { IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { useI18n } from '@/i18n';

export function ConversationBranchButton({ conversationId, messageId }: { conversationId: string; messageId: string }) {
  const { t } = useI18n();
  const messages = useChatStore(state => state.conversations[conversationId]?.messages);
  const loadFailed = useChatStore(state => state.loadFailures[conversationId]);
  const busy = useSyncExternalStore(subscribeConversationBranches, () => isConversationBranchCreating(conversationId, messageId));
  const descriptionId = useId();
  if (!messages) return null;
  const eligibility = getConversationBranchEligibility(messages, messageId, !loadFailed);
  if (!eligibility.eligible && eligibility.reason === 'unavailable') return null;
  const unavailable = !eligibility.eligible;
  const description = unavailable
    ? eligibility.reason === 'inaccessible' ? t.chat.branch.historyUnavailable : t.chat.branch.incomplete
    : undefined;
  return <>
    <IconButton icon={AppIcons.branch} label={description ? `${t.chat.branch.action} · ${description}` : t.chat.branch.action} size="sm" busy={busy}
      aria-disabled={unavailable || busy || undefined} aria-describedby={description ? descriptionId : undefined}
      onClick={() => { if (!unavailable) requestConversationBranch(conversationId, messageId); }} />
    {description && <span id={descriptionId} className="sr-only">{description}</span>}
    {busy && <span role="status" className="text-ui-sm text-label-secondary">{t.chat.branch.creating}</span>}
  </>;
}
