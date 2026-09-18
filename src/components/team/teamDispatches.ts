import type { BatchIdentity, BatchTaskTerminalStatus, Message, SubagentStopReason, ToolCall } from '@/types';
import type { ExecutionStep, ExecutionStepSnapshot, TaskExecution } from '@/types/execution';
import type { BatchEntry, BatchTaskStatus } from '@/stores/batchProgressStore';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { MEMBER_INSTRUCTION_STEP } from '@/core/agent/dispatchInput';
import { normalizeBatchTerminalSummary } from '@/core/agent/batchTerminalSummary';

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

function fromBatchTaskStatus(status: BatchTaskStatus): DispatchStatus {
  switch (status) {
    case 'queued':
    case 'running': return 'running';
    case 'succeeded': return 'completed';
    case 'failed': return 'error';
    case 'stopped': return 'interrupted';
    default: return 'unknown';
  }
}

/** A run_agent_batch call's own record: its input tasks and whatever says it ran. */
interface BatchSources {
  tasks: Array<{ agent?: string; label: string }>;
  live?: BatchEntry;
  summary?: Map<number, BatchTaskTerminalStatus>;
}

const NO_BATCH: BatchSources = { tasks: [] };

/** Same label the batch tool gives a task (orchestrationTools: first 60 chars). */
function batchTaskLabel(task: string): string {
  return task.slice(0, 60) + (task.length > 60 ? '…' : '');
}

function batchInputTasks(input: Record<string, unknown> | undefined): BatchSources['tasks'] {
  const raw = input?.tasks;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const record = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {};
    const task = typeof record.task === 'string' ? record.task : '';
    // Preset-type tasks are not team members.
    const agent = typeof record.agent_name === 'string' && record.agent_name && !record.type ? record.agent_name : undefined;
    return { agent, label: batchTaskLabel(task) };
  });
}

function batchSources(
  step: ExecutionStep | ExecutionStepSnapshot,
  conversationId: string,
  toolCalls: ReadonlyMap<string, ToolCall>,
  batches: readonly BatchEntry[],
): BatchSources {
  if (step.toolName !== TOOL_NAMES.RUN_AGENT_BATCH || !step.toolCallId) return NO_BATCH;
  const toolCall = toolCalls.get(step.toolCallId);
  const liveInput = (step as Partial<ExecutionStep>).toolInput;
  const tasks = batchInputTasks(liveInput && Object.keys(liveInput).length > 0 ? liveInput : toolCall?.input);
  const live = batches.find((entry) => entry.identity.conversationId === conversationId && entry.identity.batchToolCallId === step.toolCallId);
  const normalized = toolCall ? normalizeBatchTerminalSummary(toolCall.batchTerminalSummary) : undefined;
  const summary = normalized && normalized.batch.conversationId === conversationId && normalized.batch.batchToolCallId === step.toolCallId
    ? new Map(normalized.tasks.map((task) => [task.taskIndex, task.status]))
    : undefined;
  return { tasks, live, summary };
}

function fromStep(
  step: ExecutionStep | ExecutionStepSnapshot,
  conversationId: string,
  assistantMessageId: string | undefined,
  live: boolean,
  startTime: number | undefined,
  batch: BatchSources,
  interrupted = false,
): MemberDispatch[] {
  if (step.type !== 'delegate' || !step.toolCallId) return [];
  const identity: BatchIdentity = {
    conversationId,
    ...(assistantMessageId ? { assistantMessageId } : {}),
    batchToolCallId: step.toolCallId,
  };
  // Injected user instructions show in the process but are not tool calls.
  const children = ((step.childSteps ?? []) as Array<ExecutionStep | ExecutionStepSnapshot>)
    .filter((child) => child.toolName !== MEMBER_INSTRUCTION_STEP);
  if (step.toolName === TOOL_NAMES.RUN_AGENT_BATCH) {
    const byIndex = new Map<number, { agent: string; label: string; count: number; anyRunning: boolean; anyError: boolean }>();
    // The call itself is the ledger: once the batch is known to have started
    // (a live progress entry or a persisted terminal summary), every task in its
    // input is a hand-off, even one whose member never called a tool.
    const started = batch.live !== undefined || batch.summary !== undefined;
    if (started) {
      batch.tasks.forEach((task, index) => {
        if (task.agent) byIndex.set(index, { agent: task.agent, label: task.label, count: 0, anyRunning: false, anyError: false });
      });
    }
    for (const child of children) {
      const ref = child.batchTask;
      if (!ref) continue;
      const existing = byIndex.get(ref.index);
      const entry = existing ?? { agent: ref.agent ?? ref.label, label: ref.label, count: 0, anyRunning: false, anyError: false };
      if (ref.agent) entry.agent = ref.agent;
      entry.count += 1;
      if (child.status === 'running') entry.anyRunning = true;
      if (child.status === 'error') entry.anyError = true;
      byIndex.set(ref.index, entry);
    }
    const parentStatus = stepStatus(step.status);
    const taskStatus = (taskIndex: number, anyError: boolean): DispatchStatus => {
      if (interrupted) return 'interrupted';
      const liveStatus = batch.live?.tasks[taskIndex]?.status;
      if (liveStatus) return fromBatchTaskStatus(liveStatus);
      if (parentStatus === 'running') return 'running';
      const terminal = batch.summary?.get(taskIndex);
      if (terminal) return fromBatchTaskStatus(terminal);
      return anyError ? 'error' : parentStatus;
    };
    return Array.from(byIndex.entries()).map(([taskIndex, entry]) => ({
      key: `${step.toolCallId}:${taskIndex}`,
      agent: entry.agent,
      kind: 'batch',
      identity,
      taskIndex,
      label: entry.label,
      status: taskStatus(taskIndex, entry.anyError),
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

function fromSubagentStopReason(reason: SubagentStopReason): DispatchStatus {
  if (reason === 'completed') return 'completed';
  if (reason === 'aborted') return 'interrupted';
  if (reason === 'error') return 'error';
  return 'unknown';
}

function fromToolCall(call: ToolCall, conversationId: string, message: Message, interrupted: boolean): MemberDispatch[] {
  const identity: BatchIdentity = { conversationId, assistantMessageId: message.id, batchToolCallId: call.id };
  const base = { identity, stepCount: 0, startTime: call.startTime ?? message.timestamp, live: false };
  if (call.name === TOOL_NAMES.RUN_AGENT_BATCH) {
    const summary = normalizeBatchTerminalSummary(call.batchTerminalSummary, { conversationId, batchToolCallId: call.id });
    if (!summary) return [];
    const terminal = new Map(summary.tasks.map((task) => [task.taskIndex, task.status]));
    return batchInputTasks(call.input).flatMap((task, taskIndex) => {
      if (!task.agent) return [];
      const status = terminal.get(taskIndex);
      return [{
        ...base,
        key: `${call.id}:${taskIndex}`,
        agent: task.agent,
        kind: 'batch' as const,
        taskIndex,
        label: task.label,
        status: interrupted ? 'interrupted' : status ? fromBatchTaskStatus(status) : 'unknown',
      }];
    });
  }
  if (call.name === TOOL_NAMES.DELEGATE_TO_AGENT && call.subagentStopReason) {
    const agent = call.input?.agent_name;
    if (typeof agent !== 'string' || !agent) return [];
    const task = call.input?.task;
    return [{
      ...base,
      key: `${call.id}:0`,
      agent,
      kind: 'delegate',
      taskIndex: 0,
      label: typeof task === 'string' && task.trim() ? task.trim() : agent,
      status: interrupted ? 'interrupted' : fromSubagentStopReason(call.subagentStopReason),
    }];
  }
  return [];
}

/**
 * Every hand-off in a conversation, live first (taskExecutionStore) then the
 * persisted message snapshots, de-duplicated by tool call + task index.
 */
export function collectMemberDispatches(params: {
  conversationId: string;
  executions: readonly TaskExecution[];
  messages: readonly Message[];
  /** Live run_agent_batch progress (batchProgressStore). */
  batches?: readonly BatchEntry[];
}): MemberDispatch[] {
  const seen = new Map<string, MemberDispatch>();
  const batches = params.batches ?? [];
  const toolCalls = new Map<string, ToolCall>();
  for (const message of params.messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.name === TOOL_NAMES.RUN_AGENT_BATCH) toolCalls.set(call.id, call);
    }
  }
  const sourcesOf = (step: ExecutionStep | ExecutionStepSnapshot) => batchSources(step, params.conversationId, toolCalls, batches);
  for (const exec of params.executions) {
    if (exec.conversationId !== params.conversationId) continue;
    for (const step of exec.steps) {
      for (const d of fromStep(step, params.conversationId, undefined, true, step.startTime ?? exec.startTime, sourcesOf(step))) {
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
  const interruptedOf = (message: Message) => message.isStreaming === true || (!!message.loopId && interruptedLoops.has(message.loopId));
  for (const message of params.messages) {
    if (message.role !== 'assistant' || !message.executionSteps) continue;
    for (const step of message.executionSteps) {
      for (const d of fromStep(step, params.conversationId, message.id, false, message.timestamp, sourcesOf(step), interruptedOf(message))) {
        if (!seen.has(d.key)) seen.set(d.key, d);
      }
    }
  }
  // Last resort: the finished call itself. A message's execution-step snapshot
  // can be missing after a reload; the call's input and terminal metadata are
  // enough to say who was handed what.
  for (const message of params.messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      for (const d of fromToolCall(call, params.conversationId, message, interruptedOf(message))) {
        if (!seen.has(d.key)) seen.set(d.key, d);
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
}

/**
 * `@member body` typed while a run is in flight — either the composer's agent
 * chip or a leading `@name` token. null when the message does not address a
 * member or has no body to pass on.
 */
export function parseMemberAddress(message: string, selectedAgentName?: string | null): { member: string; body: string } | null {
  const trimmed = message.trim();
  if (selectedAgentName) {
    const prefix = `@${selectedAgentName}`;
    const body = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed;
    return body ? { member: selectedAgentName, body } : null;
  }
  const match = /^@(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const body = (match[2] ?? '').trim();
  return body ? { member: match[1], body } : null;
}

/** The member's newest hand-off that is still running in this app session. */
export function findRunningDispatch(dispatches: readonly MemberDispatch[], member: string): MemberDispatch | null {
  for (let i = dispatches.length - 1; i >= 0; i--) {
    const d = dispatches[i];
    if (d.agent === member && d.live && d.status === 'running') return d;
  }
  return null;
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
