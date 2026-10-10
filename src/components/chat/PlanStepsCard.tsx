import { useState } from 'react';
import type { ToolCall } from '@/types';
import { parsePlanSteps } from '@/utils/workflowExtractor';
import { useI18n } from '@/i18n';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { Tag } from '@/components/ds/tag';

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
    <div className="my-2 overflow-hidden rounded-panel border border-separator bg-surface">
      <Pressable
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-fast hover:bg-fill-hover"
      >
        <Icon icon={expanded ? AppIcons.expand : AppIcons.disclose} size="sm" className="text-label-tertiary" />
        <Icon icon={AppIcons.plan} size="sm" className="text-label-secondary" />
        <span className="text-ui font-medium text-label">
          {t.planCard.title}
        </span>
        <span className="text-ui-sm text-label-secondary">
          · {steps.length} {t.planCard.stepsUnit}
        </span>
        {awaiting && (
          <span className="ml-auto shrink-0">
            <Tag>
              <Icon icon={AppIcons.awaitingAnswer} size="sm" />
              {t.planCard.awaiting}
            </Tag>
          </span>
        )}
      </Pressable>
      {expanded && (
        <ol className="space-y-1 px-3 pb-3">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-2 text-ui text-label-secondary">
              <span className="shrink-0 text-label-tertiary tabular-nums">{i + 1}.</span>
              <span className="min-w-0 break-words">{step}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
