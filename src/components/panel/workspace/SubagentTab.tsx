import { useEffect, useMemo, useState } from 'react';
import { Bot, Check, CircleStop, Clock, Loader2, XCircle, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n, format, type TranslationDict } from '@/i18n';
import { useBatchProgress, type BatchTaskProgress } from '@/stores/batchProgressStore';
import { TaskStepItem, convertExecutionStep, type UnifiedStep } from '@/components/chat/TaskBlock';
import { toUnifiedBatchStep } from '@/components/chat/batchTaskStepAdapter';
import { batchRowStatusLabel, rowsFromPersistedSummary, type BatchTaskRow } from '@/components/chat/batchProgressViewModel';
import { snapshotToExecutionSteps } from '@/core/agent/executionSnapshot';
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
    const children = snapshotToExecutionSteps(batchStep.childSteps ?? [])
      .filter((child) => child.batchTask?.index === taskIndex);
    const toolCall = message.toolCalls?.find((call) => call.id === identity.batchToolCallId);
    const row = toolCall ? rowsFromPersistedSummary(identity, toolCall, t)?.[taskIndex] : undefined;
    return { steps: children.map((child) => convertExecutionStep(child, locale)), row };
  }
  return null;
}

function PersistedTaskView({ title, persisted, locale, t }: { title: string; persisted: PersistedBatchTask; locale: string; t: TranslationDict }) {
  const { steps, row } = persisted;
  const rowStatus = row?.status;
  const statusText = rowStatus && rowStatus !== 'unknown' ? batchRowStatusLabel(rowStatus, t) : null;
  // Persisted rows are terminal; a stale live status maps to the warning icon.
  const iconStatus: BatchTaskProgress['status'] | null = !rowStatus || rowStatus === 'unknown'
    ? null
    : rowStatus === 'running' || rowStatus === 'queued' ? 'incomplete' : rowStatus;
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
            <span>{t.workspace.agentPersistedProcess}</span>
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
                hasLaterToolStep={steps.slice(index + 1).some((s) => s.type !== 'thinking')}
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
  const persisted = useMemo(
    () => (batch && task ? null : findPersistedBatchTask(persistedMessages, identity, taskIndex, locale, t)),
    [batch, task, persistedMessages, identity, taskIndex, locale, t],
  );

  if (persisted) {
    return <PersistedTaskView title={title} persisted={persisted} locale={locale} t={t} />;
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
