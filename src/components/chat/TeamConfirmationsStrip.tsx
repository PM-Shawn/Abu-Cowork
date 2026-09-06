import { useMemo } from 'react';
import { ShieldAlert, Check, X } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { confirmationKey, pendingFor, useTeamConfirmationStore, type TeamConfirmation } from '@/stores/teamConfirmationStore';
import { enqueueUserInput } from '@/core/agent/userInputQueue';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';

/**
 * "需要你确认" strip for a team conversation (block O): every action the run
 * refused because nobody could confirm it, with approve / reject. Approving
 * grants it once (file access via permissionStore, anything else as a
 * one-shot approval) and asks the leader to re-run only that step.
 */
export default function TeamConfirmationsStrip({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const pending = useTeamConfirmationStore((s) => s.pending);
  const items = useMemo(() => pendingFor(pending, conversationId), [pending, conversationId]);
  if (items.length === 0) return null;

  const followUp = (text: string) => {
    const running = useChatStore.getState().conversations[conversationId]?.status === 'running';
    if (running) {
      enqueueUserInput(conversationId, text);
      return;
    }
    void runAgentLoopDispatched(conversationId, text).catch(() => {
      // The leader could not be started (e.g. no model configured); the
      // approval itself is already granted, so a later message still works.
    });
  };
  const memberLabel = (item: TeamConfirmation) => item.member ?? t.team.confirmationLeader;

  const approve = (item: TeamConfirmation) => {
    if (item.kind === 'file' && item.path && item.capability) {
      usePermissionStore.getState().grantPermission(item.path, [item.capability], 'session');
    } else {
      useTeamConfirmationStore.getState().approveOnce(conversationId, confirmationKey(item));
    }
    useTeamConfirmationStore.getState().remove(item.id);
    followUp(format(t.team.confirmationApprovedFollowUp, { member: memberLabel(item), detail: item.detail }));
  };
  const reject = (item: TeamConfirmation) => {
    useTeamConfirmationStore.getState().remove(item.id);
    followUp(format(t.team.confirmationRejectedFollowUp, { member: memberLabel(item), detail: item.detail }));
  };

  return (
    <div className="mx-3 mb-1.5 rounded-lg border border-[var(--abu-warning)] bg-[var(--abu-bg-muted)] px-3 py-2" data-testid="team-confirmations-strip">
      <div className="mb-1 flex items-center gap-1.5 text-caption font-medium text-[var(--abu-text-primary)]">
        <ShieldAlert aria-hidden="true" className="h-3.5 w-3.5 text-[var(--abu-warning)]" />
        {format(t.team.confirmationStripTitle, { n: items.length })}
      </div>
      <ul className="max-h-40 space-y-1 overflow-y-auto pr-1">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2" data-testid="team-confirmation-item">
            <div className="min-w-0 flex-1 text-caption text-[var(--abu-text-secondary)]">
              <span className="text-[var(--abu-text-primary)]">{memberLabel(item)}</span>
              <span>{t.team.confirmationSeparator}</span>
              <code className="line-clamp-2 break-all align-top" title={item.detail}>{item.detail}</code>
              {item.reason && <span className="ml-1 text-[var(--abu-text-muted)]" title={item.reason}>（{item.reason.slice(0, 40)}{item.reason.length > 40 ? '…' : ''}）</span>}
            </div>
            <button
              type="button"
              onClick={() => approve(item)}
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[var(--abu-clay)] px-2 py-0.5 text-caption text-white hover:opacity-90"
              aria-label={`${t.team.confirmationApprove}: ${item.detail}`}
            >
              <Check aria-hidden="true" className="h-3 w-3" />
              {t.team.confirmationApprove}
            </button>
            <button
              type="button"
              onClick={() => reject(item)}
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-caption text-[var(--abu-text-muted)] hover:bg-[var(--abu-danger-bg)] hover:text-[var(--abu-danger)]"
              aria-label={`${t.team.confirmationReject}: ${item.detail}`}
            >
              <X aria-hidden="true" className="h-3 w-3" />
              {t.team.confirmationReject}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
