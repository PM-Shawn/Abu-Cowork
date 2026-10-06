import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { Button, IconButton } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Spinner } from '@/components/ds/spinner';
import { TextField } from '@/components/ds/text-field';
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
function GoalBar({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const confirm = useConfirm();
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
  // The bar is gone (another conversation is in view): an answer that comes then clears nothing.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // The inline edit replaces the edit button; when it closes, the focus goes back to that button.
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusToEditRef = useRef(false);
  useLayoutEffect(() => {
    if (editing || !returnFocusToEditRef.current) return;
    returnFocusToEditRef.current = false;
    editButtonRef.current?.focus();
  }, [editing]);

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
  const closeEdit = () => {
    returnFocusToEditRef.current = true;
    setEditing(false);
  };
  const saveEdit = () => {
    if (run({ kind: 'edit', objective: draft })) closeEdit();
  };
  const askClear = async () => {
    const askedGoalId = goal.id;
    const confirmed = await confirm({
      title: g.clearConfirmTitle,
      message: `${g.clearConfirmBody}\n${goal.objective}`,
      confirmLabel: g.actionClear,
      tone: 'danger',
    });
    if (!confirmed || !mountedRef.current) return;
    // The question named one goal. One that was set, or finished, while it was open stays.
    const current = useChatStore.getState().conversations[conversationId]?.goal;
    if (!current || current.id !== askedGoalId || current.phase === 'complete') return;
    run({ kind: 'clear' });
  };

  return (
    <div
      className="mb-2 rounded-panel border border-separator bg-surface px-3 py-1"
      data-testid="goal-bar"
    >
      <div className="flex items-center gap-2">
        {/* While a round runs, the spinner carries the status word. */}
        <span className="inline-flex shrink-0 items-center gap-2 text-ui-sm font-medium text-label-secondary" data-testid="goal-bar-status">
          {running && canPause
            ? <Spinner size="sm" label={status.label} />
            : <><Icon icon={AppIcons.goal} size="sm" />{status.label}</>}
        </span>
        {editing ? (
          <TextField
            value={draft}
            autoFocus
            aria-label={g.actionEdit}
            placeholder={g.editPlaceholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              const save = e.key === 'Enter' && !e.nativeEvent.isComposing;
              const cancel = e.key === 'Escape';
              if (!save && !cancel) return;
              // The focus moves to the edit button while this key is still down: without this,
              // the rest of the same Enter press would land on that button and open the edit again.
              e.preventDefault();
              if (save) saveEdit();
              else closeEdit();
            }}
            // As tall as the bar's buttons, so the bar keeps its height when the edit opens.
            className="h-6 min-w-0 flex-1"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-ui-sm text-label" title={status.detail ?? goal.objective}>
            {goal.objective}
          </span>
        )}
        {!editing && status.aside && (
          <span
            className={cn('shrink-0 text-caption tabular-nums', status.asideTone === 'warning' ? 'text-warning' : 'text-label-tertiary')}
            data-testid="goal-bar-aside"
          >
            {status.aside}
          </span>
        )}
        {editing ? (
          <>
            <Button size="sm" variant="plain" onClick={closeEdit}>{g.actionCancel}</Button>
            <Button size="sm" variant="secondary" onClick={saveEdit}>{g.actionSave}</Button>
          </>
        ) : (
          <>
            {/* Pause and resume take turns in one button, so the focus stays on it after a press. */}
            {(canPause || canResume) && (
              <IconButton
                size="sm"
                icon={canPause ? AppIcons.pause : AppIcons.continue}
                label={canPause ? g.actionPause : g.actionResume}
                onClick={() => run({ kind: canPause ? 'pause' : 'resume' })}
              />
            )}
            <IconButton ref={editButtonRef} size="sm" icon={AppIcons.rename} label={g.actionEdit} onClick={startEdit} />
            <IconButton size="sm" icon={AppIcons.close} label={g.actionClear} onClick={() => void askClear()} />
          </>
        )}
      </div>
    </div>
  );
}

// ChatView renders for every piece of a streamed reply; the bar's buttons carry tooltips.
export default memo(GoalBar);
