import { useState } from 'react';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Spinner } from '@/components/ds/spinner';
import type { SandboxRecoveryAction, SandboxRecoveryPayload } from '@/types';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import { announceChatTurnScrollIntent } from './chatTurnScrollIntent';
import { isConversationRunningInSidecar } from '@/core/agent/sidecarRunPredicate';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { format, useI18n } from '@/i18n';

const RECOVERY_STOP_TIMEOUT_MS = 5_000;
const RECOVERY_STOP_POLL_MS = 50;

async function waitForPreviousRunToStop(conversationId: string): Promise<void> {
  const deadline = Date.now() + RECOVERY_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const conversation = useChatStore.getState().conversations[conversationId];
    if (
      conversation?.status !== 'running'
      && !isConversationRunningInSidecar(conversationId)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, RECOVERY_STOP_POLL_MS));
  }
  throw new Error('Timed out while stopping the previous agent loop');
}

interface Props {
  conversationId: string;
  messageId: string;
  toolCallId: string;
  recovery: SandboxRecoveryPayload;
  settledAction?: SandboxRecoveryAction;
}

export default function SandboxRecoveryCard({
  conversationId,
  messageId,
  toolCallId,
  recovery,
  settledAction,
}: Props) {
  const { t } = useI18n();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [localAction, setLocalAction] = useState<SandboxRecoveryAction>();
  const setAction = useChatStore((state) => state.setToolCallSandboxRecoveryAction);
  const addToast = useToastStore((state) => state.addToast);
  const app = recovery.targetApp ?? t.sandbox.appAutomationTargetFallback;
  const effectiveAction = localAction ?? settledAction;

  if (
    effectiveAction === 'pending'
    || effectiveAction === 'started'
    || effectiveAction === 'enqueued'
  ) {
    const statusText = effectiveAction === 'pending'
      ? t.sandbox.appAutomationPending
      : effectiveAction === 'started'
        ? t.sandbox.appAutomationStarted
        : t.sandbox.appAutomationEnqueued;
    return (
      <div className="my-2 flex rounded-panel border border-separator bg-surface px-3 py-2">
        <Spinner label={statusText} />
      </div>
    );
  }

  if (effectiveAction === 'needs-review') {
    return (
      <div className="my-2">
        <InlineMessage tone="warning">{t.sandbox.appAutomationNeedsReview}</InlineMessage>
      </div>
    );
  }

  if (effectiveAction === 'completed' || effectiveAction === 'stopped') {
    return (
      <div className="my-2 flex items-start gap-2 rounded-panel border border-separator bg-surface px-3 py-2 text-ui text-label-secondary">
        <span className="flex h-lh shrink-0 items-center">
          <Icon icon={AppIcons.sandboxReady} className="text-success" />
        </span>
        <span>
          {effectiveAction === 'completed'
            ? t.sandbox.appAutomationCompleted
            : t.sandbox.appAutomationStopped}
        </span>
      </div>
    );
  }

  const continueWithComputerUse = async () => {
    if (processing) return;
    setProcessing(true);
    let computerUseMayHaveSideEffects = false;
    try {
      await setAction(conversationId, messageId, toolCallId, 'pending');
      const conversation = useChatStore.getState().conversations[conversationId];
      if (
        conversation?.status === 'running'
        || isConversationRunningInSidecar(conversationId)
      ) {
        useChatStore.getState().cancelStreaming(conversationId);
      }
      await waitForPreviousRunToStop(conversationId);
      await setAction(conversationId, messageId, toolCallId, 'started');
      computerUseMayHaveSideEffects = true;

      announceChatTurnScrollIntent({ conversationId, source: 'sandbox-recovery' });
      const result = await runAgentLoopDispatched(
        conversationId,
        format(t.sandbox.appAutomationContinuePrompt, { app }),
        {
          allowedTools: [
            TOOL_NAMES.COMPUTER,
            TOOL_NAMES.ASK_USER_QUESTION,
          ],
          requireNewRun: true,
          initiatedBy: 'user',
        },
      );
      if (result.reason === 'completed') {
        await setAction(conversationId, messageId, toolCallId, 'completed');
      } else if (result.reason === 'aborted') {
        await setAction(conversationId, messageId, toolCallId, 'stopped');
      } else {
        throw new Error(result.error ?? `Computer Use recovery ended with ${result.reason}`);
      }
    } catch (error) {
      console.warn('[SandboxRecoveryCard] failed to continue with Computer Use:', error);
      if (computerUseMayHaveSideEffects) {
        setLocalAction('needs-review');
        try {
          await setAction(conversationId, messageId, toolCallId, 'needs-review');
        } catch (persistError) {
          console.warn('[SandboxRecoveryCard] failed to persist uncertain recovery outcome:', persistError);
        }
        addToast({
          type: 'warning',
          title: t.sandbox.appAutomationTitle,
          message: t.sandbox.appAutomationOutcomeUncertain,
        });
        return;
      }
      try {
        await setAction(conversationId, messageId, toolCallId, 'failed');
      } catch (persistError) {
        console.warn('[SandboxRecoveryCard] failed to persist recovery failure:', persistError);
      }
      addToast({
        type: 'error',
        title: t.sandbox.appAutomationTitle,
        message: t.sandbox.appAutomationContinueFailed,
      });
    } finally {
      setProcessing(false);
    }
  };

  const stopTask = async () => {
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
      await setAction(conversationId, messageId, toolCallId, 'stopped');
    } catch (error) {
      console.warn('[SandboxRecoveryCard] failed to persist stop choice:', error);
      addToast({
        type: 'error',
        title: t.sandbox.appAutomationTitle,
        message: t.sandbox.appAutomationContinueFailed,
      });
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="my-2 rounded-panel border border-separator bg-surface p-3">
      <h4 className="flex items-center gap-2 text-ui font-medium text-label">
        <Icon icon={AppIcons.sandbox} size="sm" className="text-label-secondary" />
        {t.sandbox.appAutomationTitle}
      </h4>
      <div className="mt-2 space-y-2">
        <InlineMessage tone="warning">{format(t.sandbox.appAutomationDescription, { app })}</InlineMessage>
        {effectiveAction === 'failed' && (
          <InlineMessage tone="danger">{t.sandbox.appAutomationFailed}</InlineMessage>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          icon={AppIcons.sandbox}
          onClick={() => void continueWithComputerUse()}
          disabled={processing}
        >
          {t.sandbox.appAutomationUseComputer}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void stopTask()}
          disabled={processing}
        >
          {t.sandbox.appAutomationStop}
        </Button>
        {processing && <Spinner size="sm" label={t.task.processing} />}
        <Button
          variant="plain"
          size="sm"
          icon={advancedOpen ? AppIcons.expand : AppIcons.disclose}
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((open) => !open)}
          className="ml-auto"
        >
          {t.sandbox.appAutomationAdvanced}
        </Button>
      </div>

      {advancedOpen && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-separator pt-2 text-ui-sm text-label-secondary">
          <span>{t.sandbox.appAutomationAdvancedWarning}</span>
          <Button
            variant="secondary"
            size="sm"
            icon={AppIcons.openIn}
            onClick={() => useSettingsStore.getState().openSystemSettings('sandbox')}
          >
            {t.sandbox.appAutomationOpenSettings}
          </Button>
        </div>
      )}
    </div>
  );
}
