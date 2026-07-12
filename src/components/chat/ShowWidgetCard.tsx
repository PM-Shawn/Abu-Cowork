import { useEffect, useMemo, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import type { ToolCall } from '@/types';
import { useI18n } from '@/i18n';
import zhCN from '@/i18n/locales/zh-CN';
import enUS from '@/i18n/locales/en-US';
import HtmlWidgetBlock from './HtmlWidgetBlock';
import { wrapSvgAsHtml } from './transforms';
import {
  detectWidgetRenderMode,
  sanitizeWidgetTitle,
  validateWidgetCode,
  SHOW_WIDGET_OK_MARKER,
} from '@/core/tools/definitions/widgetTools';
import {
  TOOL_RESULT_CANCELLED_MARKER,
  TOOL_RESULT_HOOK_BLOCKED_MARKER,
} from '@/core/agent/toolExecutor';

/**
 * Every result string that means "this call never ran / was stopped".
 * Includes BOTH locale dictionaries' Stop-backfill value (chatStore's
 * cancelStreaming writes `getI18n().task.cancelled` — zh '[已取消]',
 * en '[Cancelled]'): history may have been persisted under either locale,
 * so matching only the active locale would misclassify the other locale's
 * backfills.
 */
const CANCELLED_RESULTS: ReadonlySet<string> = new Set([
  TOOL_RESULT_CANCELLED_MARKER,
  TOOL_RESULT_HOOK_BLOCKED_MARKER,
  zhCN.task.cancelled,
  enUS.task.cancelled,
]);

/** Interval for cycling the skeleton captions (loading_messages). */
const LOADING_MESSAGE_CYCLE_MS = 2500;

/** Pull the loading_messages array out of a (possibly malformed/partial) tool input. */
function readLoadingMessages(input: Record<string, unknown> | undefined): string[] {
  const raw = input?.loading_messages;
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is string => typeof m === 'string');
}

/** Compact one-line muted status row — used for validation failures and
 *  cancelled/hook-blocked calls (the call is hidden from the generic tool
 *  list, so without this row a failed widget would vanish without a trace). */
function WidgetStatusRow({ label, title }: { label: string; title?: string }) {
  return (
    <div className="my-2 flex items-center gap-1.5 text-[12px] text-[var(--abu-text-muted)]">
      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {label}
        {title ? ` · ${title}` : ''}
      </span>
    </div>
  );
}

/** Pulsing skeleton shown while show_widget executes. Cycles through the
 *  model-provided loading_messages (they're written for exactly this) every
 *  couple of seconds; a single message just stays put. */
function WidgetSkeleton({ messages, fallback }: { messages: string[]; fallback: string }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (messages.length <= 1) return;
    const timer = setInterval(
      () => setIdx((i) => (i + 1) % messages.length),
      LOADING_MESSAGE_CYCLE_MS,
    );
    return () => clearInterval(timer);
  }, [messages.length]);

  return (
    <div className="my-3 rounded-lg bg-[var(--abu-bg-muted)] p-5 space-y-3 animate-pulse">
      <div className="h-4 w-2/5 rounded bg-[var(--abu-bg-pressed)]" />
      <div className="h-3 w-3/5 rounded bg-[var(--abu-bg-pressed)]" />
      <div className="text-[12px] text-[var(--abu-text-muted)]">
        {messages[idx] ?? fallback}
      </div>
    </div>
  );
}

/**
 * Inline card for a show_widget tool call. show_widget is hidden from the
 * generic tool list (agentLoop.ts marks it hidden:true — display-only; the
 * step bookkeeping still runs so planned-step advance counts widget calls)
 * — MessageGroup renders this card instead, at the tool call's real
 * position in the message flow, giving the "text, widget card, text"
 * layout WorkBuddy/ChatGPT/TRAE all use.
 *
 * Reads title/widget_code straight off `toolCall.input` (available as soon
 * as the tool_use event streams in — tool input arrives fully parsed, not
 * incrementally), not off the execute() result string.
 *
 * State machine — success detection is POSITIVE:
 * - executing (result pending)          → skeleton cycling loading_messages
 * - result undefined, not executing     → stale persisted state (crash/reload):
 *                                         render from input through the gate
 * - result starts with SHOW_WIDGET_OK_MARKER → widget (through the gate)
 * - result in CANCELLED_RESULTS         → muted "cancelled" row
 * - ANY other defined result            → muted "failed" row (param-error
 *   strings, registry-caught validation throws, enterprise policy denials —
 *   all come back with the error flag unset, so "not an error" is NOT a
 *   success signal; only the marker is)
 *
 * The validateWidgetCode gate additionally guards both render paths — the
 * marker proves execute() accepted the input, but the stale path never ran
 * it, and the gate keeps a single invariant: nothing mounts the renderer
 * without passing the same pure check the tool enforces.
 */
export default function ShowWidgetCard({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useI18n();
  const widgetCode = typeof toolCall.input?.widget_code === 'string' ? toolCall.input.widget_code : '';
  const title = typeof toolCall.input?.title === 'string' ? toolCall.input.title : undefined;
  const loadingMessages = readLoadingMessages(toolCall.input);

  // widget_code can be up to 1MB — don't re-run the regex battery on every
  // render (and hooks must run unconditionally, before any early return).
  const violation = useMemo(() => validateWidgetCode(widgetCode), [widgetCode]);

  // Skeleton only while the call is actually executing. A persisted
  // result===undefined with isExecuting unset means the app was reloaded
  // mid-call — fall through and render from input instead of spinning forever.
  if (toolCall.isExecuting && toolCall.result === undefined) {
    return <WidgetSkeleton messages={loadingMessages} fallback={t.chat.htmlWidgetLoading} />;
  }

  const settledOk =
    toolCall.result === undefined || // stale persisted state — input is complete, render it
    toolCall.result.startsWith(SHOW_WIDGET_OK_MARKER);

  if (!settledOk) {
    // Cancelled/stopped (either locale's backfill) vs. everything else
    // (validation throws surfaced as "Error executing tool…", policy
    // denials, param errors) — both are status rows, different wording.
    const cancelled = toolCall.result !== undefined && CANCELLED_RESULTS.has(toolCall.result);
    return (
      <WidgetStatusRow
        label={cancelled ? t.chat.widgetCardCancelled : t.chat.widgetCardError}
        title={title}
      />
    );
  }

  // Positive result (or stale) — still gate on the same pure validation the
  // tool enforces before mounting the renderer.
  if (violation !== null) {
    return <WidgetStatusRow label={t.chat.widgetCardError} title={title} />;
  }

  const renderCode = detectWidgetRenderMode(widgetCode) === 'svg' ? wrapSvgAsHtml(widgetCode) : widgetCode;
  // Sanitized title: it becomes RenderableCodeBlock's label, which is used
  // as the download filename stem — raw model titles ("2024/Q1 营收") would
  // break the save-dialog defaultPath.
  return <HtmlWidgetBlock code={renderCode} title={sanitizeWidgetTitle(title)} />;
}
