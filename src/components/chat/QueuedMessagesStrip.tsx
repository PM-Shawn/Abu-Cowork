import { useState, useSyncExternalStore } from 'react';
import { CornerDownRight, X } from 'lucide-react';
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
import { Button } from '@/components/ui/button';

/**
 * Staging strip for follow-up messages: queued inputs sit at the composer's
 * top-right edge as light-gray cancellable pills. After the current task
 * finishes, each becomes an independent transcript turn; until then the ×
 * removes it without a trace.
 */
export default function QueuedMessagesStrip({ conversationId }: { conversationId: string }) {
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
        const result = await runAgentLoopDispatched(conversationId, next.text, { initiatedBy: 'user' });
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
          className="flex items-center gap-1.5 max-w-[75%] rounded-full bg-[var(--abu-bg-muted)] border border-[var(--abu-border-subtle)] pl-2.5 pr-1 py-1"
          title={t.queueStrip.queuedHint}
        >
          <CornerDownRight className="h-3 w-3 text-[var(--abu-text-muted)] shrink-0" />
          <span className="text-minor text-[var(--abu-text-muted)] truncate">{qi.text}</span>
          <button
            aria-label={t.queueStrip.cancel}
            title={t.queueStrip.cancel}
            onClick={() => removeQueuedInput(conversationId, qi.id)}
            className="btn-ghost shrink-0 rounded-full p-0.5 text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      {isPaused && (
        <div className="flex items-center gap-2 text-caption text-[var(--abu-text-muted)]">
          <span>{t.queueStrip.paused}</span>
          <Button variant="ghost" size="xs" disabled={isResuming} onClick={handleResume}>
            {t.queueStrip.resume}
          </Button>
        </div>
      )}
    </div>
  );
}
