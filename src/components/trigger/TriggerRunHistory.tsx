import { memo, useCallback } from 'react';
import { IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import { Tag } from '@/components/ds/tag';
import { useI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
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

// memo: a row with a conversation holds a tooltip root, and the list reads the chat store's
// index, which changes whenever any conversation does.
const RunRow = memo(function RunRow({ run, canView, onView }: {
  run: TriggerRun;
  // The conversation of this run still exists.
  canView: boolean;
  onView: (conversationId: string) => void;
}) {
  const { t } = useI18n();
  const running = run.status === 'running';
  // The event came in and nothing ran: it matched no rule, or repeated one just handled.
  const skipped = run.status === 'filtered' || run.status === 'debounced';
  return (
    <div data-trigger-run={run.id} className="flex items-center gap-2 rounded-control px-2 py-1 hover:bg-fill-hover">
      {/* The outcome as a shape; only a run in progress turns. */}
      <span className="flex shrink-0 items-center">
        {running && <Spinner size="sm" label={t.trigger.runStatusRunning} labelHidden />}
        {skipped && <Icon icon={AppIcons.notChecked} size="sm" className="text-label-tertiary" />}
        {!running && !skipped && <StatusIcon tone={run.status === 'completed' ? 'success' : 'danger'} size="sm" />}
      </span>

      <span className="shrink-0 text-caption text-label-secondary">
        {formatTimeAgo(run.startedAt, t.trigger)}
      </span>

      {/* The spinner already says "running" to a screen reader. */}
      <span aria-hidden={running || undefined} className="min-w-0 flex-1 truncate text-caption text-label">
        {running && t.trigger.runStatusRunning}
        {run.status === 'completed' && t.trigger.runStatusCompleted}
        {run.status === 'error' && (run.error ? run.error.slice(0, 30) : t.trigger.runStatusError)}
        {run.status === 'filtered' && t.trigger.runStatusFiltered}
        {run.status === 'debounced' && t.trigger.runStatusDebounced}
      </span>

      {/* Whether the result was pushed on. */}
      {run.outputStatus === 'sent' && (
        <span className="flex shrink-0"><Tag tone="success">{t.trigger.outputSent}</Tag></span>
      )}
      {run.outputStatus === 'failed' && (
        <span className="flex shrink-0" title={run.outputError}><Tag tone="danger">{t.trigger.outputFailed}</Tag></span>
      )}

      {canView && (
        <IconButton
          size="sm"
          icon={AppIcons.openExternal}
          label={t.trigger.viewConversation}
          onClick={() => onView(run.conversationId)}
        />
      )}
      {/* The run had a conversation and it was deleted since: the place of the button says so. */}
      {!canView && run.conversationId && !skipped && (
        <span className="flex size-6 shrink-0 items-center justify-center text-label-tertiary" title={t.trigger.conversationDeleted}>
          <Icon icon={AppIcons.openExternal} size="sm" label={t.trigger.conversationDeleted} />
        </span>
      )}
    </div>
  );
});

interface Props {
  runs: TriggerRun[];
}

export default function TriggerRunHistory({ runs }: Props) {
  const { t } = useI18n();
  const conversationIndex = useChatStore((s) => s.conversationIndex);

  // One callback for the life of the list, so a row renders only when its own run changes.
  const viewConversation = useCallback((conversationId: string) => {
    const chat = useChatStore.getState();
    if (!chat.conversationIndex[conversationId]) return;
    chat.switchConversation(conversationId);
    useSettingsStore.getState().setViewMode('chat');
  }, []);

  if (runs.length === 0) {
    return (
      <div className="px-4 py-3 text-ui-sm text-label-tertiary">
        {t.trigger.noRuns}
      </div>
    );
  }

  return (
    <div className="space-y-1 p-2">
      {runs.map((run) => (
        <RunRow
          key={run.id}
          run={run}
          canView={Boolean(run.conversationId && conversationIndex[run.conversationId])}
          onView={viewConversation}
        />
      ))}
    </div>
  );
}
