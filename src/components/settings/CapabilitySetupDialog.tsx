import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { Dialog } from '@/components/ds/dialog';
import { useI18n } from '@/i18n';
import {
  getPendingCapabilitySetup,
  resolveCapabilitySetup,
  subscribeCapabilitySetup,
} from '@/core/capabilityPlugins/setupBridge';
import CapabilitiesSection from './sections/CapabilitiesSection';
import { restartApp } from '@/core/updates/checker';
import {
  clearComputerUseResumeToken,
  hashComputerUseTaskSummary,
  latestUserTaskSummary,
  saveComputerUseResumeToken,
} from '@/core/capabilityPlugins/computerUseResume';
import { routedComputerUseTaskSummary } from '@/core/capabilityPlugins/computerUseResume';
import { useChatStore } from '@/stores/chatStore';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import { ensureConversationModelUsable } from '@/components/chat/sendModelGuard';
import { rehydrateImageData } from '@/core/llm/imageRehydration';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
import { usePreviewStore } from '@/stores/previewStore';

/**
 * Task-local capability onboarding. The originating tool call remains
 * suspended in setupBridge until this dialog resolves its exact request id.
 */
export default function CapabilitySetupDialog() {
  const request = useSyncExternalStore(
    subscribeCapabilitySetup,
    getPendingCapabilitySetup,
  );
  const { t } = useI18n();
  const lightboxOpen = useImageLightboxStore((s) => s.isOpen);
  // The close-window question is a legacy layer that cannot be used under a modal dialog.
  const closeQuestionOpen = usePreviewStore((s) => s.appModalOpen);
  const windowShown = request !== null && !lightboxOpen && !closeQuestionOpen;
  const previousFocus = useRef<Element | null>(null);
  const hadRequest = useRef(false);

  // What had focus when the first of a run of requests arrived; a later request of the run
  // arrives with focus already lost to the window before it. A layout effect, so it runs
  // before the window opens and takes the focus.
  useLayoutEffect(() => {
    if (request && !hadRequest.current) previousFocus.current = document.activeElement;
    hadRequest.current = request !== null;
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // The visible, full-window lightbox owns Escape while it is open. A
      // capability request may arrive asynchronously underneath it; never
      // turn that same keypress into a hidden permission denial.
      if (useImageLightboxStore.getState().isOpen) {
        useImageLightboxStore.getState().close();
        return;
      }
      // The window is the top layer: its Escape goes no further, so a prompt
      // underneath is not answered by the same key. The dialog's own listener is on
      // `document` in the capture phase as well and still runs.
      if (windowShown) event.stopPropagation();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [request, windowShown]);

  if (!request) return null;

  // Runs once the window has gone. Focus returns to where it was when the request arrived,
  // or to the composer when that element is gone or cannot take it.
  const restoreFocus = (event: Event) => {
    // Another dialog took this window's place and holds the focus: leave it there.
    if (event.defaultPrevented) return;
    event.preventDefault();
    // The next waiting request has opened its own window, or this one only stepped aside.
    if (getPendingCapabilitySetup() !== null) return;
    const previous = previousFocus.current;
    if (
      previous instanceof HTMLElement
      && previous !== document.body
      && previous !== document.documentElement
      && previous.isConnected
    ) {
      previous.focus();
      if (document.activeElement === previous) return;
    }
    document.querySelector<HTMLTextAreaElement>(
      'textarea[data-chat-composer]:not(:disabled)',
    )?.focus();
  };

  const cancel = () => resolveCapabilitySetup(request.id, false);
  const complete = () => resolveCapabilitySetup(request.id, true);
  const resumeAfterRelaunch = async () => {
    resolveCapabilitySetup(request.id, true);
    const chat = useChatStore.getState();
    const conversation = chat.conversations[request.conversationId];
    const message = [...(conversation?.messages ?? [])]
      .reverse()
      .find((item) => item.role === 'user');
    if (!conversation || !message || conversation.status === 'running') return;
    const summary = routedComputerUseTaskSummary(message);
    if (!summary) return;
    const [rehydrated] = await rehydrateImageData(
      [message],
      request.conversationId,
      conversation.workspacePath ?? null,
    );
    const images = Array.isArray(rehydrated?.content)
      ? rehydrated.content
        .filter((item) => item.type === 'image' && item.source.data)
        .map((item, index) => ({
          id: `permission-resume-${index}`,
          data: item.type === 'image' ? item.source.data : '',
          mediaType: item.type === 'image' ? item.source.media_type : 'image/png' as const,
        }))
      : [];
    // `message` is the user message that started this loop (loops always
    // begin with their user message), so truncating from its own id already
    // removes the whole loop — deleteLoopMessages is retired (plan stage 3).
    // Same pre-send model check as the composer, before anything is deleted.
    if (!ensureConversationModelUsable(useChatStore.getState().conversations[request.conversationId], t.chat)) return;
    chat.deleteMessagesFrom(request.conversationId, message.id);
    await runAgentLoopDispatched(
      request.conversationId,
      summary,
      { initiatedBy: 'user', ...(images.length > 0 ? { images } : {}) },
    );
  };
  const relaunch = async () => {
    let resumableRequest = request;
    if (!request.taskSummaryHash) {
      const conversation = useChatStore.getState().conversations[request.conversationId];
      const summary = latestUserTaskSummary(conversation?.messages ?? []);
      if (!summary) return;
      resumableRequest = {
        ...request,
        taskSummaryHash: await hashComputerUseTaskSummary(summary),
      };
    }
    if (!saveComputerUseResumeToken(resumableRequest)) return;
    resolveCapabilitySetup(request.id, false);
    try {
      await restartApp();
    } catch {
      clearComputerUseResumeToken();
    }
  };

  // Escape, the scrim and the corner button arrive as a close, and a close is always a
  // refusal. Only the page reporting that setup is complete answers yes. The window is an
  // approval layer: no other window closes it, a window that opens while it is on screen is
  // turned away, and it waits its turn behind an approval that is already on the page. The
  // image viewer covers the whole app, so the window waits for it to close; it steps aside,
  // unanswered, for the close-window question and comes back when that is cancelled. One
  // dialog per request: the next waiting request opens as a new dialog.
  return (
    <Dialog
      key={request.id}
      layer="approval"
      open={windowShown}
      onOpenChange={(next) => { if (!next) resolveCapabilitySetup(request.id, false); }}
      title={request.target === 'computer'
        ? t.settings.capabilityComputerSetupTitle
        : t.settings.capabilityChromeSetupTitle}
      titleHidden
      size="xl"
      closeButton
      onCloseAutoFocus={restoreFocus}
    >
      <CapabilitiesSection
        key={request.id}
        setupTarget={request.target}
        requestedByTask
        computerUseRequirements={request.computerUseRequirements}
        setupOnly
        onSetupComplete={request.source === 'relaunch' ? resumeAfterRelaunch : complete}
        onSetupCancel={cancel}
        onSetupRelaunch={request.target === 'computer' ? relaunch : undefined}
      />
    </Dialog>
  );
}
