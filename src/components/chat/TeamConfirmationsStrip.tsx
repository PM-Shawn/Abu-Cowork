import { isRetryableTeamIdentity } from '@/core/agent/teamConfirmationIdentity';
import { useMemo, useState } from 'react';
import { ShieldAlert, Check, X, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { respondToTeamConfirmation } from '@/core/agent/teamConfirmations';
import { useI18n, format } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { pendingFor, useTeamConfirmationStore, type TeamConfirmation } from '@/stores/teamConfirmationStore';
import { enqueueUserInput } from '@/core/agent/userInputQueue';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';

/** Existing team approval strip: live answers resume the waiting call; stopped requests need an explicit retry. */
export default function TeamConfirmationsStrip({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const waiting = useTeamConfirmationStore((s) => s.waiting);
  const pending = useTeamConfirmationStore((s) => s.pending);
  const items = useMemo(() => pendingFor(pending, conversationId), [pending, conversationId]);
  const runRules = useTeamConfirmationStore((s) => s.runRules);
  const rules = Object.entries(runRules).filter(([, rule]) => rule.item.conversationId === conversationId);
  if (items.length === 0 && rules.length === 0) return null;

  const followUp = (text: string, teamConfirmationRetryId?: string) => {
    const running = useChatStore.getState().conversations[conversationId]?.status === 'running';
    if (running) {
      enqueueUserInput(conversationId, text, false, teamConfirmationRetryId);
      return;
    }
    void runAgentLoopDispatched(conversationId, text, { initiatedBy: 'user', teamConfirmationRetryId }).catch(() => {
      // Runtime grants are cleared by dispatch's finally; an unrelated later
      // message cannot pick up this failed retry's approval.
    });
  };
  const memberLabel = (item: TeamConfirmation) => item.member ?? t.team.confirmationLeader;

  const approve = (item: TeamConfirmation) => {
    if (waiting[item.id]) { respondToTeamConfirmation(item.id, true); return; }
    const selection = useTeamConfirmationStore.getState().selectRetry(item.id, 'once');
    if (!selection) return;
    followUp(format(t.team.confirmationApprovedFollowUp, { member: memberLabel(item), detail: item.detail }), selection);
  };
  const reject = (item: TeamConfirmation) => {
    if (waiting[item.id]) { respondToTeamConfirmation(item.id, false); return; }
    useTeamConfirmationStore.getState().remove(item.id);
  };

  return (
    <div className="mx-3 mb-1.5 rounded-lg border border-[var(--abu-warning)] bg-[var(--abu-bg-muted)] px-3 py-2" data-testid="team-confirmations-strip">
      <div className="mb-1 flex items-center gap-1.5 text-caption font-medium text-[var(--abu-text-primary)]">
        <ShieldAlert aria-hidden="true" className="h-3.5 w-3.5 text-[var(--abu-warning)]" />
        {format(t.team.confirmationStripTitle, { n: items.length })}
      </div>
      <ul className="max-h-64 space-y-3 overflow-y-auto pr-1">
        {items.map((item) => {
          const live = !!waiting[item.id];
          const action = item.kind === 'file'
            ? (item.capability === 'write'
              ? (item.additionalCapabilities?.includes('read') ? t.team.confirmationWriteRead : t.team.confirmationWrite)
              : t.team.confirmationRead)
            : item.kind === 'browser-upload' ? t.team.confirmationUpload
            : item.kind === 'browser' ? t.team.confirmationBrowser
            : item.kind === 'self-extension' ? t.team.confirmationExtension : t.team.confirmationCommand;
          const rejectLabel = live ? t.team.confirmationReject : t.team.confirmationDismiss;
          const approveLabel = live ? t.team.confirmationApprove : t.team.confirmationRetry;
          return (
            <li key={item.id} className="space-y-1.5 text-caption" data-testid="team-confirmation-item">
              <div className="font-medium text-[var(--abu-text-primary)]">{memberLabel(item)} · {action}</div>
              <div className="text-[var(--abu-text-secondary)]">{live ? t.team.confirmationWaiting : t.team.confirmationStopped}</div>
              {item.reason && item.kind !== 'file' && <div className="break-words text-[var(--abu-text-primary)]">{item.reason}</div>}
              {/* Keep the actual requested action visible, even when no reliable purpose is available. */}
              <div className="line-clamp-2 break-all text-[var(--abu-text-primary)]" title={item.detail}>{item.detail}</div>
              {item.identity && <div className="truncate text-[var(--abu-text-muted)]" title={item.identity.cwd ?? undefined}>
                {t.team.confirmationCwd}: {item.identity.cwd ?? t.team.confirmationDefaultCwd}
              </div>}
              {!isRetryableTeamIdentity(item.identity) && <div className="text-[var(--abu-text-muted)]">{t.team.confirmationLegacy}</div>}
              <Button type="button" size="xs" variant="ghost" aria-expanded={!!expanded[item.id]}
                aria-controls={`approval-details-${item.id}`}
                onClick={() => setExpanded((old) => ({ ...old, [item.id]: !old[item.id] }))}>
                {expanded[item.id] ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                {expanded[item.id] ? t.team.confirmationHideDetails : t.team.confirmationShowDetails}
              </Button>
              {expanded[item.id] && <div id={`approval-details-${item.id}`} className="space-y-1 text-[var(--abu-text-secondary)]">
                <pre className="whitespace-pre-wrap break-all text-caption">{item.detail}</pre>
                {item.identity && <div className="break-all">{t.team.confirmationCwd}: {item.identity.cwd ?? t.team.confirmationDefaultCwd}</div>}
              </div>}
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={() => approve(item)}
                  disabled={!isRetryableTeamIdentity(item.identity)} aria-label={`${approveLabel}: ${item.detail}`}>
                  <Check aria-hidden="true" />{approveLabel}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => reject(item)}
                  aria-label={`${rejectLabel}: ${item.detail}`}>
                  <X aria-hidden="true" />{rejectLabel}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {rules.map(([id, rule]) => <div key={id} className="mt-1 text-caption">
        {t.team.confirmationRunRule}: {memberLabel(rule.item)} · {rule.item.detail} · {t.team.confirmationCwd}: {rule.item.identity?.cwd ?? t.team.confirmationDefaultCwd}
        <Button type="button" size="xs" variant="link" className="ml-2" onClick={() => useTeamConfirmationStore.getState().revoke(id)}>{t.team.confirmationRevoke}</Button>
      </div>)}
    </div>
  );
}
