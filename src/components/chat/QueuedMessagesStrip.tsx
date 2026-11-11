import { useTeamConfirmationStore } from '@/stores/teamConfirmationStore';
import { memo, useId, useState, useSyncExternalStore } from 'react';
import { Button, IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import {
  dequeueNextUserInput,
  subscribeToInputQueue,
  getQueuedInputs,
  isSteeringInput,
  isUserInputQueuePaused,
  pauseUserInputQueue,
  removeQueuedInput,
  restoreDequeuedUserInput,
  resumeUserInputQueue,
  sendQueuedInputAfterRun,
} from '@/core/agent/userInputQueue';
import { useChatStore } from '@/stores/chatStore';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import { announceChatTurnScrollIntent } from './chatTurnScrollIntent';
import { AgentLoopDispatchError } from '@/core/agent/agentLoopDispatchError';
import { useI18n } from '@/i18n';
import { discardPreparedImageEdit } from '@/core/media/mediaJobs';
import { useToastStore } from '@/stores/toastStore';

/**
 * Staging strip for messages typed while a task runs: each sits at the
 * composer's top-right edge as a light-gray cancellable pill until it is used.
 * The label says what will happen to it:
 * - 「下一步加入」: the running task reads it after its current step (it was
 *   typed into that task, userInputQueue.ts) and it then appears in the
 *   conversation at that point. In a team conversation the lead reads it, and
 *   its current step may be a member's whole piece of work, so the pill says
 *   「交给队长」 instead of promising the next step. Its clock button makes it
 *   wait for the end of the task instead.
 * - 「结束后发送」: it becomes its own turn after the task.
 * - 「已暂停」: the queue is paused after a Stop; it is sent as its own turn
 *   when the user resumes the queue.
 * Until then the × removes any of them without a trace.
 */
function QueuedMessagesStrip({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const [isResuming, setIsResuming] = useState(false);
  const pausedLineId = useId();
  const items = useSyncExternalStore(
    subscribeToInputQueue,
    () => getQueuedInputs(conversationId),
  );
  const isRunning = useChatStore((s) => s.conversations[conversationId]?.status === 'running');
  const isTeam = useChatStore((s) => Boolean(s.conversations[conversationId]?.teamId));
  const visible = items.filter((qi) => !qi.isSystem);
  if (visible.length === 0) return null;
  const isPaused = isUserInputQueuePaused(conversationId);

  // 「继续队列」 sends the waiting messages as their own turns. While a task runs
  // that would hand them to it as new messages; they wait for it to end.
  const handleResume = async () => {
    if (!isPaused || isResuming || isRunning) return;
    setIsResuming(true);
    resumeUserInputQueue(conversationId);
    const next = dequeueNextUserInput(conversationId);
    // A task another surface started meanwhile: the message went back to wait
    // for that task's end (`queuedHandoff`), and the queue stays resumed so
    // that task's dispatcher starts it.
    let waitsForRunningTask = false;
    try {
      if (next) {
        announceChatTurnScrollIntent({ conversationId, source: 'queue-resume' });
        const result = await runAgentLoopDispatched(conversationId, next.text, { initiatedBy: 'user',
          ...(next.teamConfirmationRetryId ? { teamConfirmationRetryId: next.teamConfirmationRetryId } : {}),
          ...(next.continuesTeamTask ? { continuesTeamTask: true } : {}),
          ...(next.imageEditRequest ? { imageEditRequest: next.imageEditRequest } : {}),
          queuedHandoff: next,
        });
        if (result.reason === 'enqueued') waitsForRunningTask = true;
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
      if (!waitsForRunningTask && getQueuedInputs(conversationId).some((item) => !item.isSystem)) {
        pauseUserInputQueue(conversationId);
      }
      setIsResuming(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      {visible.map((qi) => {
        // A steering pill outside a running task (the moment between two
        // runs) is about to start its own turn, so it reads like the others.
        const steers = isRunning && isSteeringInput(qi);
        const label = steers
          ? (isTeam ? t.queueStrip.steerLabelTeam : t.queueStrip.steerLabel)
          : isPaused ? t.queueStrip.pausedLabel : t.queueStrip.afterRunLabel;
        const hint = steers
          ? (isTeam ? t.queueStrip.steerHintTeam : t.queueStrip.steerHint)
          : isPaused ? t.queueStrip.pausedHint : t.queueStrip.queuedHint;
        return (
          <div
            key={qi.id}
            className="flex max-w-3/4 items-center gap-1 rounded-control bg-fill py-1 pr-1 pl-2"
            title={hint}
            data-delivery={steers ? 'steer' : 'after-run'}
          >
            <Icon icon={steers ? AppIcons.queued : AppIcons.clock} size="sm" className="text-label-tertiary" />
            <span className="shrink-0 text-ui-sm text-label">{label}</span>
            <span className="truncate text-ui-sm text-label-secondary">{qi.text}</span>
            {steers && (
              <IconButton
                size="sm"
                icon={AppIcons.clock}
                label={t.queueStrip.sendAfterRun}
                onClick={() => sendQueuedInputAfterRun(conversationId, qi.id)}
              />
            )}
            <IconButton
              size="sm"
              icon={AppIcons.close}
              label={t.queueStrip.cancel}
              onClick={() => {
                if (qi.teamConfirmationRetryId) useTeamConfirmationStore.getState().revoke(qi.teamConfirmationRetryId);
                removeQueuedInput(conversationId, qi.id);
                if (qi.imageEditRequest) void discardPreparedImageEdit(conversationId, qi.imageEditRequest.id).then(undefined, error => {
                  useToastStore.getState().addToast({ type: 'error', title: t.media.editUnavailable, message: String(error) });
                });
              }}
            />
          </div>
        );
      })}
      {isPaused && (
        <div className="flex items-center gap-2 text-ui-sm text-label-tertiary">
          {/* While another task runs the stopped reply is not what is on screen:
              the line says when the queue can go on, and is the button's reason. */}
          <span id={pausedLineId}>{isRunning ? t.queueStrip.pausedWhileRunning : t.queueStrip.paused}</span>
          {/* Busy, not disabled: a task that starts under the focus must not
              drop the focus onto the window (§6.1 Busy controls). */}
          <Button
            variant="plain"
            size="sm"
            busy={isResuming || isRunning}
            aria-describedby={isRunning ? pausedLineId : undefined}
            onClick={handleResume}
          >
            {t.queueStrip.resume}
          </Button>
        </div>
      )}
    </div>
  );
}

// ChatView re-renders on every streamed token, which is exactly when messages queue up.
export default memo(QueuedMessagesStrip);
