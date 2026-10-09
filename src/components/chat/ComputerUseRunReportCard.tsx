import { useState } from 'react';
import type { ComputerStepOutcome, ToolCall } from '@/types';
import { useI18n, format } from '@/i18n';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import type { StatusTone } from '@/components/ds/status-icon';
import { Tag } from '@/components/ds/tag';
import { ToolResultImagePreview } from './ToolCallsGroup';

/**
 * Step-by-step evidence for one Computer Use run, built from the computer
 * tool calls of a message group: what Abu did, whether the Host verified it,
 * which steps were consequential and what the user approved, and the
 * screenshot each step returned. The steps carry no typed text or labels —
 * only counts, ids and outcomes — the tool calls above already show inputs.
 */
export default function ComputerUseRunReportCard({ steps, conversationId }: {
  steps: ToolCall[];
  conversationId?: string;
}) {
  const { t } = useI18n();
  const r = t.computerUse.report;
  const last = steps[steps.length - 1]?.computerStep;
  const attention = last ? !SETTLED_OUTCOMES.has(last.outcome) : false;
  const [expanded, setExpanded] = useState(attention);
  if (steps.length === 0) return null;

  const apps = Array.from(new Set(steps.map((tc) => tc.computerStep?.targetApp).filter((app): app is string => Boolean(app))));
  const verified = steps.filter((tc) => tc.computerStep?.outcome === 'verified-change').length;
  const consequential = steps.filter((tc) => tc.computerStep && tc.computerStep.consequence !== 'none').length;

  return (
    <div className="my-2 overflow-hidden rounded-panel border border-separator bg-surface" data-testid="cu-run-report">
      <Pressable
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-fast hover:bg-fill-hover"
      >
        <Icon icon={expanded ? AppIcons.expand : AppIcons.disclose} size="sm" className="text-label-tertiary" />
        <Icon icon={AppIcons.monitor} size="sm" className="text-label-secondary" />
        <span className="text-ui font-medium text-label">
          {apps.length > 0 ? format(r.titleWithApps, { apps: apps.join(' / ') }) : r.title}
        </span>
        <span className="text-ui-sm text-label-secondary">
          · {format(r.summary, { steps: steps.length, verified })}
          {consequential > 0 && ` · ${format(r.consequentialCount, { count: consequential })}`}
        </span>
        {last && (
          <span className="ml-auto shrink-0" data-testid="cu-run-final">
            <Tag tone={outcomeTone(last.outcome)}>{outcomeLabel(last.outcome, r)}</Tag>
          </span>
        )}
      </Pressable>
      {expanded && (
        <ol className="space-y-2 px-3 pb-3">
          {steps.map((tc, i) => {
            const step = tc.computerStep!;
            const image = tc.resultContent?.find((block) => block.type === 'image');
            return (
              <li key={tc.id} className="flex gap-2 text-ui text-label" data-testid="cu-run-step">
                <span className="w-5 shrink-0 text-right text-label-tertiary tabular-nums">{i + 1}.</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="break-words">{describeAction(tc.input, r)}</span>
                    <Tag tone={outcomeTone(step.outcome)}>
                      {outcomeLabel(step.outcome, r)}
                      {step.detail ? ` · ${step.detail}` : ''}
                    </Tag>
                    {step.consequence !== 'none' && (
                      <span data-testid="cu-run-consequence">
                        <Tag tone="danger">
                          {format(APPROVED_OUTCOMES.has(step.outcome) ? r.consequenceApproved : r.consequenceNotApproved, { category: step.consequence })}
                        </Tag>
                      </span>
                    )}
                  </div>
                  {step.consequence !== 'none' && step.consequenceDetail && (
                    <div className="break-words text-ui-sm text-label-secondary">{step.consequenceDetail}</div>
                  )}
                  {image && image.type === 'image' && !tc.hideScreenshot && (
                    <ToolResultImagePreview
                      block={image}
                      conversationId={conversationId}
                      alt={r.screenshotAlt}
                      frameClassName="mt-1 rounded-control border border-separator max-w-[200px] max-h-[120px] min-w-[80px] min-h-[50px] overflow-hidden"
                      thumbnailClassName="rounded-control max-w-[200px] max-h-[120px] object-contain"
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** Outcomes after which nothing needs the user; anything else opens the card. */
const SETTLED_OUTCOMES = new Set<ComputerStepOutcome>(['verified-change', 'no-change', 'ambiguous', 'done', 'observed', 'not-executed']);
/** A consequential step with one of these outcomes passed the native approval dialog before dispatch. */
const APPROVED_OUTCOMES = new Set<ComputerStepOutcome>(['verified-change', 'no-change', 'ambiguous', 'done', 'mismatch', 'outcome-unknown']);

type ReportStrings = ReturnType<typeof useI18n>['t']['computerUse']['report'];

function outcomeLabel(outcome: ComputerStepOutcome, r: ReportStrings): string {
  return {
    'verified-change': r.outcomeVerifiedChange,
    'no-change': r.outcomeNoChange,
    ambiguous: r.outcomeAmbiguous,
    done: r.outcomeDone,
    observed: r.outcomeObserved,
    'not-executed': r.outcomeNotExecuted,
    handoff: r.outcomeHandoff,
    boundary: r.outcomeBoundary,
    paused: r.outcomePaused,
    stopped: r.outcomeStopped,
    mismatch: r.outcomeMismatch,
    'outcome-unknown': r.outcomeUnknown,
    error: r.outcomeError,
  }[outcome];
}

function outcomeTone(outcome: ComputerStepOutcome): StatusTone {
  switch (outcome) {
    case 'verified-change':
    case 'done':
    case 'observed':
      return 'success';
    case 'no-change':
    case 'ambiguous':
    case 'not-executed':
      return 'info';
    case 'handoff':
    case 'boundary':
    case 'paused':
    case 'mismatch':
      return 'warning';
    default:
      return 'danger';
  }
}

/** One line per step from the tool input: ids, coordinates and counts only. */
function describeAction(input: Record<string, unknown>, r: ReportStrings): string {
  const action = String(input.action ?? '');
  const app = typeof input.app === 'string' ? input.app : typeof input.app_name === 'string' ? input.app_name : '';
  const point = Number.isFinite(input.x) && Number.isFinite(input.y) ? `(${input.x}, ${input.y})` : '';
  const element = input.element_id != null ? format(r.targetElement, { id: String(input.element_id) }) : '';
  switch (action) {
    case 'click':
    case 'ax_click':
      return format(r.actionClick, { target: element || point || '' }).trim();
    case 'type':
    case 'ax_type':
      return format(r.actionType, { count: typeof input.text === 'string' ? input.text.length : 0 });
    case 'key': {
      const modifiers = Array.isArray(input.modifiers) ? input.modifiers.filter((m): m is string => typeof m === 'string') : [];
      return format(r.actionKey, { key: [...modifiers, String(input.key ?? '')].join('+') });
    }
    case 'scroll':
      return format(r.actionScroll, { direction: String(input.direction ?? '') }).trim();
    case 'drag':
      return format(r.actionDrag, { target: Number.isFinite(input.end_x) ? `(${input.end_x}, ${input.end_y})` : point });
    case 'move':
      return format(r.actionMove, { target: point });
    case 'perform_action':
      return format(r.actionPerform, { name: String(input.action_name ?? input.name ?? ''), target: element });
    case 'activate_app':
    case 'activate':
      return format(r.actionActivate, { app });
    case 'get_app_state':
    case 'get_ui':
    case 'get_window_state':
      return format(r.actionObserve, { app }).trim();
    case 'screenshot':
    case 'get_screen_state':
      return r.actionScreenshot;
    case 'list_windows':
      return r.actionListWindows;
    case 'wait':
      return r.actionWait;
    default:
      return action;
  }
}
