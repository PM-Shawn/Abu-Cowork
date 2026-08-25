import { useEffect, useRef, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
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
import { rehydrateImageData } from '@/core/llm/imageRehydration';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';

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
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    const requestId = request.id;
    const previousFocus = document.activeElement;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // The visible, full-window lightbox owns Escape while it is open. A
        // capability request may arrive asynchronously underneath it; never
        // turn that same keypress into a hidden permission denial.
        if (useImageLightboxStore.getState().isOpen) {
          useImageLightboxStore.getState().close();
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        resolveCapabilitySetup(requestId, false);
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    closeButtonRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (
        previousFocus instanceof HTMLElement
        && previousFocus !== document.body
        && previousFocus !== document.documentElement
        && previousFocus.isConnected
      ) {
        previousFocus.focus();
        if (document.activeElement === previousFocus) return;
      }
      document.querySelector<HTMLTextAreaElement>(
        'textarea[data-chat-composer]:not(:disabled)',
      )?.focus();
    };
  }, [request]);

  if (!request) return null;

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
    chat.deleteMessagesFrom(request.conversationId, message.id);
    await runAgentLoopDispatched(
      request.conversationId,
      summary,
      images.length > 0 ? { images } : undefined,
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

  return (
    <div
      data-electron-no-drag
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/32 p-6 backdrop-blur-[2px]"
      onClick={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={request.target === 'computer'
          ? t.settings.capabilityComputerSetupTitle
          : t.settings.capabilityChromeSetupTitle}
        className="relative max-h-[min(820px,90vh)] w-[min(780px,92vw)] overflow-y-auto rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] p-7 shadow-2xl overlay-scroll"
      >
        <button
          ref={closeButtonRef}
          type="button"
          onClick={cancel}
          aria-label={t.common.close}
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-md text-[var(--abu-text-tertiary)] transition-colors hover:bg-[var(--abu-bg-hover)] hover:text-[var(--abu-text-primary)]"
        >
          <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
        </button>
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
      </div>
    </div>
  );
}
