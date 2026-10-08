import { useEffect, useMemo, useState } from 'react';
import { requestDispatchCancel } from '@/core/agent/dispatchCancel';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Spinner } from '@/components/ds/spinner';
import { Tag } from '@/components/ds/tag';
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

// As tall as the Stop button in every state, so the steps below stay put when the spinner
// hands over to a tag and when the button leaves.
const META_ROW = 'mt-2 flex min-h-6 flex-wrap items-center gap-2 text-caption text-label-tertiary';

/**
 * The header's status: the one spinner of the tab while the expert runs, a still tag otherwise.
 * `announcedAbove`: the caller already announces the status in its own live region, so the
 * spinner's word is shown and kept out of the accessibility tree.
 */
function TaskStatusTag({ status, label, announcedAbove = false }: { status: BatchTaskProgress['status']; label: string; announcedAbove?: boolean }) {
  // Inset by a tag's padding less the wider gap, so the word starts where a tag's word starts.
  if (status === 'running') return <span className="flex pl-1" aria-hidden={announcedAbove || undefined}><Spinner size="sm" label={label} /></span>;
  if (status === 'queued') {
    return <Tag><Icon icon={AppIcons.clock} size="sm" />{label}</Tag>;
  }
  if (status === 'stopped') {
    return <Tag><Icon icon={AppIcons.stopped} size="sm" />{label}</Tag>;
  }
  if (status === 'succeeded') return <Tag tone="success">{label}</Tag>;
  if (status === 'incomplete') return <Tag tone="warning">{label}</Tag>;
  return <Tag tone="danger">{label}</Tag>;
}

function totalTokens(task: BatchTaskProgress): number | null {
  const usage = task.tokenUsage;
  if (!usage) return null;
  return usage.inputTokens + usage.outputTokens;
}

interface PersistedBatchTask {
  steps: UnifiedStep[];
  row: BatchTaskRow | undefined;
  /** Live (still-running) source: the process is being recorded right now. */
  liveStatus?: ExecutionStep['status'];
}

/**
 * A completed live execution can be evicted from the execution store before
 * its final child-step snapshot reaches the same render. Prefer whichever
 * source has the richer process so a transient empty live view cannot hide a
 * child step that is already persisted on the assistant message.
 */
function preferRicherDispatch(live: PersistedBatchTask | null, persisted: PersistedBatchTask | null): PersistedBatchTask | null {
  if (!live) return persisted;
  if (!persisted || live.steps.length >= persisted.steps.length) return live;
  return { ...persisted, liveStatus: live.liveStatus ?? persisted.liveStatus };
}

/** Children of a dispatch step that belong to `taskIndex`: batch children carry a
 *  batchTask tag; a delegate_to_agent step's children all belong to task 0. */
function childrenForTask(children: readonly ExecutionStep[], taskIndex: number): ExecutionStep[] {
  const tagged = children.some((child) => child.batchTask !== undefined);
  return tagged ? children.filter((child) => child.batchTask?.index === taskIndex) : (taskIndex === 0 ? [...children] : []);
}

function ownsCall(message: Message, toolCallId: string): boolean {
  return message.role === 'assistant' && !!message.toolCalls?.some((call) => call.id === toolCallId);
}

/**
 * The member's own terminal record. A run_agent_batch call's summary gains a
 * row each time one of its tasks ends, so it is there while the batch still runs.
 */
function terminalRow(message: Message | undefined, identity: BatchIdentity, taskIndex: number, t: TranslationDict): BatchTaskRow | undefined {
  const toolCall = message?.toolCalls?.find((call) => call.id === identity.batchToolCallId);
  return toolCall ? rowsFromPersistedSummary(identity, toolCall, t)?.[taskIndex] : undefined;
}

/** Live fallback for dispatches without a batch-store entry (serial delegate_to_agent). */
function findLiveDispatch(
  executions: Record<string, TaskExecution>,
  messages: readonly Message[] | undefined,
  identity: BatchIdentity,
  taskIndex: number,
  locale: string,
  t: TranslationDict,
): PersistedBatchTask | null {
  for (const exec of Object.values(executions)) {
    if (exec.conversationId !== identity.conversationId) continue;
    const step = exec.steps.find((candidate) => candidate.toolCallId === identity.batchToolCallId);
    if (!step) continue;
    // Provider tool-call ids can repeat across loops, so an unnamed message must belong to this loop.
    const dispatchMessage = messages?.find((m) => ownsCall(m, identity.batchToolCallId)
      && (identity.assistantMessageId ? m.id === identity.assistantMessageId : m.loopId === exec.loopId));
    return {
      steps: childrenForTask(step.childSteps ?? [], taskIndex).map((child) => convertExecutionStep(child, locale)),
      row: terminalRow(dispatchMessage, identity, taskIndex, t),
      liveStatus: step.status,
    };
  }
  return null;
}

/**
 * After the live batch store is gone (app restart, conversation reopened, TTL
 * eviction) the member's process is read back from disk-backed messages: the
 * run_agent_batch step's children tagged with this task index.
 *
 * The two halves live on different messages of the same loop: the tool call
 * (and its terminal summary) on the dispatching assistant message named by
 * `identity.assistantMessageId`, the execution-steps snapshot on the loop's
 * LAST assistant message (persistExecutionSnapshot). Provider tool-call ids
 * can repeat across loops, so the snapshot search stays inside that loop.
 */
function findPersistedBatchTask(
  messages: readonly Message[] | undefined,
  identity: BatchIdentity,
  taskIndex: number,
  locale: string,
  t: TranslationDict,
): PersistedBatchTask | null {
  if (!messages) return null;
  const dispatchMessage = identity.assistantMessageId
    ? messages.find((m) => m.id === identity.assistantMessageId)
    : messages.find((m) => ownsCall(m, identity.batchToolCallId));
  if (identity.assistantMessageId && !dispatchMessage) return null;
  const loopId = dispatchMessage?.loopId;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant' || (loopId !== undefined && message.loopId !== loopId)) continue;
    const batchStep = message.executionSteps?.find((step) => step.toolCallId === identity.batchToolCallId);
    if (!batchStep) continue;
    const children = childrenForTask(snapshotToExecutionSteps(batchStep.childSteps ?? []), taskIndex);
    const row = terminalRow(dispatchMessage ?? message, identity, taskIndex, t);
    return { steps: children.map((child) => convertExecutionStep(child, locale)), row };
  }
  return null;
}

/** Stops this one hand-off; shown only while its member is running. */
function StopDispatchButton({ dispatchKey, member, t }: { dispatchKey: string; member: string; t: TranslationDict }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={AppIcons.stop}
      onClick={() => requestDispatchCancel(dispatchKey)}
      aria-label={format(t.workspace.teamStopDispatch, { member })}
    >
      {t.workspace.teamStopDispatchShort}
    </Button>
  );
}

function PersistedTaskView({ title, persisted, locale, t, dispatchKey }: { title: string; persisted: PersistedBatchTask; locale: string; t: TranslationDict; dispatchKey?: string }) {
  const { steps, row, liveStatus } = persisted;
  // One backward pass instead of a slice+some per row.
  const laterTool: boolean[] = new Array(steps.length).fill(false);
  for (let i = steps.length - 2, seen = false; i >= 0; i--) {
    seen = seen || steps[i + 1].type !== 'thinking';
    laterTool[i] = seen;
  }
  // A batch step's status is the whole batch's, so the member's own terminal record
  // comes first; the step speaks only for a member that has no record yet.
  const rowStatus = row && row.status !== 'unknown'
    ? row.status
    : liveStatus === 'running' ? 'running' : liveStatus === 'error' ? 'failed' : liveStatus === 'completed' ? 'succeeded' : undefined;
  const running = rowStatus === 'running';
  const statusText = rowStatus ? batchRowStatusLabel(rowStatus, t) : null;
  // Persisted rows are terminal; a stale live status maps to the warning icon.
  const iconStatus: BatchTaskProgress['status'] | null = !rowStatus
    ? null
    : rowStatus === 'queued' ? 'incomplete' : rowStatus;
  return (
    <div className="h-full overflow-auto p-5">
      <div className="mx-auto max-w-4xl">
        <header className="mb-4 rounded-panel border border-separator bg-surface p-4">
          <div className="flex items-center gap-2 text-ui font-medium text-label">
            <Icon icon={AppIcons.agent} />
            <span className="truncate">{title || row?.label || t.workspace.agentTitle}</span>
          </div>
          <div className={META_ROW}>
            {statusText && iconStatus && <TaskStatusTag status={iconStatus} label={statusText} />}
            <span>{format(t.workspace.agentTools, { count: steps.length })}</span>
            <span>{running ? t.workspace.teamLiveProcess : t.workspace.agentPersistedProcess}</span>
            {running && dispatchKey && <StopDispatchButton dispatchKey={dispatchKey} member={title} t={t} />}
          </div>
        </header>
        {steps.length === 0 ? (
          <p className="text-ui-sm text-label-tertiary">{t.workspace.agentNoSteps}</p>
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
    () => {
      if (batch && task) return null;
      return preferRicherDispatch(
        findLiveDispatch(liveExecutions, persistedMessages, identity, taskIndex, locale, t),
        findPersistedBatchTask(persistedMessages, identity, taskIndex, locale, t),
      );
    },
    [batch, task, liveExecutions, persistedMessages, identity, taskIndex, locale, t],
  );
  const dispatchKey = `${identity.batchToolCallId}:${taskIndex}`;

  if (persisted) {
    return <PersistedTaskView title={title} persisted={persisted} locale={locale} t={t} dispatchKey={dispatchKey} />;
  }

  if (!batch || !task) {
    return (
      <div className="h-full overflow-auto p-5">
        <div className="max-w-3xl rounded-panel border border-separator bg-surface p-4">
          <div className="flex items-center gap-2 text-ui font-medium text-label">
            <Icon icon={AppIcons.agent} />
            {title || t.workspace.agentTitle}
          </div>
          <p className="mt-2 text-ui-sm text-label-tertiary">
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
        <header className="mb-4 rounded-panel border border-separator bg-surface p-4">
          <div className="flex items-center gap-2 text-ui font-medium text-label">
            <Icon icon={AppIcons.agent} />
            <span className="truncate">{title || task.label || t.workspace.agentTitle}</span>
          </div>
          <div role="status" aria-live="polite" className="sr-only">
            {statusAnnouncement}
          </div>
          <div className={META_ROW}>
            <TaskStatusTag status={task.status} label={statusLabel(task.status, t)} announcedAbove />
            <span>{format(t.workspace.agentTools, { count: task.toolCallCount })}</span>
            {tokens !== null && <span>{format(t.workspace.agentTokens, { count: tokens })}</span>}
            {elapsed !== null && <span>{formatElapsed(elapsed)}</span>}
            {task.activity && <span>{task.activity}</span>}
            {task.status === 'running' && <StopDispatchButton dispatchKey={dispatchKey} member={title || task.label} t={t} />}
          </div>
        </header>

        {steps.length === 0 ? (
          <p className="text-ui-sm text-label-tertiary">{t.workspace.agentNoSteps}</p>
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
                    <div className="ml-6 -mt-2 mb-3 rounded-control border border-dashed border-separator px-3 py-2 text-caption text-label-tertiary">
                      {t.workspace.agentRichContentReleased}
                    </div>
                  )}
                  {raw.richContentState === 'partially-retained' && (
                    <div className="ml-6 -mt-2 mb-3 rounded-control border border-dashed border-separator px-3 py-2 text-caption text-label-tertiary">
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
