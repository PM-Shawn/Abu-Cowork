import zhCN from '../../i18n/locales/zh-CN';
import enUS from '../../i18n/locales/en-US';

/**
 * Result markers for tool calls that never actually executed. Written with
 * error:false (they are not model mistakes), so consumers that need to
 * distinguish "skipped" from "succeeded" must compare against these
 * constants — e.g. ShowWidgetCard renders a muted "cancelled" row instead
 * of mounting the widget. Pre-existing literal values kept verbatim (they
 * are persisted in conversation history).
 */
export const TOOL_RESULT_CANCELLED_MARKER = '[已取消]';
export const TOOL_RESULT_HOOK_BLOCKED_MARKER = '[被 hook 拦截]';

/**
 * Every result string that means "this call never ran / was stopped".
 * Includes BOTH locale dictionaries' Stop-backfill value (chatStore's
 * cancelStreaming writes `getI18n().task.cancelled` — zh '[已取消]',
 * en '[Cancelled]'): history may have been persisted under either locale,
 * so matching only the active locale would misclassify the other locale's
 * backfills.
 */
export const NOT_RUN_TOOL_RESULTS: ReadonlySet<string> = new Set([
  TOOL_RESULT_CANCELLED_MARKER,
  TOOL_RESULT_HOOK_BLOCKED_MARKER,
  zhCN.task.cancelled,
  enUS.task.cancelled,
]);

/** Whether `result` is the marker of a tool call that was stopped or blocked before it ran. */
export function isToolResultNotRun(result: string): boolean {
  return NOT_RUN_TOOL_RESULTS.has(result);
}
