import type { BatchIdentity, Message } from '@/types';
import type { ExecutionStep, ExecutionStepSnapshot, TaskExecution } from '@/types/execution';
import { TOOL_NAMES } from '@/core/tools/toolNames';

export type DispatchStatus = 'running' | 'completed' | 'error' | 'unknown' | 'interrupted';

/** One hand-off from the leader to a member: a delegate_to_agent call, or one task of a run_agent_batch call. */
export interface MemberDispatch {
  key: string;
  agent: string;
  kind: 'delegate' | 'batch';
  identity: BatchIdentity;
  taskIndex: number;
  /** Task text (delegate) or batch task label. */
  label: string;
  status: DispatchStatus;
  stepCount: number;
  startTime?: number;
  /** Latest child step start/end seen (live source only) — drives the stall hint. */
  lastActivityAt?: number;
  live: boolean;
}

function stepStatus(status: ExecutionStep['status'] | ExecutionStepSnapshot['status']): DispatchStatus {
  if (status === 'running' || status === 'pending') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'error') return 'error';
  return 'unknown';
}

function delegateLabel(step: { label: string; toolInput?: Record<string, unknown> }): string {
  const task = step.toolInput?.task;
  return typeof task === 'string' && task.trim() ? task.trim() : step.label;
}

function lastActivity(children: readonly (ExecutionStep | ExecutionStepSnapshot)[], fallback: number | undefined): number | undefined {
  let latest = fallback;
  for (const child of children) {
    const live = child as ExecutionStep;
    for (const at of [live.startTime, live.endTime]) {
      if (typeof at === 'number' && (latest === undefined || at > latest)) latest = at;
    }
  }
  return latest;
}

function fromStep(
  step: ExecutionStep | ExecutionStepSnapshot,
  conversationId: string,
  assistantMessageId: string | undefined,
  live: boolean,
  startTime: number | undefined,
  interrupted = false,
): MemberDispatch[] {
  if (step.type !== 'delegate' || !step.toolCallId) return [];
  const identity: BatchIdentity = {
    conversationId,
    ...(assistantMessageId ? { assistantMessageId } : {}),
    batchToolCallId: step.toolCallId,
  };
  const children = (step.childSteps ?? []) as Array<ExecutionStep | ExecutionStepSnapshot>;
  if (step.toolName === TOOL_NAMES.RUN_AGENT_BATCH) {
    const byIndex = new Map<number, { agent: string; label: string; count: number; anyRunning: boolean; anyError: boolean }>();
    for (const child of children) {
      const ref = child.batchTask;
      if (!ref) continue;
      const entry = byIndex.get(ref.index) ?? { agent: ref.agent ?? ref.label, label: ref.label, count: 0, anyRunning: false, anyError: false };
      entry.count += 1;
      if (child.status === 'running') entry.anyRunning = true;
      if (child.status === 'error') entry.anyError = true;
      byIndex.set(ref.index, entry);
    }
    const parentStatus = stepStatus(step.status);
    return Array.from(byIndex.entries()).map(([taskIndex, entry]) => ({
      key: `${step.toolCallId}:${taskIndex}`,
      agent: entry.agent,
      kind: 'batch',
      identity,
      taskIndex,
      label: entry.label,
      status: interrupted ? 'interrupted' : parentStatus === 'running' ? 'running' : entry.anyError ? 'error' : parentStatus,
      stepCount: entry.count,
      startTime,
      lastActivityAt: live ? lastActivity(children.filter((child) => child.batchTask?.index === taskIndex), startTime) : undefined,
      live,
    }));
  }
  const agent = step.agentName;
  if (!agent) return [];
  return [{
    key: `${step.toolCallId}:0`,
    agent,
    kind: 'delegate',
    identity,
    taskIndex: 0,
    label: delegateLabel(step as { label: string; toolInput?: Record<string, unknown> }),
    status: interrupted ? 'interrupted' : stepStatus(step.status),
    stepCount: children.length,
    startTime,
    lastActivityAt: live ? lastActivity(children, startTime) : undefined,
    live,
  }];
}

/**
 * Every hand-off in a conversation, live first (taskExecutionStore) then the
 * persisted message snapshots, de-duplicated by tool call + task index.
 */
export function collectMemberDispatches(params: {
  conversationId: string;
  executions: readonly TaskExecution[];
  messages: readonly Message[];
}): MemberDispatch[] {
  const seen = new Map<string, MemberDispatch>();
  for (const exec of params.executions) {
    if (exec.conversationId !== params.conversationId) continue;
    for (const step of exec.steps) {
      for (const d of fromStep(step, params.conversationId, undefined, true, step.startTime ?? exec.startTime)) {
        seen.set(d.key, d);
      }
    }
  }
  // Persistence clears isStreaming, but the shell marks the triggering user
  // message's runState 'interrupted' when a run never finished (restart /
  // crash): hand-offs of that loop are interrupted, not done.
  const interruptedLoops = new Set(
    params.messages.filter((m) => m.role === 'user' && m.runState === 'interrupted' && m.loopId).map((m) => m.loopId as string),
  );
  for (const message of params.messages) {
    if (message.role !== 'assistant' || !message.executionSteps) continue;
    const interrupted = message.isStreaming === true || (!!message.loopId && interruptedLoops.has(message.loopId));
    for (const step of message.executionSteps) {
      for (const d of fromStep(step, params.conversationId, message.id, false, message.timestamp, interrupted)) {
        if (!seen.has(d.key)) seen.set(d.key, d);
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
}

export interface MemberSummary {
  agent: string;
  dispatches: MemberDispatch[];
  latest: MemberDispatch | null;
  status: DispatchStatus | 'idle';
}

export function summarizeByMember(roster: readonly string[], dispatches: readonly MemberDispatch[]): MemberSummary[] {
  return roster.map((agent) => {
    const own = dispatches.filter((d) => d.agent === agent);
    const latest = own.length > 0 ? own[own.length - 1] : null;
    const status: MemberSummary['status'] = own.some((d) => d.status === 'running')
      ? 'running'
      : latest ? latest.status : 'idle';
    return { agent, dispatches: own, latest, status };
  });
}
