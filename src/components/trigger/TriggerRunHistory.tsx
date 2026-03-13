import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TriggerRun } from '@/types/trigger';
import type { TranslationDict } from '@/i18n/types';

function formatTimeAgo(timestamp: number, t: TranslationDict['trigger']): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return t.timeJustNow;
  if (minutes < 60) return t.timeMinutes.replace('{n}', String(minutes));
  if (hours < 24) return t.timeHours.replace('{n}', String(hours));
  return t.timeDays.replace('{n}', String(days));
}

interface Props {
  runs: TriggerRun[];
}

export default function TriggerRunHistory({ runs }: Props) {
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
      <div className="px-4 py-3 text-[12px] text-[#656358]">
        {t.trigger.noRuns}
      </div>
    );
  }

  return (
    <div className="space-y-1 px-2 pb-2">
      {runs.map((run) => (
        <div
          key={run.id}
          className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[#f5f3ee] transition-colors"
        >
          {/* Status dot */}
          <span
            className={cn(
              'w-1.5 h-1.5 rounded-full shrink-0',
              run.status === 'running' && 'bg-amber-400 animate-pulse',
              run.status === 'completed' && 'bg-green-500',
              run.status === 'error' && 'bg-red-500',
              run.status === 'filtered' && 'bg-neutral-300',
              run.status === 'debounced' && 'bg-neutral-300'
            )}
          />

          {/* Time */}
          <span className="text-[11px] text-[#656358] shrink-0">
            {formatTimeAgo(run.startedAt, t.trigger)}
          </span>

          {/* Status text */}
          <span
            className={cn(
              'text-[11px] flex-1 truncate',
              run.status === 'running' && 'text-amber-600',
              run.status === 'completed' && 'text-green-600',
              run.status === 'error' && 'text-red-500',
              (run.status === 'filtered' || run.status === 'debounced') && 'text-neutral-400'
            )}
          >
            {run.status === 'running' && t.trigger.runStatusRunning}
            {run.status === 'completed' && t.trigger.runStatusCompleted}
            {run.status === 'error' && (run.error ? run.error.slice(0, 30) : t.trigger.runStatusError)}
            {run.status === 'filtered' && t.trigger.runStatusFiltered}
            {run.status === 'debounced' && t.trigger.runStatusDebounced}
          </span>

          {/* Output push status */}
          {run.outputStatus === 'sent' && (
            <span className="text-[10px] text-green-500 shrink-0">{t.trigger.outputSent}</span>
          )}
          {run.outputStatus === 'failed' && (
            <span
              className="text-[10px] text-red-500 shrink-0 cursor-help"
              title={run.outputError}
            >
              {t.trigger.outputFailed}
            </span>
          )}

          {/* View conversation button */}
          {run.conversationId && conversations[run.conversationId] ? (
            <button
              onClick={() => handleViewConversation(run.conversationId)}
              className="text-[#656358] hover:text-[#d97757] p-0.5 shrink-0"
              title={t.trigger.viewConversation}
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          ) : run.conversationId && run.status !== 'filtered' && run.status !== 'debounced' ? (
            <span
              className="text-neutral-300 p-0.5 shrink-0"
              title={t.trigger.conversationDeleted}
            >
              <ExternalLink className="h-3 w-3" />
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
