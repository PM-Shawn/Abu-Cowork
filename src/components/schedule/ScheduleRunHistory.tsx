import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ScheduledTaskRun } from '@/types/schedule';

function formatDateTime(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface Props {
  runs: ScheduledTaskRun[];
}

export default function ScheduleRunHistory({ runs }: Props) {
  const { t } = useI18n();
  const switchConversation = useChatStore((s) => s.switchConversation);
  const setViewMode = useSettingsStore((s) => s.setViewMode);
  const conversationIndex = useChatStore((s) => s.conversationIndex);

  const handleViewConversation = (conversationId: string) => {
    if (conversationIndex[conversationId]) {
      switchConversation(conversationId);
      setViewMode('chat');
    }
  };

  if (runs.length === 0) {
    return (
      <div className="px-4 py-3 text-minor text-[var(--abu-text-tertiary)]">
        {t.schedule.noRuns}
      </div>
    );
  }

  return (
    <div className="space-y-1 px-2 pb-2">
      {runs.map((run) => (
        <div
          key={run.id}
          className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--abu-bg-muted)] transition-colors"
        >
          {/* Status dot */}
          <span
            className={cn(
              'w-1.5 h-1.5 rounded-full shrink-0',
              run.status === 'running' && 'bg-[var(--abu-warning-solid)] animate-pulse',
              run.status === 'completed' && 'bg-[var(--abu-success-solid)]',
              run.status === 'error' && 'bg-[var(--abu-danger-solid)]'
            )}
          />

          {/* Start / End times + status */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-caption text-[var(--abu-text-secondary)]">
                {t.schedule.startedAtLabel} {formatDateTime(run.startedAt)}
              </span>
              <span
                className={cn(
                  'text-caption',
                  run.status === 'running' && 'text-[var(--abu-warning)]',
                  run.status === 'completed' && 'text-[var(--abu-success)]',
                  run.status === 'error' && 'text-[var(--abu-danger)]'
                )}
              >
                {run.status === 'running' && t.schedule.runStatusRunning}
                {run.status === 'completed' && t.schedule.runStatusCompleted}
                {run.status === 'error' && (run.error ? run.error.slice(0, 30) : t.schedule.runStatusError)}
              </span>
            </div>
            {run.completedAt && (
              <div className="text-caption text-[var(--abu-text-tertiary)]">
                {t.schedule.completedAtLabel} {formatDateTime(run.completedAt)}
              </div>
            )}
          </div>

          {/* View conversation button */}
          {conversationIndex[run.conversationId] && (
            <button
              onClick={() => handleViewConversation(run.conversationId)}
              className="text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)] p-0.5 shrink-0"
              title={t.schedule.viewConversation}
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
