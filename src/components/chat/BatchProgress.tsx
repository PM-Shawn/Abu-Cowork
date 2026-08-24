import { useState, useEffect, useMemo, useRef } from 'react';
import { Loader2, Check, X, Clock, ChevronRight, X as CloseIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  BATCH_PROGRESS_COMPLETED_TTL_MS,
  BATCH_PROGRESS_UNMOUNT_GRACE_MS,
  useBatchProgress,
  useBatchProgressStore,
  type BatchTaskProgress,
  type BatchTaskStep,
} from '@/stores/batchProgressStore';
import { useChatStore, useActiveConversation } from '@/stores/chatStore';
import { Button } from '@/components/ui/button';
import { useI18n, format } from '@/i18n';
import { getToolLabel } from '@/utils/toolLabels';
import { TaskStepItem, type UnifiedStep } from './TaskBlock';
import type { DetailBlock } from '@/types/execution';

/** Format elapsed milliseconds as mm:ss */
function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function taskElapsed(task: BatchTaskProgress, now: number): number | null {
  if (task.startedAt === undefined) return null;
  return (task.endedAt ?? now) - task.startedAt;
}

function toUnifiedBatchStep(step: BatchTaskStep, locale: string): UnifiedStep {
  const image = step.resultContent?.find((block) => block.type === 'image');
  const detailBlocks: DetailBlock[] | undefined = image?.type === 'image'
    ? [{
      id: `${step.id}-image`,
      stepId: step.id,
      type: 'image',
      // DetailBlockView resolves this semantic key at render time.
      label: '',
      labelKey: 'image',
      content: step.result ?? '',
      imageData: { mediaType: image.source.media_type, base64: image.source.data },
      isTruncated: false,
      isExpanded: true,
    }]
    : undefined;

  return {
    id: step.id,
    type: 'tool',
    label: getToolLabel(step.toolName, step.toolInput, locale).label,
    status: step.status,
    duration: step.endTime === undefined ? undefined : (step.endTime - step.startTime) / 1000,
    toolName: step.toolName,
    toolInput: step.toolInput,
    toolResult: step.result,
    detailBlocks,
    // An image block must not suppress the existing input/result renderer.
    showLegacyDetailsWithDetailBlocks: detailBlocks !== undefined,
  };
}

interface BatchProgressProps {
  toolCallId: string;
}

export default function BatchProgress({ toolCallId }: BatchProgressProps) {
  const { t, locale } = useI18n();
  const batch = useBatchProgress(toolCallId);
  const activeConv = useActiveConversation();
  const [elapsed, setElapsed] = useState(0);
  const [openTaskIndex, setOpenTaskIndex] = useState<number | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const isAnyRunning = batch?.tasks.some((task) => task.status === 'queued' || task.status === 'running') ?? false;
  const allTasksTerminal = batch !== undefined && !isAnyRunning;

  // Tick elapsed timer while any task is still running.
  useEffect(() => {
    if (!batch) return;
    const startedAt = batch.startedAt;
    setElapsed(Date.now() - startedAt);
    if (!isAnyRunning) return;
    const interval = setInterval(() => {
      setElapsed(Date.now() - startedAt);
    }, 1000);
    return () => clearInterval(interval);
  }, [batch, isAnyRunning]);

  // Do not delete synchronously in cleanup: React StrictMode intentionally
  // mount-cleans-remounts effects in development. The remount replaces this
  // grace timer; a real unmount eventually releases the in-memory screenshot.
  useEffect(() => {
    const store = useBatchProgressStore.getState();
    if (allTasksTerminal) {
      store.scheduleClearBatch(toolCallId, BATCH_PROGRESS_COMPLETED_TTL_MS);
    } else {
      store.cancelScheduledClear(toolCallId);
    }
    return () => {
      useBatchProgressStore.getState().scheduleClearBatch(
        toolCallId,
        allTasksTerminal ? BATCH_PROGRESS_COMPLETED_TTL_MS : BATCH_PROGRESS_UNMOUNT_GRACE_MS,
      );
    };
  }, [toolCallId, allTasksTerminal]);

  const openTask = openTaskIndex === null ? undefined : batch?.tasks[openTaskIndex];
  const isDrawerOpen = openTask !== undefined;
  const openSteps = useMemo(
    () => openTask?.steps.map((step) => toUnifiedBatchStep(step, locale)) ?? [],
    [openTask, locale],
  );

  useEffect(() => {
    if (!isDrawerOpen) return;
    const previousFocus = previousFocusRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpenTaskIndex(null);
        return;
      }
      if (event.key !== 'Tab') return;

      const drawer = drawerRef.current;
      if (!drawer) return;
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        drawer.focus();
        return;
      }

      const activeElement = document.activeElement;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (activeElement === drawer) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    drawerRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [isDrawerOpen]);

  if (!batch) return null;

  const handleStop = () => {
    if (activeConv?.id) {
      useChatStore.getState().cancelStreaming(activeConv.id);
    }
  };

  const totalCount = batch.tasks.length;
  const failedCount = batch.tasks.filter((task) => task.status === 'error').length;
  const completedCount = batch.tasks.filter((task) => task.status === 'done').length;
  const now = batch.startedAt + elapsed;

  return (
    <div className="my-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--abu-border-subtle)]">
        {isAnyRunning && <Loader2 className="h-3.5 w-3.5 text-[var(--abu-clay)] animate-spin shrink-0" />}
        <span className="text-minor font-medium text-[var(--abu-text-primary)] flex-1 min-w-0">
          {allTasksTerminal
            ? failedCount > 0
              ? format(t.batch.completionWithErrors, { done: completedCount, failed: failedCount })
              : format(t.batch.completionSummary, { n: totalCount })
            : format(t.batch.runningTitle, { n: totalCount })}
        </span>
        <span className="text-caption text-[var(--abu-text-muted)] font-mono shrink-0">
          {formatElapsed(elapsed)}
        </span>
        {isAnyRunning && (
          <Button
            size="xs"
            variant="ghost"
            onClick={handleStop}
            className="h-5 px-2 text-caption text-[var(--abu-text-muted)] hover:text-[var(--abu-danger)] shrink-0"
          >
            {t.batch.stopButton}
          </Button>
        )}
      </div>

      <div className="divide-y divide-[var(--abu-border-subtle)]">
        {batch.tasks.map((task, idx) => {
          const elapsedForTask = taskElapsed(task, now);
          const tokenTotal = task.tokenUsage
            ? task.tokenUsage.inputTokens + task.tokenUsage.outputTokens
            : undefined;
          return (
            <button
              key={idx}
              type="button"
              onClick={(event) => {
                previousFocusRef.current = event.currentTarget;
                setOpenTaskIndex(idx);
              }}
              aria-haspopup="dialog"
              aria-expanded={openTaskIndex === idx}
              className="w-full flex items-start gap-2 px-3 py-1.5 text-left hover:bg-[var(--abu-bg-hover)] transition-colors"
            >
              <div className="mt-0.5 shrink-0">
                {task.status === 'queued' && <Clock className="h-3 w-3 text-[var(--abu-text-muted)]" />}
                {task.status === 'running' && <Loader2 className="h-3 w-3 text-[var(--abu-clay)] animate-spin" />}
                {task.status === 'done' && <Check className="h-3 w-3 text-[var(--abu-success)]" />}
                {task.status === 'error' && <X className="h-3 w-3 text-[var(--abu-danger)]" />}
              </div>
              <div className="flex-1 min-w-0">
                <span className={cn(
                  'text-caption truncate block',
                  task.status === 'running' ? 'text-[var(--abu-text-primary)]' : 'text-[var(--abu-text-muted)]',
                  task.status === 'done' && 'line-through opacity-60',
                  task.status === 'error' && 'text-[var(--abu-danger)]',
                )}>
                  {task.label}
                </span>
                <span className="text-caption text-[var(--abu-text-tertiary)] font-mono flex flex-wrap gap-x-1.5">
                  {task.lastToolName && <span>{task.lastToolName}</span>}
                  <span>{format(t.batch.toolCount, { n: task.toolCallCount })}</span>
                  {elapsedForTask !== null && <span>{formatElapsed(elapsedForTask)}</span>}
                  {tokenTotal !== undefined && <span>{format(t.batch.tokenCount, { n: tokenTotal })}</span>}
                  {task.status === 'running' && task.turn !== undefined && task.turn > 0 && (
                    <span>{format(t.batch.turnLabel, { n: task.turn })}</span>
                  )}
                </span>
              </div>
              <ChevronRight className="h-3.5 w-3.5 mt-0.5 shrink-0 text-[var(--abu-text-muted)]" />
            </button>
          );
        })}
      </div>

      {openTask && (
        <>
          <button
            type="button"
            data-electron-no-drag
            aria-label={t.batch.collapse}
            onClick={() => setOpenTaskIndex(null)}
            className="fixed inset-0 z-30 bg-black/30 cursor-default"
          />
          <aside
            ref={drawerRef}
            data-electron-no-drag
            role="dialog"
            aria-modal="true"
            aria-label={openTask.label}
            tabIndex={-1}
            className="fixed inset-y-0 right-0 z-40 w-full max-w-xl overflow-y-auto border-l border-[var(--abu-border-subtle)] bg-[var(--abu-bg-base)] shadow-2xl"
          >
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--abu-border-subtle)] bg-[var(--abu-bg-base)] px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-h-xs text-[var(--abu-text-primary)] truncate">{openTask.label}</div>
                <div className="text-caption text-[var(--abu-text-muted)]">
                  {format(t.batch.toolCount, { n: openTask.toolCallCount })}
                </div>
              </div>
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={() => setOpenTaskIndex(null)}
                aria-label={t.batch.collapse}
              >
                <CloseIcon className="h-4 w-4" />
              </Button>
            </div>
            <div className="flow-timeline p-4">
              {openSteps.map((step, index) => (
                <TaskStepItem
                  key={step.id}
                  step={step}
                  showConnector={index < openSteps.length - 1}
                  hasLaterToolStep={false}
                  locale={locale}
                  t={t}
                />
              ))}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
