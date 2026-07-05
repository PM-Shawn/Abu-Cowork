import { useState } from 'react';
import { ChevronDown, ChevronRight, ListChecks, MessageSquare } from 'lucide-react';
import type { ToolCall } from '@/types';
import { parsePlanSteps } from '@/utils/workflowExtractor';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

/**
 * Compact inline summary for a report_plan tool call. The plan's full live
 * state (per-step progress) lives in the right-side progress panel — in the
 * chat flow this is a one-line "执行计划 · N 步" row, expandable to the step
 * list. While the plan awaits approval it starts expanded (the user must see
 * what they are approving) and points at the approval dock above the composer.
 */
export default function PlanStepsCard({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useI18n();
  const steps = parsePlanSteps(toolCall);
  const awaiting = toolCall.result === undefined;
  const [expanded, setExpanded] = useState(false);
  if (steps.length === 0) return null;

  return (
    <div className="my-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="btn-ghost w-full flex items-center gap-1.5 px-3 py-2 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-[var(--abu-text-tertiary)] shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-[var(--abu-text-tertiary)] shrink-0" />
        )}
        <ListChecks className="h-3.5 w-3.5 text-[var(--abu-clay)] shrink-0" />
        <span className="text-[12px] font-medium text-[var(--abu-text-primary)]">
          {t.planCard.title}
        </span>
        <span className="text-[11px] text-[var(--abu-text-muted)]">
          · {steps.length} {t.planCard.stepsUnit}
        </span>
        {awaiting && (
          <span className="ml-auto flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-[var(--abu-clay-bg)] text-[var(--abu-clay)] font-medium shrink-0">
            <MessageSquare className="h-3 w-3" />
            {t.planCard.awaiting}
          </span>
        )}
      </button>
      {expanded && (
        <ol className={cn('space-y-1 px-3 pb-2.5', !awaiting && 'pt-0.5')}>
          {steps.map((step, i) => (
            <li key={i} className="flex gap-2 text-[12px] leading-relaxed text-[var(--abu-text-secondary)]">
              <span className="shrink-0 text-[var(--abu-text-muted)]">{i + 1}.</span>
              <span className="min-w-0 break-words">{step}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
