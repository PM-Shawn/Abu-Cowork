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

export function canonicalRowStatus(status: BatchRowStatus): BatchTaskTerminalStatus | 'running' | 'queued' | 'unknown' {
  return status;
}

export function rollupBatchRows(rows: readonly BatchTaskRow[]): BatchRowsRollup {
  return rows.reduce<BatchRowsRollup>((counts, row) => {
    counts[canonicalRowStatus(row.status)]++;
    return counts;
  }, { total: rows.length, succeeded: 0, failed: 0, stopped: 0, incomplete: 0, running: 0, queued: 0, unknown: 0 });
}

export function isLiveRowStatus(status: BatchRowStatus): boolean {
  return status === 'queued' || status === 'running';
}

export function batchRowStatusLabel(status: BatchRowStatus, t: TranslationDict): string {
  switch (status) {
    case 'queued':
      return t.workspace.agentStatusQueued;
    case 'running':
      return t.workspace.agentStatusRunning;
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
  const active = rollup.running + rollup.queued;
  if (active > 0) parts.push(format(t.batch.batchStatusRunningCount, { n: active }));
  if (rollup.unknown > 0) parts.push(format(t.batch.batchStatusUnknownCount, { n: rollup.unknown }));
  if (parts.length === 0 && rollup.total > 0) {
    parts.push(format(t.batch.batchStatusSucceededCount, { n: rollup.total }));
  }
  return parts.join(' · ');
}
