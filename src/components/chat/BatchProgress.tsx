import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { useBatchProgress } from '@/stores/batchProgressStore';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useI18n, format, type TranslationDict } from '@/i18n';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import type { BatchIdentity, ToolCall } from '@/types';
import { getToolLabel } from '@/utils/toolLabels';
import {
  batchRowStatusLabel,
  compactBatchRollupSummary,
  isLiveRowStatus,
  rollupBatchRows,
  rowsFromLiveBatch,
  rowsFromLegacyResult,
  rowsFromPersistedSummary,
  rowsFromUnknown,
  type BatchTaskRow,
  type BatchRowStatus,
} from './batchProgressViewModel';

interface BatchProgressProps {
  identity: BatchIdentity;
  toolCall: ToolCall;
}

// The card is one place: its header holds the only spinner, so a running row
// shows the same loading icon standing still.
function RowStatusIcon({ status }: { status: BatchRowStatus }) {
  if (status === 'queued' || status === 'unknown') {
    return <Icon icon={AppIcons.clock} size="sm" className="text-label-tertiary" />;
  }
  if (status === 'running') {
    return <Icon icon={AppIcons.loading} size="sm" className="text-label-tertiary" />;
  }
  if (status === 'succeeded') {
    return <StatusIcon tone="success" size="sm" />;
  }
  if (status === 'stopped') {
    return <Icon icon={AppIcons.stopped} size="sm" className="text-label-tertiary" />;
  }
  if (status === 'incomplete') {
    return <StatusIcon tone="warning" size="sm" />;
  }
  return <StatusIcon tone="danger" size="sm" />;
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
    return rowsFromPersistedSummary(identity, toolCall, t)
      ?? rowsFromLegacyResult(toolCall, t)
      ?? (toolCall.isExecuting ? rowsFromUnknown(toolCall, t) : undefined);
  }, [batch, identity, toolCall, t, now]);
  const isAnyRunning = batch !== undefined && (rows?.some((row) => isLiveRowStatus(row.status)) ?? false);

  if (!rows) return null;

  return (
    <section className="my-2 overflow-hidden rounded-panel border border-separator bg-surface">
      <header className="flex items-center gap-2 border-b border-separator px-3 py-2">
        {isAnyRunning && <Spinner size="sm" labelHidden label={t.task.running} />}
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="min-w-0 flex-1 text-ui font-medium text-label"
        >
          {summaryLabel(rows, t)}
        </span>
        {isAnyRunning && (
          <Button
            size="sm"
            variant="plain"
            onClick={(event) => {
              event.stopPropagation();
              useChatStore.getState().cancelStreaming(identity.conversationId);
            }}
          >
            {t.batch.stopButton}
          </Button>
        )}
      </header>

      <div className="divide-y divide-separator">
        {rows.map((row) => {
          const lastToolLabel = row.lastToolName
            ? getToolLabel(row.lastToolName, {}, locale).label
            : undefined;
          return (
            <Pressable
              key={row.taskIndex}
              onClick={() => openSubagent(identity, row.taskIndex, row.label)}
              className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors duration-fast hover:bg-fill-hover"
              aria-label={format(t.batch.openTaskLabel, { label: row.label, status: batchRowStatusLabel(row.status, t) })}
            >
              <span className="flex h-lh shrink-0 items-center text-ui"><RowStatusIcon status={row.status} /></span>
              <span className="min-w-0 flex-1">
                <span className={cn(
                  'block truncate text-ui',
                  row.status === 'running' ? 'text-label' : 'text-label-secondary',
                  row.status === 'failed' && 'text-danger',
                )}>
                  {row.label}
                </span>
                <span className="flex flex-wrap gap-x-2 text-ui-sm text-label-secondary">
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
              <span className="flex h-lh shrink-0 items-center text-ui">
                <Icon icon={AppIcons.disclose} size="sm" className="text-label-tertiary" />
              </span>
            </Pressable>
          );
        })}
      </div>
    </section>
  );
}
