import { useCallback, useState, useSyncExternalStore } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Loader2, Pause, Pencil, Play, Target, X } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import { getGoalActivation, subscribeGoalActivation, type GoalDisarmReason } from '@/core/goal/goalActivation';
import { applyGoalCommand, type GoalCommand } from '@/core/goal/goalCommand';
import { GOAL_RESUME_EXTRA_ROUNDS, type GoalBlockedReason, type GoalState } from '@/core/goal/goalTypes';
import type { TranslationDict } from '@/i18n/types';

type GoalText = TranslationDict['chat']['goal'];

/** `'armed'` or the disarm reason — a primitive so useSyncExternalStore's snapshot is stable. */
type ActivationSnapshot = 'armed' | GoalDisarmReason | 'none';

function activationSnapshot(conversationId: string, goalId: string | undefined): ActivationSnapshot {
  const activation = getGoalActivation(conversationId, goalId);
  if (!activation) return 'none';
  return activation.armed ? 'armed' : activation.disarmReason ?? 'restart';
}

function blockedText(reason: GoalBlockedReason | undefined, t: GoalText): string {
  switch (reason?.code) {
    case 'no-progress': return t.blockedNoProgress;
    case 'round-limit': return t.blockedRoundLimit;
    case 'team-dispatch-limit': return t.blockedTeamLimit;
    case 'dispatch-failed': return t.blockedDispatchFailed;
    default: return format(t.blockedModel, { reason: reason?.message ?? '' });
  }
}

function stoppedText(activation: ActivationSnapshot, t: GoalText): string {
  if (activation === 'run-error') return t.stoppedRunError;
  if (activation === 'user-stop') return t.stoppedUserStop;
  return t.stoppedRestart;
}

/** Status line for the goal: what state it is in and why automatic rounds are (not) running. */
function statusLine(goal: GoalState, activation: ActivationSnapshot, running: boolean, t: GoalText): { text: string; tone: 'info' | 'warning' | 'muted' | 'success' } {
  switch (goal.phase) {
    case 'active':
      if (activation === 'armed') return { text: running ? t.barRunning : t.phaseActive, tone: 'info' };
      return { text: stoppedText(activation, t), tone: 'warning' };
    case 'paused':
      return { text: t.phasePaused, tone: 'muted' };
    case 'blocked':
      return { text: blockedText(goal.blockedReason, t), tone: 'warning' };
    case 'complete':
      return { text: t.completedTitle, tone: 'success' };
  }
}

const TONE_CLASS: Record<'info' | 'warning' | 'muted' | 'success', string> = {
  info: 'text-[var(--abu-info)]',
  warning: 'text-[var(--abu-warning)]',
  muted: 'text-[var(--abu-text-tertiary)]',
  success: 'text-[var(--abu-success)]',
};

/**
 * Goal mode bar above the composer: the objective, round usage, why automatic
 * rounds are or are not running, and the user's controls (pause / resume /
 * edit / clear). Every action goes through the same path as `/goal`.
 */
export default function GoalBar({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const goal = useChatStore((s) => s.conversations[conversationId]?.goal);
  const running = useChatStore((s) => s.conversations[conversationId]?.status === 'running');
  const activation = useSyncExternalStore(
    subscribeGoalActivation,
    () => activationSnapshot(conversationId, goal?.id),
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);

  const run = useCallback((command: Exclude<GoalCommand, { kind: 'create' }>) => {
    const outcome = applyGoalCommand(conversationId, command);
    if (!outcome.ok) useToastStore.getState().addToast({ type: 'error', title: outcome.message });
    return outcome.ok;
  }, [conversationId]);

  if (!goal) return null;

  const g = t.chat.goal;
  const status = statusLine(goal, activation, running, g);
  const canPause = goal.phase === 'active' && activation === 'armed';
  const needsMoreRounds = goal.roundsStarted >= goal.maxRounds;
  const canResume = goal.phase === 'paused' || goal.phase === 'blocked' || (goal.phase === 'active' && activation !== 'armed');

  const startEdit = () => {
    setDraft(goal.objective);
    setEditing(true);
  };
  const saveEdit = () => {
    if (run({ kind: 'edit', objective: draft })) setEditing(false);
  };

  return (
    <div
      className="mb-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] px-3 py-2"
      data-testid="goal-bar"
    >
      <div className="flex items-center gap-2">
        {goal.phase === 'complete'
          ? <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--abu-success)]" />
          : running && canPause
            ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--abu-info)]" />
            : <Target className="h-4 w-4 shrink-0 text-[var(--abu-text-secondary)]" />}
        <span className="shrink-0 text-minor font-medium text-[var(--abu-text-secondary)]">{g.barLabel}</span>
        {editing ? (
          <Input
            value={draft}
            autoFocus
            placeholder={g.editPlaceholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) saveEdit();
              if (e.key === 'Escape') setEditing(false);
            }}
            className="h-7 flex-1 text-minor"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-minor text-[var(--abu-text-primary)]" title={goal.objective}>
            {goal.objective}
          </span>
        )}
        {!editing && goal.phase !== 'complete' && (
          <span className="shrink-0 text-caption text-[var(--abu-text-muted)]">
            {format(g.barRounds, { rounds: goal.roundsStarted, maxRounds: goal.maxRounds })}
          </span>
        )}
      </div>

      <div className="mt-1 flex items-center gap-2 pl-6">
        <span className={cn('min-w-0 flex-1 truncate text-caption', TONE_CLASS[status.tone])} title={status.text}>
          {status.text}
        </span>
        {editing ? (
          <>
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>{g.actionCancel}</Button>
            <Button size="xs" onClick={saveEdit}>{g.actionSave}</Button>
          </>
        ) : (
          <>
            {goal.phase === 'complete' && goal.completion && goal.completion.evidence.length > 0 && (
              <Button size="xs" variant="ghost" onClick={() => setShowEvidence((v) => !v)}>
                {g.evidenceLabel}
                {showEvidence ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </Button>
            )}
            {canPause && (
              <Button size="xs" variant="ghost" onClick={() => run({ kind: 'pause' })}>
                <Pause className="h-3.5 w-3.5" />
                {g.actionPause}
              </Button>
            )}
            {canResume && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => run(needsMoreRounds ? { kind: 'resume', extraRounds: GOAL_RESUME_EXTRA_ROUNDS } : { kind: 'resume' })}
              >
                <Play className="h-3.5 w-3.5" />
                {needsMoreRounds ? format(g.actionResumeMore, { extra: GOAL_RESUME_EXTRA_ROUNDS }) : g.actionResume}
              </Button>
            )}
            {goal.phase !== 'complete' && (
              <Button size="icon-xs" variant="ghost" aria-label={g.actionEdit} title={g.actionEdit} onClick={startEdit}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button size="icon-xs" variant="ghost" aria-label={g.actionClear} title={g.actionClear} onClick={() => setConfirmClear(true)}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>

      {goal.phase === 'complete' && goal.completion && (
        <div className="mt-1 pl-6 text-caption text-[var(--abu-text-secondary)]">
          <p className="line-clamp-2" title={goal.completion.summary}>{goal.completion.summary}</p>
          {showEvidence && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[var(--abu-text-tertiary)]">
              {goal.completion.evidence.map((item, index) => <li key={index} className="break-all">{item}</li>)}
            </ul>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmClear}
        title={g.clearConfirmTitle}
        message={g.clearConfirmBody}
        confirmText={g.actionClear}
        cancelText={g.actionCancel}
        variant="danger"
        onConfirm={() => {
          setConfirmClear(false);
          run({ kind: 'clear' });
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
