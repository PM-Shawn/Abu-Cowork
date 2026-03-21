import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ScheduledTaskRun } from '@/types/schedule';

function formatTimeAgo(timestamp: number, agoTemplate: string): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  let time: string;
  if (minutes < 1) time = '<1m';
  else if (minutes < 60) time = `${minutes}m`;
  else if (hours < 24) time = `${hours}h`;
  else time = `${days}d`;

  return agoTemplate.replace('{time}', time);
}

interface Props {
  runs: ScheduledTaskRun[];
}

export default function ScheduleRunHistory({ runs }: Props) {
  const { t } = useI18n();
  const switchConversation = useChatStore((s) => s.switchConversation);
  const setViewMode = useSettingsStore((s) => s.setViewMode);
  const conversations = useChatStore((s) => s.conversations);

  const handleViewConversation = (conversationId: string) => {
    if (conversations[conversationId]) {
      switchConversation(conversationId);
      setViewMode('chat');
    }
  };

  if (runs.length === 0) {
    return (
      <div className="px-4 py-3 text-[12px] text-[var(--abu-text-tertiary)]">
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
              run.status === 'running' && 'bg-amber-400 animate-pulse',
              run.status === 'completed' && 'bg-green-500',
              run.status === 'error' && 'bg-red-500'
            )}
          />

          {/* Time */}
          <span className="text-[11px] text-[var(--abu-text-tertiary)] shrink-0">
            {formatTimeAgo(run.startedAt, t.schedule.ago)}
          </span>

          {/* Status text */}
          <span
            className={cn(
              'text-[11px] flex-1 truncate',
              run.status === 'running' && 'text-amber-600',
              run.status === 'completed' && 'text-green-600',
              run.status === 'error' && 'text-red-500'
            )}
          >
            {run.status === 'running' && t.schedule.runStatusRunning}
            {run.status === 'completed' && t.schedule.runStatusCompleted}
            {run.status === 'error' && (run.error ? run.error.slice(0, 30) : t.schedule.runStatusError)}
          </span>

          {/* View conversation button */}
          {conversations[run.conversationId] && (
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
