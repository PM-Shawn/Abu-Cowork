import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { Steps, type Step, type StepStatus } from '@/components/ds/steps';
import { Tag } from '@/components/ds/tag';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { useI18n } from '@/i18n';
import type { PlannedStep } from '@/types/execution';

const EMPTY_STEPS: PlannedStep[] = [];

// plannedSteps snapshots are persisted onto chat messages, so a history
// conversation can carry a status from before the union was narrowed
// ('running', 'error'). Those keep their meaning here; anything unknown reads
// as not started.
function toStepStatus(status: string): StepStatus {
  if (status === 'completed') return 'done';
  if (status === 'in_progress' || status === 'running') return 'current';
  if (status === 'error') return 'error';
  return 'pending';
}

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
  // so gate on status 'running' — not mere presence. The title row spins only
  // while live; the step in flight always carries the still "current" marker,
  // so a stopped mid-flight step reads as "in progress, paused".
  const isLive = inMemoryPlannedSteps.length > 0 && activeStatus === 'running';
  const { t } = useI18n();

  const steps: Step[] = plannedSteps.map((step) => ({
    status: toStepStatus(step.status),
    title: (
      <>
        {step.description}
        {step.owner && (
          <span data-testid="plan-step-owner" className="ml-2 inline-flex align-middle">
            <Tag>@{step.owner}</Tag>
          </span>
        )}
      </>
    ),
  }));

  return (
    <div className="border-b border-separator pb-5">
      {/* Header: the one spinner of the progress area sits here while the run is live */}
      <Pressable
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="flex items-center gap-2">
          <Icon icon={AppIcons.plan} className="text-label-secondary" />
          <span className="text-ui font-medium text-label">{t.panel.progress}</span>
          {hasPlannedSteps && (
            <span className="text-caption text-label-tertiary">
              {plannedSteps.filter((s) => s.status === 'completed').length}/{plannedSteps.length}
            </span>
          )}
          {isLive && <Spinner size="sm" labelHidden label={t.task.running} />}
        </span>
        <Icon
          icon={AppIcons.expand}
          size="sm"
          className={cn('text-label-tertiary transition-transform duration-fast', !expanded && '-rotate-90')}
        />
      </Pressable>

      {/* Content */}
      {expanded && (
        <div className="mt-3">
          {hasPlannedSteps ? (
            <Steps label={t.panel.progress} steps={steps} />
          ) : (
            <div className="flex flex-col items-center py-4 text-center">
              <div className="mb-2 flex items-center gap-1">
                <span className="h-2 w-2 rounded-full border border-control-border" />
                <span className="h-px w-4 bg-separator" />
                <span className="h-2 w-2 rounded-full border border-control-border" />
                <span className="h-px w-4 bg-separator" />
                <span className="h-2 w-2 rounded-full border border-control-border" />
              </div>
              <p className="text-ui-sm text-label-tertiary">
                {t.panel.progressEmptyHint}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
