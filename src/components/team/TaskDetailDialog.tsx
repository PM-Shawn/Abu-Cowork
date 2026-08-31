import { useEffect, useMemo, useState } from 'react';
import { useTeamStore, type TeamPlanItem } from '@/stores/teamStore';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { agentRegistry } from '@/core/agent/registry';
import { confirmAndExecute, requestPlanAdjustment, acceptTask, rejectTask, retryItem, startPlanning } from '@/core/team/orchestrator';
import { useI18n, format } from '@/i18n';
import { Loader2, CheckCircle2, XCircle, Circle, ArrowRight, RotateCcw } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import DialogShell from './DialogShell';

/**
 * Team task detail: the 拆解确认屏 (the soul of the feature — PRD §4.4), live
 * execution view, and the review gate. One dialog serves 收件箱 + 任务 rows.
 *
 * Discipline mirrored from the PRD (updated 2026-08-31):
 * - Default: the plan is visible-not-blocking — execution auto-starts; the
 *   confirm buttons appear only for strict (requirePlanApproval) teams.
 * - 完成 is user-only (收下); rejection carries the user's words verbatim.
 * - Copy always names the member ("它"), never "我".
 */
export default function TaskDetailDialog({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const addToast = useToastStore((s) => s.addToast);
  const task = useTeamStore((s) => s.tasks.find((item) => item.id === taskId) ?? null);
  const team = useTeamStore((s) => s.teams.find((item) => item.id === task?.teamId) ?? null);
  const switchConversation = useChatStore((s) => s.switchConversation);
  const closeTeam = useSettingsStore((s) => s.closeTeam);

  const [adjusting, setAdjusting] = useState(false);
  const [adjustText, setAdjustText] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [rejectText, setRejectText] = useState('');
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) { setAdjusting(false); setAdjustText(''); setRejecting(false); setRejectText(''); setRejectTarget(null); }
  }, [taskId]);

  const memberName = useMemo(() => {
    const map = new Map<string, string>();
    for (const meta of agentRegistry.getAvailableAgents()) {
      const agent = agentRegistry.getAgent(meta.name);
      if (agent?.roleId) map.set(agent.roleId, agent.name);
    }
    return (roleId: string) => map.get(roleId) ?? t.team.unknownMember;
  }, [t, taskId]); // eslint-disable-line react-hooks/exhaustive-deps -- re-resolve when a different task opens

  if (!task) return null;

  const openRun = (conversationId?: string) => {
    if (!conversationId) return;
    onClose();
    closeTeam();
    void switchConversation(conversationId);
  };

  const itemIcon = (item: TeamPlanItem) => {
    switch (item.state) {
      case 'running': return <Loader2 className="h-4 w-4 animate-spin text-[var(--abu-info)]" />;
      case 'done': return <CheckCircle2 className="h-4 w-4 text-[var(--abu-success)]" />;
      case 'failed': return <XCircle className="h-4 w-4 text-[var(--abu-danger)]" />;
      default: return <Circle className="h-4 w-4 text-[var(--abu-text-tertiary)]" />;
    }
  };

  const planList = task.plan && (
    <div className="space-y-1.5" data-testid="plan-items">
      {task.plan.items.map((item) => (
        <div key={item.id} className="flex items-start gap-2.5 rounded-xl bg-[var(--abu-bg-muted)] px-3 py-2.5">
          <div className="mt-0.5 shrink-0">{itemIcon(item)}</div>
          <div className="flex-1 min-w-0">
            <div className="text-body text-[var(--abu-text-primary)]">
              <span className="font-medium">{memberName(item.memberRoleId)}</span>
              <span className="text-[var(--abu-text-tertiary)] mx-1.5">·</span>
              {item.what}
            </div>
            {item.produces && (
              <div className="text-caption text-[var(--abu-text-tertiary)] mt-0.5 flex items-center gap-1">
                <ArrowRight className="h-3 w-3" />{item.produces}
              </div>
            )}
            {item.dependsOn.length > 0 && (
              <div className="text-caption text-[var(--abu-text-tertiary)] mt-0.5">
                {format(t.team.itemDependsOn, { ids: item.dependsOn.join(', ') })}
              </div>
            )}
            {item.error && <div className="text-caption text-[var(--abu-danger)] mt-0.5">{item.error}</div>}
          </div>
          <div className="shrink-0 flex items-center gap-1.5">
            {item.conversationId && (
              <Button variant="ghost" size="xs" onClick={() => openRun(item.conversationId)}>{t.team.viewRun}</Button>
            )}
            {task.status === 'blocked' && item.state === 'failed' && (
              <Button variant="outline" size="xs" onClick={() => { void retryItem(task.id, item.id); }}>
                <RotateCcw className="h-3 w-3" />{t.team.retryItemAction}
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );

  const doneWhen = task.plan && task.plan.doneWhen.length > 0 && (
    <div>
      <div className="text-caption font-medium text-[var(--abu-text-secondary)]">{t.team.detailDoneWhen}</div>
      <ul className="mt-1 space-y-0.5">
        {task.plan.doneWhen.map((line, i) => (
          <li key={i} className="text-body text-[var(--abu-text-primary)]">· {line}</li>
        ))}
      </ul>
    </div>
  );

  const renderFooter = () => {
    switch (task.status) {
      case 'awaiting_plan': {
        if (!task.plan) {
          return (
            <div className="flex items-center gap-2 text-body text-[var(--abu-text-secondary)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              {task.memberRoleId
                ? t.team.memberTaskStarting
                : format(t.team.planWaiting, { leader: team ? memberName(team.leaderRoleId) : t.team.unknownMember })}
            </div>
          );
        }
        // Default mode: the plan is visible-not-blocking — execution starts on
        // its own moments after the proposal lands; no buttons to click.
        if (!team?.requirePlanApproval) {
          return (
            <div className="flex items-center gap-2 text-body text-[var(--abu-text-secondary)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t.team.planAutoStarting}
            </div>
          );
        }
        if (adjusting) {
          return (
            <div className="w-full space-y-2">
              <Textarea value={adjustText} onChange={(e) => setAdjustText(e.target.value)} rows={2} placeholder={t.team.planAdjustPlaceholder} data-testid="plan-adjust-input" />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setAdjusting(false)}>{t.common.cancel}</Button>
                <Button
                  disabled={!adjustText.trim()}
                  onClick={() => { void requestPlanAdjustment(task.id, adjustText.trim()); setAdjusting(false); setAdjustText(''); }}
                >
                  {t.team.planAdjustSend}
                </Button>
              </div>
            </div>
          );
        }
        return (
          <div className="flex justify-end gap-2 w-full">
            <Button variant="outline" onClick={() => setAdjusting(true)} data-testid="plan-adjust">{t.team.planAdjust}</Button>
            <Button
              data-testid="plan-confirm"
              onClick={() => {
                void confirmAndExecute(task.id);
                addToast({ type: 'success', title: t.team.confirmStarted });
                onClose();
              }}
            >
              {t.team.planConfirm}
            </Button>
          </div>
        );
      }
      case 'running':
        return <div className="text-body text-[var(--abu-text-secondary)]">{t.team.runningHint}</div>;
      case 'pending_review': {
        if (rejecting) {
          return (
            <div className="w-full space-y-2">
              {task.plan && task.plan.items.length > 1 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-caption text-[var(--abu-text-tertiary)]">{t.team.reviewRejectTarget}</span>
                  {task.plan.items.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setRejectTarget(rejectTarget === item.id ? null : item.id)}
                      className={`text-caption px-2 py-0.5 rounded-md border ${rejectTarget === item.id ? 'border-[var(--abu-clay)] text-[var(--abu-clay)]' : 'border-[var(--abu-border)] text-[var(--abu-text-secondary)]'}`}
                    >
                      {memberName(item.memberRoleId)}
                    </button>
                  ))}
                </div>
              )}
              <Textarea value={rejectText} onChange={(e) => setRejectText(e.target.value)} rows={2} placeholder={t.team.reviewRejectPlaceholder} data-testid="reject-input" />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setRejecting(false)}>{t.common.cancel}</Button>
                <Button
                  disabled={!rejectText.trim()}
                  onClick={() => { void rejectTask(task.id, rejectText.trim(), rejectTarget ?? undefined); setRejecting(false); onClose(); }}
                >
                  {t.team.reviewRejectSend}
                </Button>
              </div>
            </div>
          );
        }
        return (
          <div className="flex justify-end gap-2 w-full">
            <Button variant="outline" onClick={() => setRejecting(true)} data-testid="review-reject">{t.team.reviewReject}</Button>
            <Button data-testid="review-accept" onClick={() => { acceptTask(task.id); onClose(); }}>{t.team.reviewAccept}</Button>
          </div>
        );
      }
      case 'blocked':
        return (
          <div className="flex items-center justify-between w-full gap-3">
            <div className="text-body text-[var(--abu-danger)] min-w-0 truncate">{task.statusNote ?? t.team.statusBlocked}</div>
            {!task.plan && (
              <Button
                variant="outline"
                onClick={() => {
                  useTeamStore.getState().updateTaskStatus(task.id, 'awaiting_plan');
                  void startPlanning(task.id);
                }}
              >
                {t.team.replan}
              </Button>
            )}
          </div>
        );
      case 'done':
        return null;
    }
  };

  return (
    <DialogShell open={taskId !== null} onClose={onClose} title={task.goal.split('\n')[0]} wide>
      <div className="space-y-4">
        <div className="text-caption text-[var(--abu-text-tertiary)]">
          {team?.name ?? t.team.unknownTeam} · {new Date(task.createdAt).toLocaleString()}
        </div>
        {task.goal.includes('\n') && (
          <div className="text-body text-[var(--abu-text-primary)] whitespace-pre-wrap">{task.goal}</div>
        )}
        {task.plan && (
          <div>
            <div className="text-caption font-medium text-[var(--abu-text-secondary)] mb-1.5">
              {task.status === 'awaiting_plan' ? t.team.detailPlanProposed : t.team.detailPlanHeader}
            </div>
            {planList}
          </div>
        )}
        {doneWhen}
        {task.folder && (
          <div className="text-caption text-[var(--abu-text-tertiary)] break-all">
            {t.team.detailFolder}：{task.folder}
          </div>
        )}
        {task.planningConversationId && (
          <button className="text-caption text-[var(--abu-link)] hover:text-[var(--abu-link-hover)]" onClick={() => openRun(task.planningConversationId)}>
            {t.team.viewPlanningRun}
          </button>
        )}
        <div className="flex items-center pt-1 border-t border-[var(--abu-border)] mt-1 pt-3">
          {renderFooter()}
        </div>
      </div>
    </DialogShell>
  );
}
