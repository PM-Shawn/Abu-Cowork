import { useState, useEffect } from 'react';
import { Loader2, Check, X, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBatchProgress } from '@/stores/batchProgressStore';
import { useChatStore, useActiveConversation } from '@/stores/chatStore';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';

/** Format elapsed milliseconds as mm:ss */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

interface BatchProgressProps {
  toolCallId: string;
}

export default function BatchProgress({ toolCallId }: BatchProgressProps) {
  const { t } = useI18n();
  const batch = useBatchProgress(toolCallId);
  const activeConv = useActiveConversation();
  const [elapsed, setElapsed] = useState(0);

  const isAnyRunning = batch?.tasks.some((task) => task.status === 'queued' || task.status === 'running') ?? false;

  // Tick elapsed timer while any task is still running
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

  if (!batch) return null;

  const handleStop = () => {
    if (activeConv?.id) {
      useChatStore.getState().cancelStreaming(activeConv.id);
    }
  };

  const totalCount = batch.tasks.length;

  return (
    <div className="my-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--abu-border-subtle)]">
        {isAnyRunning && <Loader2 className="h-3.5 w-3.5 text-[var(--abu-clay)] animate-spin shrink-0" />}
        <span className="text-minor font-medium text-[var(--abu-text-primary)] flex-1 min-w-0">
          {t.batch.runningTitle.replace('{n}', String(totalCount))}
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

      {/* Task rows */}
      <div className="divide-y divide-[var(--abu-border-subtle)]">
        {batch.tasks.map((task, idx) => (
          <div key={idx} className="flex items-start gap-2 px-3 py-1.5">
            {/* Status icon */}
            <div className="mt-0.5 shrink-0">
              {task.status === 'queued' && <Clock className="h-3 w-3 text-[var(--abu-text-muted)]" />}
              {task.status === 'running' && <Loader2 className="h-3 w-3 text-[var(--abu-clay)] animate-spin" />}
              {task.status === 'done' && <Check className="h-3 w-3 text-[var(--abu-success)]" />}
              {task.status === 'error' && <X className="h-3 w-3 text-[var(--abu-danger)]" />}
            </div>

            {/* Label + activity */}
            <div className="flex-1 min-w-0">
              <span className={cn(
                'text-caption truncate block',
                task.status === 'running' ? 'text-[var(--abu-text-primary)]' : 'text-[var(--abu-text-muted)]',
                task.status === 'done' && 'line-through opacity-60',
                task.status === 'error' && 'text-[var(--abu-danger)]',
              )}>
                {task.label}
              </span>
              {task.status === 'running' && (task.activity || (task.turn !== undefined && task.turn > 0)) && (
                <span className="text-caption text-[var(--abu-text-tertiary)] font-mono">
                  {task.activity?.trim()}
                  {task.turn !== undefined && task.turn > 0
                    ? ` · ${t.batch.turnLabel.replace('{n}', String(task.turn))}`
                    : ''}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
