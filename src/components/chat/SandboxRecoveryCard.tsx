import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, MonitorCog, Settings, ShieldCheck } from 'lucide-react';
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
      <div className="my-2 flex items-start gap-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] px-3 py-2 text-minor text-[var(--abu-text-tertiary)]">
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--abu-warning)]" />
        <span>{statusText}</span>
      </div>
    );
  }

  if (effectiveAction === 'needs-review') {
    return (
      <div className="my-2 flex items-start gap-2 rounded-lg border border-[var(--abu-warning)] bg-[var(--abu-warning-bg)] px-3 py-2 text-minor text-[var(--abu-text-secondary)]">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--abu-warning)]" />
        <span>{t.sandbox.appAutomationNeedsReview}</span>
      </div>
    );
  }

  if (effectiveAction === 'completed' || effectiveAction === 'stopped') {
    return (
      <div className="my-2 flex items-start gap-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] px-3 py-2 text-minor text-[var(--abu-text-tertiary)]">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--abu-success)]" />
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
    <div className="my-2 rounded-lg border border-[var(--abu-warning)] bg-[var(--abu-warning-bg)] p-3">
      <div className="flex items-start gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--abu-bg-base)]">
          <AlertTriangle className="h-4 w-4 text-[var(--abu-warning)]" />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-body font-semibold text-[var(--abu-text-primary)]">
            {t.sandbox.appAutomationTitle}
          </h4>
          <p className="mt-1 text-minor leading-relaxed text-[var(--abu-text-secondary)]">
            {format(t.sandbox.appAutomationDescription, { app })}
          </p>
          <p className="mt-1 text-caption leading-relaxed text-[var(--abu-text-tertiary)]">
            {t.sandbox.appAutomationConnectorPending}
          </p>
          {effectiveAction === 'failed' && (
            <p className="mt-2 text-caption font-medium text-[var(--abu-danger)]">
              {t.sandbox.appAutomationFailed}
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void continueWithComputerUse()}
          disabled={processing}
          className="btn-primary inline-flex h-8 items-center gap-1.5 px-3 text-minor disabled:opacity-60"
        >
          {processing
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <MonitorCog className="h-3.5 w-3.5" />}
          {t.sandbox.appAutomationUseComputer}
        </button>
        <button
          type="button"
          onClick={() => void stopTask()}
          disabled={processing}
          className="btn-secondary h-8 px-3 text-minor disabled:opacity-60"
        >
          {t.sandbox.appAutomationStop}
        </button>
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          className="btn-ghost inline-flex h-8 items-center gap-1 px-2 text-minor text-[var(--abu-text-tertiary)]"
        >
          {advancedOpen
            ? <ChevronDown className="h-3.5 w-3.5" />
            : <ChevronRight className="h-3.5 w-3.5" />}
          {t.sandbox.appAutomationAdvanced}
        </button>
      </div>

      {advancedOpen && (
        <div className="mt-3 border-t border-[var(--abu-border-subtle)] pt-3">
          <p className="text-caption leading-relaxed text-[var(--abu-text-tertiary)]">
            {t.sandbox.appAutomationAdvancedWarning}
          </p>
          <button
            type="button"
            onClick={() => useSettingsStore.getState().openSystemSettings('sandbox')}
            className="btn-secondary mt-2 inline-flex h-8 items-center gap-1.5 px-3 text-minor"
          >
            <Settings className="h-3.5 w-3.5" />
            {t.sandbox.appAutomationOpenSettings}
          </button>
        </div>
      )}
    </div>
  );
}
