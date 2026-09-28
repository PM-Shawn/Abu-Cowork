import { useState } from 'react';
import { ChevronDown, ChevronRight, Monitor } from 'lucide-react';
import type { ComputerStepOutcome, ToolCall } from '@/types';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';
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
    <div className="my-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] overflow-hidden" data-testid="cu-run-report">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="btn-ghost w-full flex items-center gap-1.5 px-3 py-2 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-[var(--abu-text-tertiary)] shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-[var(--abu-text-tertiary)] shrink-0" />
        )}
        <Monitor className="h-3.5 w-3.5 text-[var(--abu-clay)] shrink-0" />
        <span className="text-minor font-medium text-[var(--abu-text-primary)]">
          {apps.length > 0 ? format(r.titleWithApps, { apps: apps.join(' / ') }) : r.title}
        </span>
        <span className="text-caption text-[var(--abu-text-muted)]">
          · {format(r.summary, { steps: steps.length, verified })}
          {consequential > 0 && ` · ${format(r.consequentialCount, { count: consequential })}`}
        </span>
        {last && (
          <span className={cn('ml-auto text-caption px-1.5 py-0.5 rounded', outcomeClass(last.outcome))} data-testid="cu-run-final">
            {outcomeLabel(last.outcome, r)}
          </span>
        )}
      </button>
      {expanded && (
        <ol className="space-y-1.5 px-3 pb-2.5">
          {steps.map((tc, i) => {
            const step = tc.computerStep!;
            const image = tc.resultContent?.find((block) => block.type === 'image');
            return (
              <li key={tc.id} className="flex gap-2 text-minor leading-relaxed text-[var(--abu-text-secondary)]" data-testid="cu-run-step">
                <span className="shrink-0 w-5 text-right text-[var(--abu-text-muted)] tabular-nums">{i + 1}.</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="break-words">{describeAction(tc.input, r)}</span>
                    <span className={cn('text-caption px-1.5 py-0.5 rounded', outcomeClass(step.outcome))}>
                      {outcomeLabel(step.outcome, r)}
                      {step.detail ? ` · ${step.detail}` : ''}
                    </span>
                    {step.consequence !== 'none' && (
                      <span className="text-caption px-1.5 py-0.5 rounded bg-[var(--abu-danger-bg)] text-[var(--abu-danger)]" data-testid="cu-run-consequence">
                        {format(APPROVED_OUTCOMES.has(step.outcome) ? r.consequenceApproved : r.consequenceNotApproved, { category: step.consequence })}
                      </span>
                    )}
                  </div>
                  {step.consequence !== 'none' && step.consequenceDetail && (
                    <div className="text-caption text-[var(--abu-text-muted)] break-words">{step.consequenceDetail}</div>
                  )}
                  {image && image.type === 'image' && !tc.hideScreenshot && (
                    <ToolResultImagePreview
                      block={image}
                      conversationId={conversationId}
                      alt={r.screenshotAlt}
                      frameClassName="mt-1 rounded border border-white/20 max-w-[200px] max-h-[120px] min-w-[80px] min-h-[50px] overflow-hidden"
                      thumbnailClassName="rounded max-w-[200px] max-h-[120px] object-contain"
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

function outcomeClass(outcome: ComputerStepOutcome): string {
  switch (outcome) {
    case 'verified-change':
    case 'done':
    case 'observed':
      return 'bg-[var(--abu-success-bg)] text-[var(--abu-success)]';
    case 'no-change':
    case 'ambiguous':
    case 'not-executed':
      return 'bg-[var(--abu-info-bg)] text-[var(--abu-info)]';
    case 'handoff':
    case 'boundary':
    case 'paused':
    case 'mismatch':
      return 'bg-[var(--abu-warning-bg)] text-[var(--abu-warning)]';
    default:
      return 'bg-[var(--abu-danger-bg)] text-[var(--abu-danger)]';
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
