import { useEffect, useMemo, useState } from 'react';
import { Bot, Check, CircleStop, Clock, Loader2, XCircle, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n, format, type TranslationDict } from '@/i18n';
import { useBatchProgress, type BatchTaskProgress } from '@/stores/batchProgressStore';
import { TaskStepItem } from '@/components/chat/TaskBlock';
import { toUnifiedBatchStep } from '@/components/chat/batchTaskStepAdapter';
import type { BatchIdentity } from '@/types';

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
  }
}

function StatusIcon({ status }: { status: BatchTaskProgress['status'] }) {
  if (status === 'queued') {
    return <Clock aria-hidden="true" className="w-4 h-4 text-[var(--abu-text-muted)]" strokeWidth={1.5} />;
  }
  if (status === 'running' || status === 'cancelling') {
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

export default function SubagentTab({ identity, taskIndex, title }: SubagentTabProps) {
  const { t, locale } = useI18n();
  const batch = useBatchProgress(identity);
  const task = batch?.tasks[taskIndex];
  const isLive = task?.status === 'running' || task?.status === 'cancelling' || task?.status === 'queued';
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
