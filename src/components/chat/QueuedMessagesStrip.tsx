import { useTeamConfirmationStore } from '@/stores/teamConfirmationStore';
import { memo, useState, useSyncExternalStore } from 'react';
import { Button, IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import {
  dequeueNextUserInput,
  subscribeToInputQueue,
  getQueuedInputs,
  isUserInputQueuePaused,
  pauseUserInputQueue,
  removeQueuedInput,
  restoreDequeuedUserInput,
  resumeUserInputQueue,
} from '@/core/agent/userInputQueue';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import { announceChatTurnScrollIntent } from './chatTurnScrollIntent';
import { AgentLoopDispatchError } from '@/core/agent/agentLoopDispatchError';
import { useI18n } from '@/i18n';

/**
 * Staging strip for follow-up messages: queued inputs sit at the composer's
 * top-right edge as light-gray cancellable pills. After the current task
 * finishes, each becomes an independent transcript turn; until then the ×
 * removes it without a trace.
 */
function QueuedMessagesStrip({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const [isResuming, setIsResuming] = useState(false);
  const items = useSyncExternalStore(
    subscribeToInputQueue,
    () => getQueuedInputs(conversationId),
  );
  const visible = items.filter((qi) => !qi.isSystem);
  if (visible.length === 0) return null;
  const isPaused = isUserInputQueuePaused(conversationId);

  const handleResume = async () => {
    if (!isPaused || isResuming) return;
    setIsResuming(true);
    resumeUserInputQueue(conversationId);
    const next = dequeueNextUserInput(conversationId);
    try {
      if (next) {
        announceChatTurnScrollIntent({ conversationId, source: 'queue-resume' });
        const result = await runAgentLoopDispatched(conversationId, next.text, { initiatedBy: 'user',
          ...(next.teamConfirmationRetryId ? { teamConfirmationRetryId: next.teamConfirmationRetryId } : {}),
        });
        if (result.reason === 'error' && !result.messageTaken) {
          restoreDequeuedUserInput(conversationId, next);
        }
      }
    } catch (error) {
      if (
        next
        && (!(error instanceof AgentLoopDispatchError) || !error.messageTaken)
      ) {
        restoreDequeuedUserInput(conversationId, next);
      }
    } finally {
      if (getQueuedInputs(conversationId).some((item) => !item.isSystem)) {
        pauseUserInputQueue(conversationId);
      }
      setIsResuming(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      {visible.map((qi) => (
        <div
          key={qi.id}
          className="flex max-w-3/4 items-center gap-1 rounded-control bg-fill py-1 pr-1 pl-2"
          title={t.queueStrip.queuedHint}
        >
          <Icon icon={AppIcons.queued} size="sm" className="text-label-tertiary" />
          <span className="truncate text-ui-sm text-label-secondary">{qi.text}</span>
          <IconButton
            size="sm"
            icon={AppIcons.close}
            label={t.queueStrip.cancel}
            onClick={() => {
              if (qi.teamConfirmationRetryId) useTeamConfirmationStore.getState().revoke(qi.teamConfirmationRetryId);
              removeQueuedInput(conversationId, qi.id);
            }}
          />
        </div>
      ))}
      {isPaused && (
        <div className="flex items-center gap-2 text-ui-sm text-label-tertiary">
          <span>{t.queueStrip.paused}</span>
          <Button variant="plain" size="sm" disabled={isResuming} onClick={handleResume}>
            {t.queueStrip.resume}
          </Button>
        </div>
      )}
    </div>
  );
}

// ChatView re-renders on every streamed token, which is exactly when messages queue up.
export default memo(QueuedMessagesStrip);
