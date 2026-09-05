import { useEffect, useMemo, useState } from 'react';
import { Bot, Check, CircleStop, Clock, Loader2, XCircle, AlertTriangle, Square } from 'lucide-react';
import { requestDispatchCancel } from '@/core/agent/dispatchCancel';
import { cn } from '@/lib/utils';
import { useI18n, format, type TranslationDict } from '@/i18n';
import { useBatchProgress, type BatchTaskProgress } from '@/stores/batchProgressStore';
import { TaskStepItem, convertExecutionStep, type UnifiedStep } from '@/components/chat/TaskBlock';
import { toUnifiedBatchStep } from '@/components/chat/batchTaskStepAdapter';
import { batchRowStatusLabel, rowsFromPersistedSummary, type BatchTaskRow } from '@/components/chat/batchProgressViewModel';
import { snapshotToExecutionSteps } from '@/core/agent/executionSnapshot';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import type { ExecutionStep, TaskExecution } from '@/types/execution';
import { useChatStore } from '@/stores/chatStore';
import type { BatchIdentity, Message } from '@/types';

interface SubagentTabProps {
  identity: BatchIdentity;
  taskIndex: number;
  title: string;
}

function taskElapsed(task: BatchTaskProgress, now: number): number | null {
  if (task.startedAt === undefined) return null;
  return (task.endedAt ?? now) - task.startedAt;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function statusLabel(status: BatchTaskProgress['status'], t: TranslationDict): string {
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
  }
}

function StatusIcon({ status }: { status: BatchTaskProgress['status'] }) {
  if (status === 'queued') {
    return <Clock aria-hidden="true" className="w-4 h-4 text-[var(--abu-text-muted)]" strokeWidth={1.5} />;
  }
  if (status === 'running') {
    return <Loader2 aria-hidden="true" className="w-4 h-4 motion-safe:animate-spin text-[var(--abu-clay)]" strokeWidth={1.5} />;
  }
  if (status === 'succeeded') {
    return <Check aria-hidden="true" className="w-4 h-4 text-[var(--abu-success)]" strokeWidth={1.5} />;
  }
  if (status === 'stopped') {
    return <CircleStop aria-hidden="true" className="w-4 h-4 text-[var(--abu-text-muted)]" strokeWidth={1.5} />;
  }
  if (status === 'incomplete') {
    return <AlertTriangle aria-hidden="true" className="w-4 h-4 text-[var(--abu-warning)]" strokeWidth={1.5} />;
  }
  return <XCircle aria-hidden="true" className="w-4 h-4 text-[var(--abu-danger)]" strokeWidth={1.5} />;
}

function totalTokens(task: BatchTaskProgress): number | null {
  const usage = task.tokenUsage;
  if (!usage) return null;
  return usage.inputTokens + usage.outputTokens + (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
}

interface PersistedBatchTask {
  steps: UnifiedStep[];
  row: BatchTaskRow | undefined;
  /** Live (still-running) source: the process is being recorded right now. */
  liveStatus?: ExecutionStep['status'];
}

/** Children of a dispatch step that belong to `taskIndex`: batch children carry a
 *  batchTask tag; a delegate_to_agent step's children all belong to task 0. */
function childrenForTask(children: readonly ExecutionStep[], taskIndex: number): ExecutionStep[] {
  const tagged = children.some((child) => child.batchTask !== undefined);
  return tagged ? children.filter((child) => child.batchTask?.index === taskIndex) : (taskIndex === 0 ? [...children] : []);
}

/** Live fallback for dispatches without a batch-store entry (serial delegate_to_agent). */
function findLiveDispatch(
  executions: Record<string, TaskExecution>,
  identity: BatchIdentity,
  taskIndex: number,
  locale: string,
): PersistedBatchTask | null {
  for (const exec of Object.values(executions)) {
    if (exec.conversationId !== identity.conversationId) continue;
    const step = exec.steps.find((candidate) => candidate.toolCallId === identity.batchToolCallId);
    if (!step) continue;
    return {
      steps: childrenForTask(step.childSteps ?? [], taskIndex).map((child) => convertExecutionStep(child, locale)),
      row: undefined,
      liveStatus: step.status,
    };
  }
  return null;
}

/**
 * After the live batch store is gone (app restart, conversation reopened, TTL
 * eviction) the member's process is read back from the owning assistant
 * message: the run_agent_batch step's children tagged with this task index.
 */
function findPersistedBatchTask(
  messages: readonly Message[] | undefined,
  identity: BatchIdentity,
  taskIndex: number,
  locale: string,
  t: TranslationDict,
): PersistedBatchTask | null {
  if (!messages) return null;
  const candidates = identity.assistantMessageId
    ? messages.filter((m) => m.id === identity.assistantMessageId)
    : messages.filter((m) => m.role === 'assistant');
  for (const message of candidates) {
    const batchStep = message.executionSteps?.find((step) => step.toolCallId === identity.batchToolCallId);
    if (!batchStep) continue;
    const children = childrenForTask(snapshotToExecutionSteps(batchStep.childSteps ?? []), taskIndex);
    const toolCall = message.toolCalls?.find((call) => call.id === identity.batchToolCallId);
    const row = toolCall ? rowsFromPersistedSummary(identity, toolCall, t)?.[taskIndex] : undefined;
    return { steps: children.map((child) => convertExecutionStep(child, locale)), row };
  }
  return null;
}

function PersistedTaskView({ title, persisted, locale, t, dispatchKey }: { title: string; persisted: PersistedBatchTask; locale: string; t: TranslationDict; dispatchKey?: string }) {
  const { steps, row, liveStatus } = persisted;
  // One backward pass instead of a slice+some per row.
  const laterTool: boolean[] = new Array(steps.length).fill(false);
  for (let i = steps.length - 2, seen = false; i >= 0; i--) {
    seen = seen || steps[i + 1].type !== 'thinking';
    laterTool[i] = seen;
  }
  const rowStatus = row?.status ?? (liveStatus === 'running' ? 'running' : liveStatus === 'error' ? 'failed' : liveStatus === 'completed' ? 'succeeded' : undefined);
  const statusText = rowStatus && rowStatus !== 'unknown' ? batchRowStatusLabel(rowStatus, t) : null;
  // Persisted rows are terminal; a stale live status maps to the warning icon.
  const iconStatus: BatchTaskProgress['status'] | null = !rowStatus || rowStatus === 'unknown'
    ? null
    : rowStatus === 'queued' ? 'incomplete' : rowStatus;
  return (
    <div className="h-full overflow-auto p-5">
      <div className="mx-auto max-w-4xl">
        <header className="mb-4 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] p-4">
          <div className="flex items-center gap-2 text-body font-medium text-[var(--abu-text-primary)]">
            <Bot aria-hidden="true" className="w-4 h-4 shrink-0" strokeWidth={1.5} />
            <span className="truncate">{title || row?.label || t.workspace.agentTitle}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-caption text-[var(--abu-text-muted)]">
            {statusText && iconStatus && (
              <span className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 bg-[var(--abu-bg-base)]',
                iconStatus === 'failed' && 'text-[var(--abu-danger)]',
              )}>
                <StatusIcon status={iconStatus} />
                {statusText}
              </span>
            )}
            <span>{format(t.workspace.agentTools, { count: steps.length })}</span>
            <span>{liveStatus === 'running' ? t.workspace.teamLiveProcess : t.workspace.agentPersistedProcess}</span>
            {liveStatus === 'running' && dispatchKey && (
              <button
                type="button"
                onClick={() => requestDispatchCancel(dispatchKey)}
                aria-label={format(t.workspace.teamStopDispatch, { member: title })}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--abu-border-subtle)] px-2 py-0.5 text-caption text-[var(--abu-text-muted)] hover:bg-[var(--abu-danger-bg)] hover:text-[var(--abu-danger)]"
              >
                <Square aria-hidden="true" className="h-3 w-3" />
                {t.workspace.teamStopDispatchShort}
              </button>
            )}
          </div>
        </header>
        {steps.length === 0 ? (
          <p className="text-minor text-[var(--abu-text-muted)]">{t.workspace.agentNoSteps}</p>
        ) : (
          <div data-testid="subagent-persisted-steps">
            {steps.map((step, index) => (
              <TaskStepItem
                key={step.id}
                step={step}
                showConnector={index < steps.length - 1}
                hasLaterToolStep={laterTool[index]}
                locale={locale}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function SubagentTab({ identity, taskIndex, title }: SubagentTabProps) {
  const { t, locale } = useI18n();
  const batch = useBatchProgress(identity);
  const task = batch?.tasks[taskIndex];
  const isLive = task?.status === 'running' || task?.status === 'queued';
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isLive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isLive]);

  const steps = useMemo(
    () => task?.steps.map((step) => ({ raw: step, unified: toUnifiedBatchStep(step, locale) })) ?? [],
    [task?.steps, locale],
  );
  const persistedMessages = useChatStore((s) => s.conversations[identity.conversationId]?.messages);
  const liveExecutions = useTaskExecutionStore((s) => s.executions);
  const persisted = useMemo(
    () => (batch && task
      ? null
      : findLiveDispatch(liveExecutions, identity, taskIndex, locale) ?? findPersistedBatchTask(persistedMessages, identity, taskIndex, locale, t)),
    [batch, task, liveExecutions, persistedMessages, identity, taskIndex, locale, t],
  );

  if (persisted) {
    return <PersistedTaskView title={title} persisted={persisted} locale={locale} t={t} dispatchKey={`${identity.batchToolCallId}:${taskIndex}`} />;
  }

  if (!batch || !task) {
    return (
      <div className="h-full overflow-auto p-5">
        <div className="max-w-3xl rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] p-4">
          <div className="flex items-center gap-2 text-body text-[var(--abu-text-primary)]">
            <Bot aria-hidden="true" className="w-4 h-4" strokeWidth={1.5} />
            {title || t.workspace.agentTitle}
          </div>
          <p className="mt-2 text-minor text-[var(--abu-text-muted)]">
            {t.workspace.agentFullProcessUnavailable}
          </p>
        </div>
      </div>
    );
  }

  const elapsed = taskElapsed(task, now);
  const tokens = totalTokens(task);
  const statusAnnouncement = [
    statusLabel(task.status, t),
    format(t.workspace.agentTools, { count: task.toolCallCount }),
    tokens !== null ? format(t.workspace.agentTokens, { count: tokens }) : null,
    task.activity ?? null,
  ].filter((part): part is string => !!part).join(' · ');

  return (
    <div className="h-full overflow-auto p-5">
      <div className="mx-auto max-w-4xl">
        <header className="mb-4 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] p-4">
          <div className="flex items-center gap-2 text-body font-medium text-[var(--abu-text-primary)]">
            <Bot aria-hidden="true" className="w-4 h-4 shrink-0" strokeWidth={1.5} />
            <span className="truncate">{title || task.label || t.workspace.agentTitle}</span>
          </div>
          <div role="status" aria-live="polite" className="sr-only">
            {statusAnnouncement}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-caption text-[var(--abu-text-muted)]">
            <span className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 bg-[var(--abu-bg-base)]',
              task.status === 'failed' && 'text-[var(--abu-danger)]',
            )}>
              <StatusIcon status={task.status} />
              {statusLabel(task.status, t)}
            </span>
            <span>{format(t.workspace.agentTools, { count: task.toolCallCount })}</span>
            {tokens !== null && <span>{format(t.workspace.agentTokens, { count: tokens })}</span>}
            {elapsed !== null && <span>{formatElapsed(elapsed)}</span>}
            {task.activity && <span>{task.activity}</span>}
          </div>
        </header>

        {steps.length === 0 ? (
          <p className="text-minor text-[var(--abu-text-muted)]">{t.workspace.agentNoSteps}</p>
        ) : (
          <div className="space-y-0">
            {steps.map(({ raw, unified }, index) => {
              const hasLaterToolStep = steps.slice(index + 1).some(({ unified: later }) => later.type !== 'thinking');
              return (
                <div key={raw.id}>
                  <TaskStepItem
                    step={unified}
                    showConnector={index < steps.length - 1}
                    hasLaterToolStep={hasLaterToolStep}
                    locale={locale}
                    t={t}
                  />
                  {raw.richContentState === 'released' && (
                    <div className="ml-6 -mt-2 mb-3 rounded-md border border-dashed border-[var(--abu-border)] bg-[var(--abu-bg-muted)] px-3 py-2 text-caption text-[var(--abu-text-muted)]">
                      {t.workspace.agentRichContentReleased}
                    </div>
                  )}
                  {raw.richContentState === 'partially-retained' && (
                    <div className="ml-6 -mt-2 mb-3 rounded-md border border-dashed border-[var(--abu-border)] bg-[var(--abu-bg-muted)] px-3 py-2 text-caption text-[var(--abu-text-muted)]">
                      {t.workspace.agentRichContentPartiallyRetained}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
