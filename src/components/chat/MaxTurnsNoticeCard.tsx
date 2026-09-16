import { useState } from 'react';
import { AlertTriangle, Check, Loader2, Play, Settings } from 'lucide-react';
import type { Message } from '@/types';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import { isConversationRunningInSidecar } from '@/core/agent/sidecarRunPredicate';
import { announceChatTurnScrollIntent } from './chatTurnScrollIntent';
import { cn } from '@/lib/utils';
import { format, useI18n } from '@/i18n';

const RESUME_STOP_TIMEOUT_MS = 5_000;
const RESUME_STOP_POLL_MS = 50;

/**
 * The previous run reached its terminal before this card was appended, so it is
 * normally already stopped. The wait exists for the narrow window where a
 * queued hand-off is still winding down — starting the continuation on top of
 * it would race two runs against the same conversation.
 */
async function waitForPreviousRunToStop(conversationId: string): Promise<void> {
  const deadline = Date.now() + RESUME_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const conversation = useChatStore.getState().conversations[conversationId];
    if (
      conversation?.status !== 'running'
      && !isConversationRunningInSidecar(conversationId)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, RESUME_STOP_POLL_MS));
  }
  throw new Error('Timed out while stopping the previous agent loop');
}

/**
 * What a run that ran into its turn cap leaves behind.
 *
 * Two actions, because at this moment the user wants one of exactly two things:
 * to let it carry on ("this task is just long"), or to stop being interrupted
 * ("raise the cap"). The old copy — a sentence telling them to type a message —
 * served only the first, and made them go hunting for the second.
 *
 * From the second consecutive cap the two swap places: hitting it twice in a
 * row usually means the run is going in circles rather than that the cap is too
 * low, so the default action becomes "go look" rather than "run it again".
 * There is deliberately no cap on how many times 「继续执行」 can be used — the
 * card says what it thinks is happening and leaves the decision with the user.
 */
export default function MaxTurnsNoticeCard({
  conversationId,
  message,
}: {
  conversationId: string;
  message: Message;
}) {
  const { t } = useI18n();
  const [processing, setProcessing] = useState(false);
  const setAction = useChatStore((state) => state.setMaxTurnsNoticeAction);
  const openSystemSettings = useSettingsStore((state) => state.openSystemSettings);
  const addToast = useToastStore((state) => state.addToast);

  // Defensive: `isMaxTurnsNoticeMessage` already requires the payload, so this
  // only fires if a caller renders the card against the wrong message.
  const notice = message.maxTurnsNotice;
  if (!notice) return null;

  if (notice.action === 'continued') {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] px-3 py-2 text-minor text-[var(--abu-text-tertiary)]">
        <Check className="h-4 w-4 shrink-0 text-[var(--abu-success)]" />
        <span>{t.chat.maxTurns.continued}</span>
      </div>
    );
  }

  const again = notice.streak > 1;

  const continueRun = async () => {
    if (processing) return;
    setProcessing(true);
    try {
      const conversation = useChatStore.getState().conversations[conversationId];
      if (
        conversation?.status === 'running'
        || isConversationRunningInSidecar(conversationId)
      ) {
        useChatStore.getState().cancelStreaming(conversationId);
      }
      await waitForPreviousRunToStop(conversationId);

      // Settle BEFORE dispatching: the continuation may itself run into the cap,
      // and `deriveMaxTurnsStreak` reads this card's `action` to decide whether
      // the next notice is a repeat. Settling afterwards would make every
      // continuation look like a first hit.
      await setAction(conversationId, message.id, 'continued');

      announceChatTurnScrollIntent({ conversationId, source: 'max-turns-notice' });
      await runAgentLoopDispatched(
        conversationId,
        t.chat.maxTurns.continuePrompt,
        { requireNewRun: true, initiatedBy: 'user' },
      );
    } catch (error) {
      console.warn('[MaxTurnsNoticeCard] failed to continue the run:', error);
      addToast({
        type: 'error',
        title: t.chat.maxTurns.continueFailedTitle,
        message: t.chat.maxTurns.continueFailed,
      });
    } finally {
      setProcessing(false);
    }
  };

  const continueButton = (
    <button
      type="button"
      onClick={() => void continueRun()}
      disabled={processing}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-minor font-medium transition-colors disabled:cursor-default disabled:opacity-60',
        again
          ? 'border border-[var(--abu-border)] bg-[var(--abu-bg-base)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
          : 'bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)]',
      )}
    >
      {processing
        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
        : <Play className="h-3.5 w-3.5" />}
      {processing ? t.chat.maxTurns.continuing : t.chat.maxTurns.continueAction}
    </button>
  );

  const adjustButton = (
    <button
      type="button"
      onClick={() => openSystemSettings('general')}
      disabled={processing}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-minor font-medium transition-colors disabled:cursor-default disabled:opacity-60',
        again
          ? 'bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)]'
          : 'border border-[var(--abu-border)] bg-[var(--abu-bg-base)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]',
      )}
    >
      <Settings className="h-3.5 w-3.5" />
      {t.chat.maxTurns.adjustAction}
    </button>
  );

  return (
    <div className="my-2 rounded-lg border border-[var(--abu-warning)] bg-[var(--abu-warning-bg)] p-3">
      <div className="flex items-start gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--abu-bg-base)]">
          <AlertTriangle className="h-4 w-4 text-[var(--abu-warning)]" />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-h-xs text-[var(--abu-text-primary)]">
            {format(again ? t.chat.maxTurns.titleAgain : t.chat.maxTurns.title, {
              n: notice.limit,
            })}
          </h4>
          <p className="mt-1 text-minor leading-relaxed text-[var(--abu-text-secondary)]">
            {again ? t.chat.maxTurns.bodyAgain : t.chat.maxTurns.body}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {again ? adjustButton : continueButton}
        {again ? continueButton : adjustButton}
      </div>
    </div>
  );
}
