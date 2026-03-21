import { useState } from 'react';
import {
  ChevronDown,
  Check,
  Loader2,
  Circle,
  AlertCircle,
  ListChecks,
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
  // Use a stable selector: read the latest execution ID for this conversation
  const latestExecId = useTaskExecutionStore((s) => {
    if (!activeConversationId) return null;
    let latestId: string | null = null;
    let latestTime = 0;
    for (const id in s.executions) {
      const exec = s.executions[id];
      if (exec.conversationId === activeConversationId && exec.startTime > latestTime) {
        latestTime = exec.startTime;
        latestId = id;
      }
    }
    return latestId;
  });
  // Read plannedSteps from that specific execution (stable reference when empty)
  const plannedSteps = useTaskExecutionStore((s) =>
    latestExecId ? (s.executions[latestExecId]?.plannedSteps ?? EMPTY_STEPS) : EMPTY_STEPS
  );
  const hasPlannedSteps = plannedSteps.length > 0;
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
                <ProgressStepRow key={step.index} step={step} />
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
}

function ProgressStepRow({ step }: ProgressStepRowProps) {
  const renderStatusIcon = () => {
    switch (step.status) {
      case 'completed':
        return (
          <div className="w-5 h-5 rounded-full bg-[var(--abu-clay)] flex items-center justify-center">
            <Check className="h-3 w-3 text-white" strokeWidth={3} />
          </div>
        );
      case 'running':
        return (
          <div className="w-5 h-5 rounded-full border-2 border-[var(--abu-clay)] flex items-center justify-center">
            <Loader2 className="h-3 w-3 text-[var(--abu-clay)] animate-spin" />
          </div>
        );
      case 'error':
        return (
          <div className="w-5 h-5 rounded-full bg-red-500 flex items-center justify-center">
            <AlertCircle className="h-3 w-3 text-white" />
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
          step.status === 'completed' && 'text-[var(--abu-text-tertiary)]',
          step.status === 'running' && 'text-[var(--abu-text-primary)]',
          step.status === 'pending' && 'text-[var(--abu-text-muted)]',
          step.status === 'error' && 'text-red-600'
        )}
      >
        {step.description}
      </span>
    </div>
  );
}
