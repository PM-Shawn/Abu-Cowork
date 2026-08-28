import { normalizeBatchTerminalSummary } from '@/core/agent/batchTerminalSummary';
import type { BatchEntry, BatchTaskProgress } from '@/stores/batchProgressStore';
import type { TranslationDict } from '@/i18n';
import { format } from '@/i18n';
import type { BatchIdentity, BatchTaskTerminalStatus, ToolCall } from '@/types';

export const BATCH_PROGRESS_MAX_UI_TASK_ROWS = 16;

export type BatchRowStatus = BatchTaskProgress['status'] | 'unknown';

export interface BatchTaskRow {
  taskIndex: number;
  label: string;
  status: BatchRowStatus;
  terminalReason?: string;
  toolCallCount?: number;
  lastToolName?: string;
  tokenTotal?: number;
  elapsedMs?: number | null;
  turn?: number;
  isLive: boolean;
}

export interface BatchRowsRollup {
  total: number;
  succeeded: number;
  failed: number;
  stopped: number;
  incomplete: number;
  running: number;
  cancelling: number;
  queued: number;
  unknown: number;
}

function taskElapsed(task: BatchTaskProgress, now: number): number | null {
  if (task.startedAt === undefined) return null;
  return (task.endedAt ?? now) - task.startedAt;
}

function totalTokens(task: BatchTaskProgress): number | undefined {
  const usage = task.tokenUsage;
  if (!usage) return undefined;
  return usage.inputTokens + usage.outputTokens + (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
}

export function taskInputLabels(toolCall: ToolCall, t: TranslationDict): string[] {
  const rawTasks = Array.isArray(toolCall.input?.tasks)
    ? toolCall.input.tasks.slice(0, BATCH_PROGRESS_MAX_UI_TASK_ROWS)
    : [];
  return rawTasks.map((rawTask, index) => {
    if (typeof rawTask === 'string' && rawTask.trim()) return rawTask;
    if (
      typeof rawTask === 'object'
      && rawTask !== null
      && typeof (rawTask as { task?: unknown }).task === 'string'
      && (rawTask as { task: string }).task.trim()
    ) {
      return (rawTask as { task: string }).task;
    }
    return format(t.batch.taskFallback, { n: index + 1 });
  });
}

type LegacyBatchTerminalStatus = Extract<BatchTaskTerminalStatus, 'succeeded' | 'failed'>;

function legacyTaskCount(toolCall: ToolCall): number | undefined {
  if (!Array.isArray(toolCall.input?.tasks)) return undefined;
  const count = Math.min(toolCall.input.tasks.length, BATCH_PROGRESS_MAX_UI_TASK_ROWS);
  return count > 0 ? count : undefined;
}

function structuredLegacyStatuses(
  result: string,
  expectedTaskCount: number,
): LegacyBatchTerminalStatus[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedTaskCount) return undefined;
  const statuses: LegacyBatchTerminalStatus[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || typeof (entry as { ok?: unknown }).ok !== 'boolean') {
      return undefined;
    }
    statuses.push((entry as { ok: boolean }).ok ? 'succeeded' : 'failed');
  }
  return statuses;
}

function aggregateHeaderCounts(result: string): {
  total: number;
  succeeded: number;
  failed: number;
} | undefined {
  const header = result.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const english = header.match(/^(\d+) sub-tasks total: (\d+) succeeded, (\d+) failed$/);
  const chinese = header.match(/^共 (\d+) 个子任务，成功 (\d+)，失败 (\d+)$/);
  const match = english ?? chinese;
  if (!match) return undefined;
  return {
    total: Number(match[1]),
    succeeded: Number(match[2]),
    failed: Number(match[3]),
  };
}

function sectionedLegacyStatuses(
  result: string,
  expectedTaskCount: number,
): LegacyBatchTerminalStatus[] | undefined {
  const counts = aggregateHeaderCounts(result);
  if (
    !counts
    || counts.total !== expectedTaskCount
    || counts.succeeded + counts.failed !== counts.total
  ) {
    return undefined;
  }
  if (counts.failed === 0) return Array.from({ length: counts.total }, () => 'succeeded');
  if (counts.succeeded === 0) return Array.from({ length: counts.total }, () => 'failed');

  const sectionPattern = /^### (?:Sub-task|子任务) (\d+):[^\r\n]*(?:\r?\n|$)/gm;
  const sections = [...result.matchAll(sectionPattern)];
  if (sections.length !== counts.total) return undefined;
  const statuses: Array<LegacyBatchTerminalStatus | undefined> = Array(counts.total);
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const section = sections[sectionIndex];
    const taskIndex = Number(section[1]) - 1;
    if (!Number.isInteger(taskIndex) || taskIndex < 0 || taskIndex >= counts.total || statuses[taskIndex]) {
      return undefined;
    }
    const bodyStart = (section.index ?? 0) + section[0].length;
    const bodyEnd = sections[sectionIndex + 1]?.index ?? result.length;
    const body = result.slice(bodyStart, bodyEnd).trimStart();
    statuses[taskIndex] = /^\[(?:Failed|失败)\](?:\s|$)/.test(body) ? 'failed' : 'succeeded';
  }
  if (statuses.some((status) => status === undefined)) return undefined;
  const terminalStatuses = statuses as LegacyBatchTerminalStatus[];
  const inferredFailed = terminalStatuses.filter((status) => status === 'failed').length;
  return inferredFailed === counts.failed ? terminalStatuses : undefined;
}

function legacyTerminalStatuses(toolCall: ToolCall): LegacyBatchTerminalStatus[] | undefined {
  const expectedTaskCount = legacyTaskCount(toolCall);
  if (toolCall.isExecuting || expectedTaskCount === undefined || typeof toolCall.result !== 'string') {
    return undefined;
  }
  return structuredLegacyStatuses(toolCall.result, expectedTaskCount)
    ?? sectionedLegacyStatuses(toolCall.result, expectedTaskCount);
}

/**
 * Infer the terminal rows written before batchTerminalSummary existed. Only
 * the two historical run_agent_batch output contracts are accepted: the
 * localized aggregate report and the structured `{ ok }[]` projection.
 * Arbitrary tool text intentionally falls back to the generic tool-result UI.
 */
export function rowsFromLegacyResult(toolCall: ToolCall, t: TranslationDict): BatchTaskRow[] | undefined {
  const statuses = legacyTerminalStatuses(toolCall);
  if (!statuses) return undefined;
  const labels = taskInputLabels(toolCall, t);
  return statuses.map((status, taskIndex) => ({
    taskIndex,
    label: labels[taskIndex] ?? format(t.batch.taskFallback, { n: taskIndex + 1 }),
    status,
    terminalReason: status === 'succeeded' ? 'completed' : 'error',
    isLive: false,
  }));
}

/** Whether this call has validated state for the dedicated batch card. */
export function shouldRenderBatchProgressCard(toolCall: ToolCall, identity?: BatchIdentity): boolean {
  if (toolCall.isExecuting === true || legacyTerminalStatuses(toolCall) !== undefined) return true;
  return identity !== undefined
    && normalizeBatchTerminalSummary(toolCall.batchTerminalSummary, identity) !== undefined;
}

export function rowsFromLiveBatch(batch: BatchEntry, now: number): BatchTaskRow[] {
  return batch.tasks.map((task, taskIndex) => ({
    taskIndex,
    label: task.label,
    status: task.status,
    terminalReason: task.terminalReason,
    toolCallCount: task.toolCallCount,
    lastToolName: task.lastToolName,
    tokenTotal: totalTokens(task),
    elapsedMs: taskElapsed(task, now),
    turn: task.turn,
    isLive: true,
  }));
}

export function rowsFromPersistedSummary(
  identity: BatchIdentity,
  toolCall: ToolCall,
  t: TranslationDict,
): BatchTaskRow[] | undefined {
  const summary = normalizeBatchTerminalSummary(toolCall.batchTerminalSummary, identity);
  if (!summary) return undefined;
  const labels = taskInputLabels(toolCall, t);
  const byIndex = new Map(summary.tasks.map((task) => [task.taskIndex, task]));
  return Array.from({ length: summary.taskCount }, (_, taskIndex) => {
    const terminal = byIndex.get(taskIndex);
    return {
      taskIndex,
      label: labels[taskIndex] ?? format(t.batch.taskFallback, { n: taskIndex + 1 }),
      status: terminal?.status ?? 'unknown',
      terminalReason: terminal?.terminalReason,
      isLive: false,
    };
  });
}

export function rowsFromUnknown(toolCall: ToolCall, t: TranslationDict): BatchTaskRow[] {
  const labels = taskInputLabels(toolCall, t);
  const count = Math.max(1, labels.length);
  return Array.from({ length: count }, (_, taskIndex) => ({
    taskIndex,
    label: labels[taskIndex] ?? format(t.batch.taskFallback, { n: taskIndex + 1 }),
    status: 'unknown',
    isLive: false,
  }));
}

export function canonicalRowStatus(status: BatchRowStatus): BatchTaskTerminalStatus | 'running' | 'cancelling' | 'queued' | 'unknown' {
  return status;
}

export function rollupBatchRows(rows: readonly BatchTaskRow[]): BatchRowsRollup {
  return rows.reduce<BatchRowsRollup>((counts, row) => {
    counts[canonicalRowStatus(row.status)]++;
    return counts;
  }, { total: rows.length, succeeded: 0, failed: 0, stopped: 0, incomplete: 0, running: 0, cancelling: 0, queued: 0, unknown: 0 });
}

export function isLiveRowStatus(status: BatchRowStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'cancelling';
}

export function batchRowStatusLabel(status: BatchRowStatus, t: TranslationDict): string {
  switch (status) {
    case 'queued':
      return t.workspace.agentStatusQueued;
    case 'running':
      return t.workspace.agentStatusRunning;
    case 'cancelling':
      return t.batch.statusCancelling;
    case 'succeeded':
      return t.workspace.agentStatusSucceeded;
    case 'failed':
      return t.workspace.agentStatusFailed;
    case 'stopped':
      return t.workspace.agentStatusStopped;
    case 'incomplete':
      return t.workspace.agentStatusIncomplete;
    case 'unknown':
      return t.batch.statusUnknown;
  }
}

export function compactBatchRollupSummary(rollup: BatchRowsRollup, t: TranslationDict): string {
  const parts: string[] = [];
  if (rollup.succeeded > 0) parts.push(format(t.batch.batchStatusSucceededCount, { n: rollup.succeeded }));
  if (rollup.failed > 0) parts.push(format(t.batch.batchStatusFailedCount, { n: rollup.failed }));
  if (rollup.stopped > 0) parts.push(format(t.batch.batchStatusStoppedCount, { n: rollup.stopped }));
  if (rollup.incomplete > 0) parts.push(format(t.batch.batchStatusIncompleteCount, { n: rollup.incomplete }));
  if (rollup.cancelling > 0) parts.push(format(t.batch.batchStatusCancellingCount, { n: rollup.cancelling }));
  const active = rollup.running + rollup.queued;
  if (active > 0) parts.push(format(t.batch.batchStatusRunningCount, { n: active }));
  if (rollup.unknown > 0) parts.push(format(t.batch.batchStatusUnknownCount, { n: rollup.unknown }));
  if (parts.length === 0 && rollup.total > 0) {
    parts.push(format(t.batch.batchStatusSucceededCount, { n: rollup.total }));
  }
  return parts.join(' · ');
}
