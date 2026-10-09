import { memo, useCallback } from 'react';
import { focusComposerAfterPageChange } from '@/components/chat/composerFocus';
import { IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import { useI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ScheduledTaskRun } from '@/types/schedule';

function formatDateTime(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// memo: a row with a conversation holds a tooltip root, and the list reads the chat store's
// index, which changes whenever any conversation does.
const RunRow = memo(function RunRow({ run, canView, onView }: {
  run: ScheduledTaskRun;
  // The conversation of this run still exists.
  canView: boolean;
  onView: (conversationId: string) => void;
}) {
  const { t } = useI18n();
  const running = run.status === 'running';
  return (
    <div data-schedule-run={run.id} className="flex items-center gap-2 rounded-control px-2 py-1 hover:bg-fill-hover">
      {/* The outcome as a shape; only a run in progress turns. */}
      <span className="flex shrink-0 items-center">
        {running
          ? <Spinner size="sm" label={t.schedule.runStatusRunning} labelHidden />
          : <StatusIcon tone={run.status === 'completed' ? 'success' : 'danger'} size="sm" />}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-caption text-label-secondary">
            {t.schedule.startedAtLabel} {formatDateTime(run.startedAt)}
          </span>
          {/* The spinner already says "running" to a screen reader. */}
          <span aria-hidden={running || undefined} className="min-w-0 truncate text-caption text-label">
            {running && t.schedule.runStatusRunning}
            {run.status === 'completed' && t.schedule.runStatusCompleted}
            {run.status === 'error' && (run.error ? run.error.slice(0, 30) : t.schedule.runStatusError)}
          </span>
        </div>
        {run.completedAt && (
          <div className="text-caption text-label-tertiary">
            {t.schedule.completedAtLabel} {formatDateTime(run.completedAt)}
          </div>
        )}
      </div>

      {canView && (
        <IconButton
          size="sm"
          icon={AppIcons.openExternal}
          label={t.schedule.viewConversation}
          onClick={() => onView(run.conversationId)}
        />
      )}
    </div>
  );
});

interface Props {
  runs: ScheduledTaskRun[];
}

export default function ScheduleRunHistory({ runs }: Props) {
  const { t } = useI18n();
  const conversationIndex = useChatStore((s) => s.conversationIndex);

  // One callback for the life of the list, so a row renders only when its own run changes.
  const viewConversation = useCallback((conversationId: string) => {
    const chat = useChatStore.getState();
    if (!chat.conversationIndex[conversationId]) return;
    chat.switchConversation(conversationId);
    useSettingsStore.getState().setViewMode('chat');
    // The button leaves with the automation page: the focus goes to the message field.
    focusComposerAfterPageChange();
  }, []);

  if (runs.length === 0) {
    return (
      <div className="px-4 py-3 text-ui-sm text-label-tertiary">
        {t.schedule.noRuns}
      </div>
    );
  }

  return (
    <div className="space-y-1 p-2">
      {runs.map((run) => (
        <RunRow key={run.id} run={run} canView={Boolean(conversationIndex[run.conversationId])} onView={viewConversation} />
      ))}
    </div>
  );
}
