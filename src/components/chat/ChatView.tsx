import { useState, useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useChatStore, useActiveConversation } from '@/stores/chatStore';
import type { Message, ImageAttachment } from '@/types';
import { useAutoScroll } from '@/hooks/useAutoScroll';
import { useRenderWindow } from '@/hooks/useRenderWindow';
import { runAgentLoop } from '@/core/agent/agentLoop';
import { getPendingCommandConfirmation, resolveCommandConfirmation, subscribeToCommandConfirmation, getPendingFilePermission, resolveFilePermission, subscribeToFilePermission, getPendingWorkspaceRequest, resolveWorkspaceRequest, subscribeToWorkspaceRequest, getPendingUserQuestions, subscribeUserQuestion, findQuestionOwningMessage } from '@/core/agent/permissionBridge';
import { useSettingsStore, getActiveApiKey, providerRequiresApiKey } from '@/stores/settingsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { PermissionDuration } from '@/stores/permissionStore';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useI18n } from '@/i18n';
import MessageGroup from './MessageGroup';
import CompactDivider from './CompactDivider';
import { isCompactBoundary } from '@/core/context/compactBoundary';
import { compactConversationManually } from '@/core/context/compactionService';
import { useToastStore } from '@/stores/toastStore';
import ChatInput from './ChatInput';
import UserQuestionDock from './UserQuestionDock';
import AgentStatusStrip from './AgentStatusStrip';
import QueuedMessagesStrip from './QueuedMessagesStrip';
import ScenarioGuide from './ScenarioGuide';
import { agentRegistry } from '@/core/agent/registry';
import PermissionDialog from '@/components/common/PermissionDialog';
import CommandConfirmDialog from '@/components/common/CommandConfirmDialog';
import { ChevronDown, Settings, Check } from 'lucide-react';
import abuAvatar from '@/assets/abu-avatar.png';
import IMInfoBar from './IMInfoBar';
import SourceInfoBar from './SourceInfoBar';
import ComputerUseStatusBar from './ComputerUseStatusBar';
import ConvIdBadge from './ConvIdBadge';
import UsageChip from './UsageChip';

/**
 * Groups messages by loopId for rendering.
 * Messages with the same loopId are grouped together and rendered as one visual block.
 * Messages without loopId (legacy) are each treated as their own group.
 */
function groupMessagesByLoop(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let currentGroup: Message[] = [];
  let currentLoopId: string | undefined | null = null;

  for (const msg of messages) {
    const msgLoopId = msg.loopId;

    // If loopId changes, or message has no loopId (undefined !== undefined should start new group)
    if (!msgLoopId || msgLoopId !== currentLoopId) {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = [msg];
      currentLoopId = msgLoopId;
    } else {
      // Same loopId - add to current group
      currentGroup.push(msg);
    }
  }

  // Don't forget the last group
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

export default function ChatView() {
  const activeConvId = useChatStore((s) => s.activeConversationId);
  const activeConv = useActiveConversation();
  const createConversation = useChatStore((s) => s.createConversation);
  // Subscribe to messages count so ChatView re-renders when background processes
  // (IM agentLoop) add messages — even if the conversation object reference is stale
  const messageCount = useChatStore((s) => {
    const id = s.activeConversationId;
    return id ? s.conversations[id]?.messages.length ?? 0 : 0;
  });
  // Derive messages from activeConv (re-evaluated when messageCount changes)
  const messages = activeConv?.messages ?? [];
  void messageCount; // used only to trigger re-render
  const { t, format, locale } = useI18n();

  // Filter out system-injected messages (e.g. max_tokens recovery prompts) and
  // group remaining messages by loopId for unified rendering. `conv.messages`
  // itself stays fully in memory (compaction/editing/export all read the full
  // array) — grouping is cheap; render windowing below only limits how many
  // of these groups get mounted as DOM (long-conversation Part B3).
  const visibleMessages = messages.filter(m => !m.isSystem);
  const messageGroups = groupMessagesByLoop(visibleMessages);

  // Pending agent: set when user enters chat from any agent surface
  // (toolbox detail "Start Chat" button, etc.). Drives the welcome banner so
  // the first impression is the agent's persona; cleared once the first
  // message lands. Works for both builtin experts and user-defined agents.
  const pendingAgentName = useChatStore((s) => s.pendingAgentName);
  const pendingAgent = pendingAgentName ? agentRegistry.getAgent(pendingAgentName) ?? null : null;
  // Resolve i18n display fields with graceful fallback to the canonical name/
  // description on the agent. Locale-specific fields are populated by builtin
  // agents (see registry.ts) — user-defined agents only have the base fields.
  const pendingAgentDisplay = pendingAgent
    ? {
        name: pendingAgent.displayNames?.[locale] ?? pendingAgent.name,
        description: pendingAgent.descriptions?.[locale] ?? pendingAgent.description,
        avatar: pendingAgent.avatar ?? '🤖',
        intro: pendingAgent.intros?.[locale] ?? pendingAgent.intro,
      }
    : null;

  // Subscribe to command confirmation state using useSyncExternalStore
  const commandConfirmRequest = useSyncExternalStore(
    subscribeToCommandConfirmation,
    getPendingCommandConfirmation
  );

  // Subscribe to file permission requests using useSyncExternalStore
  const filePermissionRequest = useSyncExternalStore(
    subscribeToFilePermission,
    getPendingFilePermission
  );

  // Subscribe to workspace request state
  const workspaceRequest = useSyncExternalStore(
    subscribeToWorkspaceRequest,
    getPendingWorkspaceRequest
  );

  // Subscribe to pending ask_user_question entries — the docked card above
  // the composer renders the first one belonging to the active conversation.
  const pendingUserQuestions = useSyncExternalStore(
    subscribeUserQuestion,
    getPendingUserQuestions
  );

  const handleCommandConfirm = () => {
    resolveCommandConfirmation(true);
  };

  const handleCommandCancel = () => {
    resolveCommandConfirmation(false);
  };

  const handleFilePermissionAllow = (duration: PermissionDuration) => {
    if (filePermissionRequest) {
      const capabilities: ('read' | 'write' | 'execute')[] =
        filePermissionRequest.capability === 'write'
          ? ['read', 'write', 'execute']
          : ['read'];
      resolveFilePermission(true, filePermissionRequest.path, capabilities, duration);
    }
  };

  const handleFilePermissionDeny = () => {
    resolveFilePermission(false);
  };

  const handleWorkspaceSelect = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: workspaceRequest?.suggestedPath || undefined,
      });
      if (selected && typeof selected === 'string') {
        useWorkspaceStore.getState().setWorkspace(selected);
        if (activeConv?.id) {
          useChatStore.getState().setConversationWorkspace(activeConv.id, selected);
        }
        resolveWorkspaceRequest(selected);
      } else {
        resolveWorkspaceRequest(null);
      }
    } catch {
      resolveWorkspaceRequest(null);
    }
  };

  // Directly authorize the suggested path without opening file picker
  const handleWorkspaceAuthorize = () => {
    if (workspaceRequest?.suggestedPath) {
      useWorkspaceStore.getState().setWorkspace(workspaceRequest.suggestedPath);
      if (activeConv?.id) {
        useChatStore.getState().setConversationWorkspace(activeConv.id, workspaceRequest.suggestedPath);
      }
      resolveWorkspaceRequest(workspaceRequest.suggestedPath);
    }
  };

  const handleWorkspaceDeny = () => {
    resolveWorkspaceRequest(null);
  };

  const isFollowing = activeConv?.status === 'running';
  const { containerRef, isAtBottom, scrollToBottom, resetToBottom } = useAutoScroll({ following: isFollowing });

  // Render windowing (long-conversation Part B3): only mount the most recent
  // `renderLimit` message groups. `useAutoScroll`'s containerRef is a plain
  // callback ref — mirror the node into our own ref too (merged below) so we
  // can read scrollHeight/scrollTop for the IntersectionObserver root and
  // the prepend scroll-anchor without touching useAutoScroll's internals.
  const scrollNodeRef = useRef<HTMLDivElement | null>(null);
  const mergedContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollNodeRef.current = node;
      containerRef(node);
    },
    [containerRef],
  );
  const { renderLimit, loadEarlier: growRenderWindow, showSentinel } = useRenderWindow(
    messageGroups.length,
    activeConvId,
  );
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Set right before growing the render window; consumed by the
  // useLayoutEffect below to keep the scroll position visually anchored
  // (prepending earlier groups adds height above the viewport, which would
  // otherwise yank the view — see useAutoScroll.ts:145, MutationObserver
  // auto-scroll is gated on `isAtBottomRef`, so it never fights this).
  const pendingAnchorRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);

  const loadEarlier = useCallback(() => {
    const container = scrollNodeRef.current;
    if (container) {
      pendingAnchorRef.current = {
        prevScrollHeight: container.scrollHeight,
        prevScrollTop: container.scrollTop,
      };
    }
    growRenderWindow();
  }, [growRenderWindow]);

  // Runs synchronously after the DOM commits the newly-grown group set, but
  // before paint — restores the scroll offset so the added height above the
  // viewport doesn't visually shift the content the user was looking at.
  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    if (!anchor) return;
    const container = scrollNodeRef.current;
    if (container) {
      container.scrollTop = anchor.prevScrollTop + (container.scrollHeight - anchor.prevScrollHeight);
    }
    pendingAnchorRef.current = null;
  }, [renderLimit]);

  // Observe the top sentinel; scrolling it into view loads another batch of
  // earlier groups. Not present in happy-dom — guarded, and re-mocked per
  // test. Real behavior needs a tauri:dev smoke check (see report).
  useEffect(() => {
    if (!showSentinel) return;
    const sentinel = sentinelRef.current;
    const root = scrollNodeRef.current;
    if (!sentinel || !root || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadEarlier();
        }
      },
      { root, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [showSentinel, loadEarlier]);

  // Scroll to bottom when switching conversations.
  // useLayoutEffect runs after DOM commit but before paint,
  // so the user never sees the wrong scroll position.
  useLayoutEffect(() => {
    if (activeConvId) {
      scrollToBottom();
    }
  }, [activeConvId, scrollToBottom]);

  const handleSend = async (text: string, images?: ImageAttachment[], workspacePath?: string | null) => {
    // Block sending if API key is not configured (Ollama doesn't need one)
    const currentState = useSettingsStore.getState();
    if (providerRequiresApiKey(currentState) && !getActiveApiKey(currentState)?.trim()) {
      currentState.openSystemSettings('ai-services');
      return;
    }

    let convId = activeConv?.id;

    if (text.trim() === '/compact') {
      const res = await compactConversationManually(convId ?? '');
      useToastStore.getState().addToast(
        res.compacted
          ? { type: 'success', title: t.chat.compactCommand.done }
          : res.reason === 'too-few'
            ? { type: 'info', title: t.chat.compactCommand.tooFew }
            : { type: 'error', title: t.chat.compactCommand.failed },
      );
      return;
    }

    const isNewConversation = !convId;
    if (!convId) {
      convId = createConversation(workspacePath);
    }
    // Auto-collapse sidebar when sending first message in a new conversation
    if (isNewConversation && !useSettingsStore.getState().sidebarCollapsed) {
      useSettingsStore.getState().toggleSidebar();
    }
    // Re-enable auto-scroll when user sends a message.
    // Don't scroll immediately — let MutationObserver scroll after the new message renders.
    resetToBottom();
    await runAgentLoop(convId, text, { images });
  };


  // First-run banner: show when no provider has been configured yet.
  // "Configured" = has an API key OR is a keyless provider (ollama/lmstudio).
  const needsSetup = useSettingsStore((s) => {
    return !s.providers.some(
      p => p.apiKey.trim().length > 0 || p.id === 'ollama' || p.id === 'lmstudio'
    );
  });

  // Scenario guide state — lifted here so ChatInput can receive the custom placeholder
  const [scenarioPlaceholder, setScenarioPlaceholder] = useState<string | null>(null);
  const [guideVisible, setGuideVisible] = useState(true);
  // Optimistic feedback for the beat between submitting a question/plan answer
  // and the resumed loop producing anything (Bug 1: 点同意后无反应).
  const [resuming, setResuming] = useState(false);
  const agentStatus = useChatStore((s) => s.agentStatus);
  const retryInfo = useChatStore((s) => s.retryInfo);

  const handleSelectPrompt = useCallback((prompt: string) => {
    // Fill the prompt into the input via pendingInput
    useChatStore.getState().setPendingInput(prompt);
  }, []);

  const handleScenarioChange = useCallback((placeholder: string | null) => {
    setScenarioPlaceholder(placeholder);
  }, []);

  // Hide guide when user starts typing (called from ChatInput)
  const handleWelcomeInputChange = useCallback((hasText: boolean) => {
    setGuideVisible(!hasText);
  }, []);

  // Conversation loading from disk (LRU cache miss) — show skeleton instead of welcome page
  if (activeConvId && !activeConv) {
    return (
      <div className="flex flex-col h-full bg-[var(--abu-bg-base)]">
        <div className="flex-1 overflow-hidden">
          <div className="w-full max-w-4xl mx-auto px-6 md:px-10 pt-5 pb-16 space-y-5">
            {/* User message skeleton */}
            <div className="flex justify-end">
              <div className="max-w-[70%] space-y-2">
                <div className="h-4 w-48 bg-[var(--abu-bg-muted)] rounded animate-pulse" />
              </div>
            </div>
            {/* Assistant message skeleton */}
            <div className="flex gap-3">
              <div className="w-7 h-7 rounded-full bg-[var(--abu-bg-muted)] animate-pulse shrink-0" />
              <div className="flex-1 space-y-2.5">
                <div className="h-4 w-full bg-[var(--abu-bg-muted)] rounded animate-pulse" />
                <div className="h-4 w-3/4 bg-[var(--abu-bg-muted)] rounded animate-pulse" />
                <div className="h-4 w-1/2 bg-[var(--abu-bg-muted)] rounded animate-pulse" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Welcome UI renders whenever there's no active conv OR the active conv
  // is still empty (zero messages). Task #38: project "+" button creates
  // a conv immediately (to inherit defaultSkills/defaultMCPServers) — we
  // want it to feel the same as top-level "+" by showing welcome until the
  // user actually types. Downstream handleSend already reuses the existing
  // activeConv.id when present, so no createConversation churn happens.
  if (!activeConv || activeConv.messages.length === 0) {
    return (
      <div className="flex flex-col h-full bg-[var(--abu-bg-base)]">
        <div className="flex-1 flex flex-col items-center justify-start overflow-y-auto px-8 pt-[12vh] pb-12">
          <div className="w-full max-w-2xl">
            {/* Title */}
            <div className="text-center mb-8">
              {pendingAgentDisplay ? (
                <>
                  {/* Agent avatar (emoji in tinted circle) */}
                  <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-[var(--abu-bg-active)] flex items-center justify-center text-5xl select-none">
                    {pendingAgentDisplay.avatar}
                  </div>

                  <h1 className="text-[28px] font-semibold text-[var(--abu-text-primary)] leading-tight mb-2">
                    {pendingAgentDisplay.name}
                  </h1>
                  <p className="text-[15px] text-[var(--abu-text-tertiary)] mb-3">
                    {pendingAgentDisplay.description}
                  </p>
                  {pendingAgentDisplay.intro && (
                    <p className="text-[14px] text-[var(--abu-text-secondary)] leading-relaxed max-w-lg mx-auto">
                      {pendingAgentDisplay.intro}
                    </p>
                  )}
                </>
              ) : (
                <>
                  {/* Mascot */}
                  <div className="w-20 h-20 mx-auto mb-4 rounded-full overflow-hidden">
                    <img src={abuAvatar} alt="Abu" className="w-full h-full object-cover" />
                  </div>

                  {/* Slogan */}
                  <h1 className="text-[28px] font-semibold text-[var(--abu-text-primary)] leading-tight mb-2">
                    {t.chat.welcomeTitle}
                  </h1>
                  <p className="text-[15px] text-[var(--abu-text-tertiary)]">
                    {t.chat.welcomeSubtitle}
                  </p>
                </>
              )}
            </div>

            {/* First-run setup prompt */}
            {needsSetup && (
              <div className="mb-6 mx-auto max-w-md">
                <div className="rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-base)]/80 px-5 py-4 text-center">
                  <p className="text-[15px] font-medium text-[var(--abu-text-primary)] mb-1">
                    {t.chat.setupRequired}
                  </p>
                  <p className="text-[13px] text-[var(--abu-text-tertiary)] mb-3">
                    {t.chat.setupRequiredDesc}
                  </p>
                  <button
                    onClick={() => useSettingsStore.getState().openSystemSettings('ai-services')}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#D97706] text-white text-[13px] font-medium hover:bg-[#B45309] transition-colors"
                  >
                    <Settings className="h-3.5 w-3.5" />
                    {t.chat.setupButton}
                  </button>
                </div>
              </div>
            )}

            {/* Main input */}
            <div>
              <ChatInput
                variant="welcome"
                onSend={handleSend}
                scenarioPlaceholder={scenarioPlaceholder}
                onInputChange={handleWelcomeInputChange}
              />
            </div>

            {/* Scenario Guide */}
            <ScenarioGuide
              onSelectPrompt={handleSelectPrompt}
              onScenarioChange={handleScenarioChange}
              visible={guideVisible}
            />
          </div>
        </div>
      </div>
    );
  }

  // Chat view with messages (visibleMessages/messageGroups computed above,
  // before the early returns, so the render-window hook can see the count).
  const renderedGroups = messageGroups.length > renderLimit
    ? messageGroups.slice(-renderLimit)
    : messageGroups;

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0 bg-[var(--abu-bg-base)]">
      {/* Command Confirmation Dialog — only show if it belongs to this conversation */}
      {commandConfirmRequest && commandConfirmRequest.conversationId === activeConvId && (
        <CommandConfirmDialog
          request={commandConfirmRequest.info}
          onConfirm={handleCommandConfirm}
          onCancel={handleCommandCancel}
        />
      )}

      {/* File Permission Dialog — only show if it belongs to this conversation */}
      {filePermissionRequest && filePermissionRequest.conversationId === activeConvId && (
        <PermissionDialog
          request={{
            type: filePermissionRequest.capability === 'write' ? 'file-write' : 'file-read',
            path: filePermissionRequest.path,
          }}
          onAllow={handleFilePermissionAllow}
          onDeny={handleFilePermissionDeny}
        />
      )}

      {/* Workspace Selection Dialog — only show if it belongs to this conversation */}
      {workspaceRequest && workspaceRequest.conversationId === activeConvId && (
        <PermissionDialog
          request={{
            type: 'folder-select',
            reason: workspaceRequest.reason,
            path: workspaceRequest.suggestedPath,
          }}
          onAllow={() => {}}
          onChooseFolder={handleWorkspaceSelect}
          onAuthorize={handleWorkspaceAuthorize}
          onDeny={handleWorkspaceDeny}
        />
      )}

      {/* IM Channel Info Bar — show for IM conversations */}
      {activeConv.imPlatform && <IMInfoBar conversation={activeConv} />}

      {/* Source Info Bar — show for scheduled task / trigger conversations */}
      {!activeConv.imPlatform && <SourceInfoBar conversation={activeConv} />}

      {/* Computer Use Status Bar — visible during screen control */}
      <ComputerUseStatusBar onStop={() => useChatStore.getState().cancelStreaming(activeConv.id)} />

      {/* Messages Area */}
      <div className="relative flex-1 min-h-0 overflow-y-auto" ref={mergedContainerRef}>
        <div className="w-full max-w-4xl mx-auto px-6 md:px-10 pt-5 pb-16 overflow-hidden">
          <div className="space-y-5">
            {/* Top sentinel — only mounted while there are earlier groups
                still outside the render window. Scrolling it into view
                triggers loadEarlier() via IntersectionObserver. */}
            {showSentinel && (
              <div
                ref={sentinelRef}
                data-testid="render-window-sentinel"
                className="py-2 text-center text-[12px] text-[var(--abu-text-tertiary)]"
              >
                {t.chat.loadingEarlier}
              </div>
            )}

            {renderedGroups.map((group, idx) =>
              group.length === 1 && isCompactBoundary(group[0]) ? (
                <CompactDivider key={group[0].id} message={group[0]} />
              ) : (
                <MessageGroup
                  key={group[0].id}
                  messages={group}
                  isLastGroup={idx === renderedGroups.length - 1}
                />
              ),
            )}

            {/* Typing indicator - brief flash before assistant message is created */}
            {activeConv?.status === 'running' && messages.every((m) => m.role === 'user') && (
              <div className="flex items-center gap-3 pl-9 py-1">
                <div className="flex items-center gap-1">
                  <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--abu-clay-60)]" />
                  <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--abu-clay-60)]" />
                  <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--abu-clay-60)]" />
                </div>
                <span className="text-[13px] text-[var(--abu-text-tertiary)]">
                  {retryInfo
                    ? format(t.chat.retrying, { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })
                    : t.chat.thinking}
                </span>
              </div>
            )}
          </div>

          {/* Bottom sentinel — keeps a sliver of space after last message */}
          <div className="h-px w-full" />
        </div>

        {/* Scroll-to-bottom button */}
        {!isAtBottom && (
          <button
            onClick={scrollToBottom}
            className="sticky bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--abu-bg-base)]/90 border border-[var(--abu-border)] text-[13px] text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-base)] transition-all backdrop-blur-sm"
          >
            <ChevronDown className="h-3.5 w-3.5" />
            <span>{t.chat.scrollToBottom}</span>
          </button>
        )}
      </div>

      {/* Bottom Input */}
      <div className="shrink-0 px-6 md:px-10 pb-4 pt-1.5 bg-[var(--abu-bg-base)]">
        <div className="max-w-4xl mx-auto flex flex-col gap-1.5">
          {/* Docked ask_user_question card — sits flush above the composer,
              same width. Render the first pending question that belongs to the
              active conversation and whose owning message can be located. */}
          {(() => {
            const pending = pendingUserQuestions.find((pq) => pq.conversationId === activeConvId);
            if (!pending) return null;
            const owningMsg = findQuestionOwningMessage(messages, pending.id);
            if (!owningMsg) return null;
            return (
              <UserQuestionDock
                key={pending.id}
                conversationId={pending.conversationId}
                messageId={owningMsg.id}
                toolCallId={pending.id}
                payload={pending.payload}
                onSubmitted={() => {
                  setResuming(true);
                  // Fallback clear — normally hidden once the loop sets a status.
                  setTimeout(() => setResuming(false), 4000);
                }}
              />
            );
          })()}
          {/* Optimistic "resuming" flash — only in the gap before the loop sets
              a real status, so it never stacks with AgentStatusStrip. */}
          {resuming && agentStatus === 'idle' && (
            <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--abu-text-tertiary)]">
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
              <span className="truncate">{t.chat.resuming}</span>
            </div>
          )}
          {/* Live agent status — compaction / retry, so a slow provider isn't a
              silent dead wait above the composer. */}
          <AgentStatusStrip conversationId={activeConv.id} />
          {/* Staged mid-task messages — cancellable pills at the composer's
              top-right edge; they enter the transcript when the loop drains them */}
          <QueuedMessagesStrip conversationId={activeConv.id} />
          <ChatInput variant="chat" onSend={handleSend} />
          <div className="flex items-center justify-center gap-3 mt-1.5 whitespace-nowrap overflow-hidden">
            <UsageChip conversationId={activeConv.id} />
            <p className="text-[11px] text-[var(--abu-text-muted)] truncate">
              {t.chat.disclaimer}
            </p>
            <span className="text-[var(--abu-text-muted)] opacity-50">·</span>
            <ConvIdBadge conversationId={activeConv.id} />
          </div>
        </div>
      </div>
    </div>
  );
}

