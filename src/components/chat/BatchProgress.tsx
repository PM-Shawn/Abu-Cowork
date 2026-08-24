import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronRight, CircleStop, Clock, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBatchProgress } from '@/stores/batchProgressStore';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useI18n, format, type TranslationDict } from '@/i18n';
import { Button } from '@/components/ui/button';
import type { BatchIdentity, ToolCall } from '@/types';
import { getToolLabel } from '@/utils/toolLabels';
import {
  batchRowStatusLabel,
  compactBatchRollupSummary,
  isLiveRowStatus,
  rollupBatchRows,
  rowsFromLiveBatch,
  rowsFromPersistedSummary,
  rowsFromUnknown,
  type BatchTaskRow,
  type BatchRowStatus,
} from './batchProgressViewModel';

interface BatchProgressProps {
  identity: BatchIdentity;
  toolCall: ToolCall;
}

function StatusIcon({ status }: { status: BatchRowStatus }) {
  if (status === 'queued' || status === 'unknown') {
    return <Clock aria-hidden="true" className="h-3 w-3 text-[var(--abu-text-muted)]" />;
  }
  if (status === 'running') {
    return <Loader2 aria-hidden="true" className="h-3 w-3 text-[var(--abu-clay)] motion-safe:animate-spin" />;
  }
  if (status === 'succeeded') {
    return <Check aria-hidden="true" className="h-3 w-3 text-[var(--abu-success)]" />;
  }
  if (status === 'stopped') {
    return <CircleStop aria-hidden="true" className="h-3 w-3 text-[var(--abu-text-muted)]" />;
  }
  if (status === 'incomplete') {
    return <AlertTriangle aria-hidden="true" className="h-3 w-3 text-[var(--abu-warning)]" />;
  }
  return <X aria-hidden="true" className="h-3 w-3 text-[var(--abu-danger)]" />;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function summaryLabel(rows: BatchTaskRow[], t: TranslationDict): string {
  const counts = rollupBatchRows(rows);
  if (counts.failed > 0 || counts.stopped > 0 || counts.incomplete > 0) {
    return format(t.batch.mixedSummary, {
      summary: compactBatchRollupSummary(counts, t),
    });
  }
  if (counts.running > 0 || counts.queued > 0) {
    return format(t.batch.runningTitle, { n: rows.length });
  }
  if (counts.unknown > 0) {
    return format(t.batch.unknownSummary, { n: rows.length });
  }
  return format(t.batch.completionSummary, { n: rows.length });
}

export default function BatchProgress({
  identity,
  toolCall,
}: BatchProgressProps) {
  const { t, locale } = useI18n();
  const batch = useBatchProgress(identity);
  const openSubagent = usePreviewStore((s) => s.openSubagent);
  const [now, setNow] = useState(() => Date.now());
  const hasLiveTask = batch?.tasks.some((task) => task.status === 'queued' || task.status === 'running') ?? false;
  useEffect(() => {
    if (!hasLiveTask) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasLiveTask]);
  const rows = useMemo(() => {
    if (batch) return rowsFromLiveBatch(batch, now);
    return rowsFromPersistedSummary(identity, toolCall, t) ?? rowsFromUnknown(toolCall, t);
  }, [batch, identity, toolCall, t, now]);
  const isAnyRunning = batch !== undefined && rows.some((row) => isLiveRowStatus(row.status));

  return (
    <section className="my-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--abu-border-subtle)]">
        {isAnyRunning && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 text-[var(--abu-clay)] motion-safe:animate-spin shrink-0" />}
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="text-minor font-medium text-[var(--abu-text-primary)] flex-1 min-w-0"
        >
          {summaryLabel(rows, t)}
        </span>
        {isAnyRunning && (
          <Button
            size="xs"
            variant="ghost"
            onClick={(event) => {
              event.stopPropagation();
              useChatStore.getState().cancelStreaming(identity.conversationId);
            }}
            className="h-5 px-2 text-caption text-[var(--abu-text-muted)] hover:text-[var(--abu-danger)] shrink-0"
          >
            {t.batch.stopButton}
          </Button>
        )}
      </div>

      <div className="divide-y divide-[var(--abu-border-subtle)]">
        {rows.map((row) => {
          const lastToolLabel = row.lastToolName
            ? getToolLabel(row.lastToolName, {}, locale).label
            : undefined;
          return (
            <button
              key={row.taskIndex}
              type="button"
              onClick={() => openSubagent(identity, row.taskIndex, row.label)}
              className="w-full flex items-start gap-2 px-3 py-1.5 text-left hover:bg-[var(--abu-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--abu-focus-ring)] transition-colors"
              aria-label={format(t.batch.openTaskLabel, { label: row.label, status: batchRowStatusLabel(row.status, t) })}
            >
              <span className="mt-0.5 shrink-0"><StatusIcon status={row.status} /></span>
              <span className="flex-1 min-w-0">
                <span className={cn(
                  'text-caption truncate block',
                  row.status === 'running' ? 'text-[var(--abu-text-primary)]' : 'text-[var(--abu-text-muted)]',
                  row.status === 'failed' && 'text-[var(--abu-danger)]',
                )}>
                  {row.label}
                </span>
                <span className="text-caption text-[var(--abu-text-tertiary)] flex flex-wrap gap-x-1.5">
                  <span>{batchRowStatusLabel(row.status, t)}</span>
                  {lastToolLabel && <span>{lastToolLabel}</span>}
                  {row.toolCallCount !== undefined && <span>{format(t.batch.toolCount, { n: row.toolCallCount })}</span>}
                  {row.elapsedMs !== undefined && row.elapsedMs !== null && <span>{formatElapsed(row.elapsedMs)}</span>}
                  {row.tokenTotal !== undefined && <span>{format(t.batch.tokenCount, { n: row.tokenTotal })}</span>}
                  {row.status === 'running' && row.turn !== undefined && row.turn > 0 && (
                    <span>{format(t.batch.turnLabel, { n: row.turn })}</span>
                  )}
                </span>
              </span>
              <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 mt-0.5 shrink-0 text-[var(--abu-text-muted)]" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
