import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Loader2, Pause, Pencil, Play, Target, X } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import { getGoalActivation, subscribeGoalActivation, type GoalDisarmReason } from '@/core/goal/goalActivation';
import { applyGoalCommand, type GoalCommand } from '@/core/goal/goalCommand';
import type { GoalBlockedReason, GoalPhase, GoalState } from '@/core/goal/goalTypes';
import type { TranslationDict } from '@/i18n/types';

type GoalText = TranslationDict['chat']['goal'];

interface ActivationView {
  armed: boolean;
  disarmReason?: GoalDisarmReason;
  armedAt?: number;
  retry?: { attempt: number; at: number };
}

/** The activation as one string — a primitive so useSyncExternalStore's snapshot is stable. */
function activationSnapshot(conversationId: string, goalId: string | undefined): string {
  const activation = getGoalActivation(conversationId, goalId);
  return activation ? JSON.stringify(activation) : '';
}

function readActivation(snapshot: string): ActivationView {
  return snapshot ? JSON.parse(snapshot) as ActivationView : { armed: false };
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

/** Compact duration, like the run status line: "39s" / "12m 4s" / "2h 5m". */
function formatGoalDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m ${totalSec % 60}s`;
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

interface GoalStatus {
  /** The one status word shown before the objective. */
  label: string;
  /** Short text after the objective: working time, or when a failed run is retried. */
  aside?: string;
  asideTone?: 'muted' | 'warning';
  /** Hover detail: why the goal is paused or blocked. */
  detail?: string;
}

function goalStatus(
  phase: Exclude<GoalPhase, 'complete'>,
  goal: GoalState,
  activation: ActivationView,
  now: number,
  t: GoalText,
): GoalStatus {
  switch (phase) {
    case 'active': {
      if (!activation.armed) {
        return { label: t.barPaused, detail: activation.disarmReason === 'run-error' ? t.stoppedRunError : undefined };
      }
      if (activation.retry) {
        const minutes = Math.max(1, Math.ceil((activation.retry.at - now) / 60_000));
        return { label: t.barActive, aside: format(t.barRetry, { minutes }), asideTone: 'warning' };
      }
      const elapsedMs = goal.elapsedMs + Math.max(0, now - (activation.armedAt ?? now));
      return { label: t.barActive, aside: elapsedMs >= 1000 ? formatGoalDuration(elapsedMs) : undefined };
    }
    case 'paused':
      return { label: t.barPaused };
    case 'blocked':
      return { label: t.barBlocked, detail: blockedText(goal.blockedReason, t) };
  }
}

/**
 * Goal mode bar above the composer, one row: a status word, the objective,
 * the working time, and icon controls (pause / resume / edit / clear). Every
 * action goes through the same path as `/goal`. A completed goal has no bar:
 * the model's closing note in the transcript says what was done.
 */
export default function GoalBar({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const goal = useChatStore((s) => s.conversations[conversationId]?.goal);
  const running = useChatStore((s) => s.conversations[conversationId]?.status === 'running');
  const snapshot = useSyncExternalStore(
    subscribeGoalActivation,
    () => activationSnapshot(conversationId, goal?.id),
  );
  const activation = readActivation(snapshot);
  const ticking = goal?.phase === 'active' && activation.armed;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  const run = useCallback((command: Exclude<GoalCommand, { kind: 'create' }>) => {
    const outcome = applyGoalCommand(conversationId, command);
    if (!outcome.ok) useToastStore.getState().addToast({ type: 'error', title: outcome.message });
    return outcome.ok;
  }, [conversationId]);

  const phase = goal?.phase;
  if (!goal || !phase || phase === 'complete') return null;

  const g = t.chat.goal;
  const status = goalStatus(phase, goal, activation, now, g);
  const canPause = phase === 'active' && activation.armed;
  const canResume = phase === 'paused' || phase === 'blocked' || (phase === 'active' && !activation.armed);

  const startEdit = () => {
    setDraft(goal.objective);
    setEditing(true);
  };
  const saveEdit = () => {
    if (run({ kind: 'edit', objective: draft })) setEditing(false);
  };

  return (
    <div
      className="mb-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] px-3 py-1.5"
      data-testid="goal-bar"
    >
      <div className="flex items-center gap-2">
        {running && canPause
          ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--abu-text-secondary)]" />
          : <Target className="h-4 w-4 shrink-0 text-[var(--abu-text-secondary)]" />}
        <span className="shrink-0 text-minor font-medium text-[var(--abu-text-secondary)]" data-testid="goal-bar-status">{status.label}</span>
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
          <span className="min-w-0 flex-1 truncate text-minor text-[var(--abu-text-primary)]" title={status.detail ?? goal.objective}>
            {goal.objective}
          </span>
        )}
        {!editing && status.aside && (
          <span
            className={cn('shrink-0 text-caption tabular-nums', status.asideTone === 'warning' ? 'text-[var(--abu-warning)]' : 'text-[var(--abu-text-muted)]')}
            data-testid="goal-bar-aside"
          >
            {status.aside}
          </span>
        )}
        {editing ? (
          <>
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>{g.actionCancel}</Button>
            <Button size="xs" onClick={saveEdit}>{g.actionSave}</Button>
          </>
        ) : (
          <>
            {canPause && (
              <Button size="icon-xs" variant="ghost" aria-label={g.actionPause} title={g.actionPause} onClick={() => run({ kind: 'pause' })}>
                <Pause className="h-3.5 w-3.5" />
              </Button>
            )}
            {canResume && (
              <Button size="icon-xs" variant="ghost" aria-label={g.actionResume} title={g.actionResume} onClick={() => run({ kind: 'resume' })}>
                <Play className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button size="icon-xs" variant="ghost" aria-label={g.actionEdit} title={g.actionEdit} onClick={startEdit}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button size="icon-xs" variant="ghost" aria-label={g.actionClear} title={g.actionClear} onClick={() => setConfirmClear(true)}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>

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
