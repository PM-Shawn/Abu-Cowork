import type {
  BatchIdentity,
  BatchTaskTerminalReason,
  BatchTaskTerminalStatus,
  BatchTerminalSummary,
  BatchTerminalTaskSummary,
  SubagentStopReason,
} from '@/types';

const TERMINAL_STATUSES: BatchTaskTerminalStatus[] = ['succeeded', 'failed', 'stopped', 'incomplete'];
const MAX_BATCH_TERMINAL_TASK_COUNT = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

export function isValidTerminalPair(status: BatchTaskTerminalStatus, reason: BatchTaskTerminalReason): boolean {
  switch (status) {
    case 'succeeded':
      return reason === 'completed';
    case 'failed':
      return reason === 'error' || reason === 'timeout' || reason === 'invalid_structured';
    case 'stopped':
      return reason === 'aborted';
    case 'incomplete':
      return reason === 'max_turns';
  }
}

function parseStatus(value: unknown): BatchTaskTerminalStatus | undefined {
  return TERMINAL_STATUSES.includes(value as BatchTaskTerminalStatus)
    ? value as BatchTaskTerminalStatus
    : undefined;
}

function parseReason(value: unknown): BatchTaskTerminalReason | undefined {
  if (
    value === 'completed'
    || value === 'error'
    || value === 'aborted'
    || value === 'max_turns'
    || value === 'timeout'
    || value === 'invalid_structured'
  ) {
    return value;
  }
  return undefined;
}

function recomputeCounts(tasks: readonly BatchTerminalTaskSummary[]): Record<BatchTaskTerminalStatus, number> {
  const counts: Record<BatchTaskTerminalStatus, number> = {
    succeeded: 0,
    failed: 0,
    stopped: 0,
    incomplete: 0,
  };
  for (const task of tasks) counts[task.status]++;
  return counts;
}

export function normalizeBatchTerminalSummary(
  value: unknown,
  expected?: Partial<BatchIdentity>,
): BatchTerminalSummary | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (!isRecord(value.batch)) return undefined;
  const { conversationId, assistantMessageId: rawAssistantMessageId, batchToolCallId } = value.batch;
  if (typeof conversationId !== 'string' || conversationId.length === 0) return undefined;
  if (typeof batchToolCallId !== 'string' || batchToolCallId.length === 0) return undefined;
  if (
    rawAssistantMessageId !== undefined
    && (typeof rawAssistantMessageId !== 'string' || rawAssistantMessageId.length === 0)
  ) return undefined;
  if (expected?.conversationId !== undefined && conversationId !== expected.conversationId) return undefined;
  if (
    expected?.assistantMessageId !== undefined
    && rawAssistantMessageId !== undefined
    && rawAssistantMessageId !== expected.assistantMessageId
  ) return undefined;
  if (expected?.batchToolCallId !== undefined && batchToolCallId !== expected.batchToolCallId) return undefined;
  if (!isFiniteNonNegativeInteger(value.taskCount)) return undefined;
  if (value.taskCount < 1 || value.taskCount > MAX_BATCH_TERMINAL_TASK_COUNT) return undefined;
  if (!isRecord(value.counts)) return undefined;
  for (const status of TERMINAL_STATUSES) {
    if (!isFiniteNonNegativeInteger(value.counts[status])) return undefined;
  }
  if (!Array.isArray(value.tasks) || value.tasks.length > value.taskCount) return undefined;

  const seen = new Set<number>();
  const tasks: BatchTerminalTaskSummary[] = [];
  for (const rawTask of value.tasks) {
    if (!isRecord(rawTask)) return undefined;
    if (!isFiniteNonNegativeInteger(rawTask.taskIndex) || rawTask.taskIndex >= value.taskCount) return undefined;
    if (seen.has(rawTask.taskIndex)) return undefined;
    const status = parseStatus(rawTask.status);
    const terminalReason = parseReason(rawTask.terminalReason);
    if (!status || !terminalReason || !isValidTerminalPair(status, terminalReason)) return undefined;
    seen.add(rawTask.taskIndex);
    tasks.push({ taskIndex: rawTask.taskIndex, status, terminalReason });
  }

  const counts = recomputeCounts(tasks);
  for (const status of TERMINAL_STATUSES) {
    if (value.counts[status] !== counts[status]) return undefined;
  }

  // A legacy v1 summary may omit the message scope. Accept it when the two
  // original fields match, but do not manufacture a v2 identity on disk; only
  // newly emitted summaries carry the assistant id.
  const assistantMessageId = rawAssistantMessageId;
  return {
    version: 1,
    batch: {
      conversationId,
      ...(assistantMessageId ? { assistantMessageId } : {}),
      batchToolCallId,
    },
    taskCount: value.taskCount,
    counts,
    tasks,
  };
}

export function mergeBatchTerminalSummaries(
  existing: BatchTerminalSummary | undefined,
  incoming: BatchTerminalSummary,
): BatchTerminalSummary {
  if (
    existing
    && (
      existing.batch.conversationId !== incoming.batch.conversationId
      || (
        existing.batch.assistantMessageId !== undefined
        && incoming.batch.assistantMessageId !== undefined
        && existing.batch.assistantMessageId !== incoming.batch.assistantMessageId
      )
      || existing.batch.batchToolCallId !== incoming.batch.batchToolCallId
      || existing.taskCount !== incoming.taskCount
    )
  ) {
    return existing;
  }
  const byIndex = new Map<number, BatchTerminalTaskSummary>();
  for (const task of existing?.tasks ?? []) {
    byIndex.set(task.taskIndex, task);
  }
  for (const task of incoming.tasks) {
    if (!byIndex.has(task.taskIndex)) {
      byIndex.set(task.taskIndex, task);
    }
  }
  const tasks = [...byIndex.values()].sort((a, b) => a.taskIndex - b.taskIndex);
  return {
    version: 1,
    batch: incoming.batch,
    taskCount: incoming.taskCount,
    counts: recomputeCounts(tasks),
    tasks,
  };
}

export function batchSummaryHasNonSuccess(summary: BatchTerminalSummary | undefined): boolean {
  return !!summary && (summary.counts.failed > 0 || summary.counts.stopped > 0 || summary.counts.incomplete > 0);
}

export function subagentStopReasonFromBatchSummary(summary: BatchTerminalSummary): SubagentStopReason {
  if (summary.counts.failed > 0) return 'error';
  if (summary.counts.stopped > 0) return 'aborted';
  if (summary.counts.incomplete > 0) return 'max_turns';
  return 'completed';
}
