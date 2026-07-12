import { useState } from 'react';
import {
  ChevronDown,
  Check,
  Loader2,
  Circle,
  ListChecks,
  AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { useI18n } from '@/i18n';
import type { PlannedStep } from '@/types/execution';

const EMPTY_STEPS: PlannedStep[] = [];

/**
 * TaskProgressPanel - Displays AI-reported task plan
 * Shows high-level business steps (not tool calls)
 */
export default function TaskProgressPanel() {
  const [expanded, setExpanded] = useState(true);
  // Get execution scoped to the current active conversation
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  // Stable selector: the latest execution WITH planned steps for this
  // conversation. Binding to the plain latest execution blanked the panel as
  // soon as a follow-up turn ran without report_plan — the plan display is
  // the panel's whole job, so it sticks to the most recent one (falling back
  // to the latest execution so the placeholder still shows for fresh convs).
  const latestExecId = useTaskExecutionStore((s) => {
    if (!activeConversationId) return null;
    let latestId: string | null = null;
    let latestTime = 0;
    let latestPlannedId: string | null = null;
    let latestPlannedTime = 0;
    for (const id in s.executions) {
      const exec = s.executions[id];
      if (exec.conversationId !== activeConversationId) continue;
      if (exec.startTime > latestTime) {
        latestTime = exec.startTime;
        latestId = id;
      }
      if (exec.plannedSteps.length > 0 && exec.startTime > latestPlannedTime) {
        latestPlannedTime = exec.startTime;
        latestPlannedId = id;
      }
    }
    return latestPlannedId ?? latestId;
  });
  // Read plannedSteps from that specific execution (stable reference when empty)
  const inMemoryPlannedSteps = useTaskExecutionStore((s) =>
    latestExecId ? (s.executions[latestExecId]?.plannedSteps ?? EMPTY_STEPS) : EMPTY_STEPS
  );
  // Status of the execution that owns those steps. On abort/cancel the loop
  // returns BEFORE persistExecutionSnapshot evicts, so a stopped execution
  // lingers in the store (status 'cancelled') — presence of plannedSteps alone
  // is NOT enough to tell "still running". Gate the spinner on 'running'.
  const activeStatus = useTaskExecutionStore((s) =>
    latestExecId ? s.executions[latestExecId]?.status : undefined
  );
  // Fallback: after a loop ends, persistExecutionSnapshot evicts the execution
  // and stores plannedSteps on the loop's last assistant message — scan the
  // active conversation from the end for the latest snapshot so the plan
  // stays visible instead of collapsing back to the placeholder.
  const messagePlannedSteps = useChatStore((s) => {
    if (!activeConversationId) return EMPTY_STEPS;
    const messages = s.conversations[activeConversationId]?.messages;
    if (!messages) return EMPTY_STEPS;
    for (let i = messages.length - 1; i >= 0; i--) {
      const steps = messages[i].plannedSteps;
      if (steps && steps.length > 0) return steps;
    }
    return EMPTY_STEPS;
  });
  const plannedSteps = inMemoryPlannedSteps.length > 0 ? inMemoryPlannedSteps : messagePlannedSteps;
  const hasPlannedSteps = plannedSteps.length > 0;
  // The plan is "live" only while the owning execution is actually running.
  // A stopped/completed execution lingers in the store (not evicted on abort),
  // so gate on status 'running' — not mere presence. When not live, an
  // in_progress step renders as a static marker (no spinner) so a stopped
  // mid-flight step reads as "in progress, paused" rather than spinning forever.
  const isLive = inMemoryPlannedSteps.length > 0 && activeStatus === 'running';
  const { t } = useI18n();

  return (
    <div className="task-progress-panel pb-5 border-b border-[var(--abu-border)]">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full text-left group"
      >
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-[var(--abu-text-tertiary)]" />
          <span className="text-[13px] font-medium text-[var(--abu-text-primary)]">{t.panel.progress}</span>
          {hasPlannedSteps && (
            <span className="text-[11px] text-[var(--abu-text-muted)]">
              {plannedSteps.filter((s) => s.status === 'completed').length}/{plannedSteps.length}
            </span>
          )}
        </div>
        <ChevronDown
          className={cn(
            'h-4 w-4 text-[var(--abu-text-muted)] transition-transform',
            !expanded && '-rotate-90'
          )}
        />
      </button>

      {/* Content */}
      {expanded && (
        <div className="mt-3">
          {hasPlannedSteps ? (
            // Steps list
            <div className="space-y-2">
              {plannedSteps.map((step) => (
                <ProgressStepRow key={step.index} step={step} isLive={isLive} />
              ))}
            </div>
          ) : (
            // Empty state - Claude Cowork style
            <div className="flex flex-col items-center py-4 text-center">
              <div className="flex items-center gap-1.5 mb-2">
                <Circle className="h-3 w-3 text-[var(--abu-bg-pressed)]" />
                <div className="w-4 h-px bg-[var(--abu-bg-pressed)]" />
                <Circle className="h-3 w-3 text-[var(--abu-bg-pressed)]" />
                <div className="w-4 h-px bg-[var(--abu-bg-pressed)]" />
                <Circle className="h-3 w-3 text-[var(--abu-bg-pressed)]" />
              </div>
              <p className="text-[12px] text-[var(--abu-text-muted)]">
                {t.panel.progressEmptyHint}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Progress Step Row (Claude Cowork style) ---

interface ProgressStepRowProps {
  step: PlannedStep;
  /** True only while a running execution still owns the plan. When false the
   * loop has stopped, so an in_progress step is shown static (no spinner). */
  isLive: boolean;
}

function ProgressStepRow({ step, isLive }: ProgressStepRowProps) {
  // Defensive/display-only normalization: plannedSteps snapshots get
  // persisted onto chat messages, so a history conversation can carry a
  // pre-narrowing status value ('running'/'error') that falls outside the
  // current PlannedStep['status'] union. Without this, those values hit the
  // switch's default branch and silently render as an empty "not started"
  // circle, losing whether the step was actually in-flight or failed. This
  // does NOT change the type — only how legacy/out-of-union values render.
  const rawStatus = step.status as string;
  const status = rawStatus === 'running' ? 'in_progress' : rawStatus;

  const renderStatusIcon = () => {
    switch (status) {
      case 'completed':
        return (
          <div className="w-5 h-5 rounded-full bg-[var(--abu-clay)] flex items-center justify-center">
            <Check className="h-3 w-3 text-white" strokeWidth={3} />
          </div>
        );
      case 'in_progress':
        // Spinner only while the run is live (active feedback). Once stopped,
        // a static clay dot — the step stays "in progress" but no longer implies
        // motion (mirrors TRAE's static in-progress marker).
        return (
          <div className="w-5 h-5 rounded-full border-2 border-[var(--abu-clay)] flex items-center justify-center">
            {isLive ? (
              <Loader2 className="h-3 w-3 text-[var(--abu-clay)] animate-spin" />
            ) : (
              <div className="h-2 w-2 rounded-full bg-[var(--abu-clay)]" />
            )}
          </div>
        );
      case 'error':
        // Legacy status, no longer produced going forward — kept only to
        // render historical snapshots that predate the status narrowing.
        return (
          <div className="w-5 h-5 rounded-full border-2 border-red-500 flex items-center justify-center">
            <AlertCircle className="h-3 w-3 text-red-500" />
          </div>
        );
      default:
        return (
          <div className="w-5 h-5 rounded-full border-2 border-[var(--abu-bg-pressed)] flex items-center justify-center">
            <Circle className="h-2 w-2 text-[var(--abu-bg-pressed)]" />
          </div>
        );
    }
  };

  return (
    <div className="flex items-start gap-3">
      <div className="shrink-0 mt-0.5">{renderStatusIcon()}</div>
      <span
        className={cn(
          'text-[13px] leading-6',
          status === 'completed' && 'text-[var(--abu-text-tertiary)]',
          status === 'in_progress' && 'text-[var(--abu-text-primary)]',
          status === 'error' && 'text-red-500',
          status === 'pending' && 'text-[var(--abu-text-muted)]'
        )}
      >
        {step.description}
      </span>
    </div>
  );
}
