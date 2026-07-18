import { useState, useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { Virtuoso, type Components, type VirtuosoHandle } from 'react-virtuoso';
import { useChatStore, useActiveConversation } from '@/stores/chatStore';
import type { Message, ImageAttachment } from '@/types';
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
import { getMessageText } from '@/core/context/contextUtils';
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
import { cn } from '@/lib/utils';
import { isMacOS } from '@/utils/platform';
import { Input } from '@/components/ui/input';
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

/**
 * Context passed to the Virtuoso `Footer` component (the streaming typing
 * indicator). Values that change every render (i18n strings, retry info) are
 * threaded through `context` rather than closed over, because the `Item`/
 * `Footer` component *references* passed to Virtuoso's `components` prop must
 * stay referentially stable across renders — recreating them inline would
 * force Virtuoso to remount its internals on every render, defeating
 * virtualization.
 */
interface MessageListContext {
  showTypingIndicator: boolean;
  retryingLabel: string | null;
  thinkingLabel: string;
}

// Row wrapper for each virtualized message group. Spacing between groups
// MUST be padding, not margin (react-virtuoso guidance: margins on measured
// rows break height measurement/collapse behavior), so this replaces the
// previous `space-y-5` (margin) gap with a `pb-5` (padding-bottom) applied
// to every row uniformly. This is deliberately unconditional (no "skip on
// last item" special-casing): virtualized rows are NOT reliably
// `:first-child`/`:last-child` in the DOM (whichever row is topmost/
// bottommost in the overscan window varies as the user scrolls), so a CSS
// positional selector would apply to the wrong row. Net effect: one extra
// ~1.25rem gap appears after the final row (before the existing `pb-16`
// wrapper padding) that wasn't there before — a minor, intentional cosmetic
// trade-off for correctness. Note: `ItemProps` only exposes `children` +
// `style` (no `className`) — see react-virtuoso's `ItemProps<Data>` type.
const VirtuosoMessageItem: NonNullable<Components<Message[], MessageListContext>['Item']> = ({
  children,
  item: _item,
  context: _context,
  ...props
}) => (
  <div {...props} className="pb-5">
    {children}
  </div>
);

// Typing indicator, rendered after the last message group via Virtuoso's
// `Footer` slot so it stays part of the scrollable/measured content (needed
// for stick-to-bottom behavior).
const VirtuosoTypingFooter: NonNullable<Components<Message[], MessageListContext>['Footer']> = ({
  context,
}) => {
  if (!context?.showTypingIndicator) return null;
  return (
    <div className="flex items-center gap-3 pl-9 py-1">
      <div className="flex items-center gap-1">
        <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--abu-clay-60)]" />
        <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--abu-clay-60)]" />
        <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--abu-clay-60)]" />
      </div>
      <span className="text-body text-[var(--abu-text-tertiary)]">
        {context.retryingLabel ?? context.thinkingLabel}
      </span>
    </div>
  );
};

// Declared at module scope (not inline in the component) — react-virtuoso
// requires stable `components` object/function references, otherwise it
// remounts its internal list machinery on every ChatView render.
const virtuosoComponents: Components<Message[], MessageListContext> = {
  Item: VirtuosoMessageItem,
  Footer: VirtuosoTypingFooter,
};

export default function ChatView() {
  const activeConvId = useChatStore((s) => s.activeConversationId);
  const activeConv = useActiveConversation();
  const pendingSearchJump = useChatStore((s) => s.pendingSearchJump);
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const [isRenamingTitle, setIsRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  // Cancel any in-progress title rename when the active conversation changes.
  // The rename state is component-local; without this reset a draft started on
  // one conversation would carry over to whatever conversation becomes active
  // (e.g. a background/programmatic switch that doesn't fire the Input's onBlur)
  // and the next Enter/blur would commit it against the WRONG conversation's id.
  useEffect(() => {
    setIsRenamingTitle(false);
  }, [activeConvId]);
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

  // Virtuoso needs the actual scrollable DOM node (via `customScrollParent`)
  // to virtualize inside this container instead of creating its own nested
  // scroller.
  const [scrollParentEl, setScrollParentEl] = useState<HTMLDivElement | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // Bottom-lock (stick-to-bottom) state: while pinned, every list-height change
  // (late-measured widgets/iframes/images) re-sticks the view to the newest
  // message via `totalListHeightChanged`. Unpinned only by explicit upward user
  // intent (wheel/touch up); re-pinned when the user reaches the bottom again.
  // Event-driven — no timers guessing when heavy content finishes measuring.
  const pinnedRef = useRef(true);
  // Render mirror of pinnedRef — gates the "back to bottom" button. While the
  // lock is engaged the button is meaningless (we're headed to the bottom), and
  // Virtuoso transiently reports atBottom=false while mounting/measuring a
  // freshly-switched conversation, which used to flash the button.
  const [pinned, setPinned] = useState(true);
  const updatePinned = useCallback((v: boolean) => {
    pinnedRef.current = v;
    setPinned(v);
  }, []);
  // Fade timer for the search-hit highlight. Kept in a ref (NOT an effect
  // cleanup) — consuming the pending jump re-runs the effect, and a cleanup
  // would cancel the fade, leaving the highlight stuck on.
  const highlightFadeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Mirrors Virtuoso's own atBottomStateChange callback — drives the
  // "jump to latest" floating button. Starts true so the button doesn't
  // flash on first mount before Virtuoso reports its initial state.
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Message id to briefly highlight after a search-hit jump (see effect below).
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

  // Imperative stick-to-bottom: raw scrollTop assignment on the scroll parent,
  // deferred one frame. scrollToIndex is NOT reliable here — called during
  // Virtuoso's measurement storm, its target gets clobbered by Virtuoso's own
  // scroll compensation in the same cycle, and once measuring stops no further
  // event re-corrects the position. Raw scrollTop = scrollHeight bypasses
  // virtualization state entirely and always lands on the true bottom.
  const stickRafRef = useRef(0);
  const stickToBottom = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    cancelAnimationFrame(stickRafRef.current);
    stickRafRef.current = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, []);

  const scrollToLatest = useCallback((behavior: 'smooth' | 'auto' = 'smooth') => {
    // Explicit "go to bottom" — re-engage the bottom lock.
    updatePinned(true);
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior });
    // Optimistic — atBottomStateChange will confirm once the scroll settles.
    setIsAtBottom(true);
  }, [updatePinned]);

  // Conversation switch: engage the bottom lock (unless a search jump is about
  // to position the view on a hit) and reset the jump-button state so it doesn't
  // flash with the previous conversation's scrolled-up state. Layout effect —
  // must apply before paint or the stale unpinned/not-at-bottom state from the
  // previous conversation paints for one frame (the button flash).
  useLayoutEffect(() => {
    const jumpPending = useChatStore.getState().pendingSearchJump?.convId === activeConvId;
    updatePinned(!jumpPending);
    setIsAtBottom(true);
    if (pinnedRef.current) stickToBottom(scrollParentEl);
  }, [activeConvId, scrollParentEl, stickToBottom, updatePinned]);

  // Unpin on explicit upward user intent. Content growing under the viewport
  // must NOT unpin (that's the whole point of the lock), so we listen for user
  // gestures rather than scroll-position changes.
  useEffect(() => {
    if (!scrollParentEl) return;
    const unpin = () => updatePinned(false);
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) unpin(); };
    scrollParentEl.addEventListener('wheel', onWheel, { passive: true });
    scrollParentEl.addEventListener('touchmove', unpin, { passive: true });
    return () => {
      scrollParentEl.removeEventListener('wheel', onWheel);
      scrollParentEl.removeEventListener('touchmove', unpin);
    };
  }, [scrollParentEl, updatePinned]);

  // Search-jump: when a full-text search hit is picked, scroll to and briefly
  // highlight the first message whose text matches the query. Waits until the
  // target conversation's messages are loaded (an LRU miss loads async), then
  // consumes the pending jump exactly once.
  useEffect(() => {
    const jump = pendingSearchJump;
    if (!jump || jump.convId !== activeConvId) return;
    const conv = useChatStore.getState().conversations[activeConvId];
    if (!conv || conv.messages.length === 0) return; // not loaded yet — retry on next messageCount change
    const q = jump.query.trim().toLowerCase();
    const target = conv.messages.find(
      (m) => !m.isSystem && getMessageText(m.content).toLowerCase().includes(q),
    );
    // Consume regardless of match so a missing target doesn't retry forever.
    useChatStore.getState().setPendingSearchJump(null);
    if (!target) return;
    const groups = groupMessagesByLoop(conv.messages.filter((m) => !m.isSystem));
    const index = groups.findIndex((g) => g.some((m) => m.id === target.id));
    if (index < 0) return;
    // Release the bottom lock so late height-measurements don't yank the view
    // from the hit back to the bottom.
    updatePinned(false);
    setHighlightedMessageId(target.id);
    // Defer a frame so Virtuoso (freshly remounted via `key`) is mounted and can
    // resolve the index before we scroll.
    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index, align: 'center', behavior: 'auto' });
    });
    clearTimeout(highlightFadeTimerRef.current);
    highlightFadeTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 2600);
  }, [pendingSearchJump, activeConvId, messageCount, updatePinned]);

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
    // Re-enable follow + jump to the new message. Virtuoso measures the
    // freshly-appended item on its own next render, so this doesn't need to
    // wait for a DOM mutation callback the way the old MutationObserver did.
    scrollToLatest('auto');
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

                  <h1 className="text-h-xl font-semibold text-[var(--abu-text-primary)] leading-tight mb-2">
                    {pendingAgentDisplay.name}
                  </h1>
                  <p className="text-body text-[var(--abu-text-tertiary)] mb-3">
                    {pendingAgentDisplay.description}
                  </p>
                  {pendingAgentDisplay.intro && (
                    <p className="text-body text-[var(--abu-text-secondary)] leading-relaxed max-w-lg mx-auto">
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
                  <h1 className="text-h-xl font-semibold text-[var(--abu-text-primary)] leading-tight mb-2">
                    {t.chat.welcomeTitle}
                  </h1>
                  <p className="text-body text-[var(--abu-text-tertiary)]">
                    {t.chat.welcomeSubtitle}
                  </p>
                </>
              )}
            </div>

            {/* First-run setup prompt */}
            {needsSetup && (
              <div className="mb-6 mx-auto max-w-md">
                <div className="rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-base)]/80 px-5 py-4 text-center">
                  <p className="text-h-sm font-medium text-[var(--abu-text-primary)] mb-1">
                    {t.chat.setupRequired}
                  </p>
                  <p className="text-body text-[var(--abu-text-tertiary)] mb-3">
                    {t.chat.setupRequiredDesc}
                  </p>
                  <button
                    onClick={() => useSettingsStore.getState().openSystemSettings('ai-services')}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#D97706] text-white text-body font-medium hover:bg-[#B45309] transition-colors"
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

  // Chat view with messages
  // Filter out system-injected messages (e.g. max_tokens recovery prompts) and
  // group remaining messages by loopId for unified rendering
  const visibleMessages = messages.filter(m => !m.isSystem);
  const messageGroups = groupMessagesByLoop(visibleMessages);

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0 bg-[var(--abu-bg-base)]">
      {/* Conversation title header — flush at card top (TRAE-style header row).
          Extra left padding clears the traffic lights when the sidebar is collapsed on macOS. */}
      <div className={cn(
        'shrink-0 flex items-center h-11 px-4',
        // When the sidebar is collapsed the title-bar toolbar (sidebar toggle + search +
        // new task) floats over the top-left of this card — indent the title to clear them.
        sidebarCollapsed && isMacOS() && 'pl-48',
      )}>
        {isRenamingTitle ? (
          <Input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              const next = titleDraft.trim();
              if (next && next !== activeConv.title) renameConversation(activeConv.id, next);
              setIsRenamingTitle(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              else if (e.key === 'Escape') { setTitleDraft(activeConv.title); setIsRenamingTitle(false); }
            }}
            className="h-7 max-w-md text-body font-medium"
          />
        ) : (
          <span
            className="text-body font-medium text-[var(--abu-text-primary)] truncate cursor-default"
            onDoubleClick={() => { setTitleDraft(activeConv.title); setIsRenamingTitle(true); }}
            title={activeConv.title}
          >
            {activeConv.title}
          </span>
        )}
      </div>

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
      <div className="relative flex-1 min-h-0 overflow-y-auto" ref={setScrollParentEl}>
        <div className="w-full max-w-4xl mx-auto px-6 md:px-10 pt-5 pb-16 overflow-hidden">
          <Virtuoso
            // Remount per conversation so `initialTopMostItemIndex` re-applies
            // on every switch — the view lands at the newest message without a
            // visible flash-then-jump.
            key={activeConvId}
            ref={virtuosoRef}
            data={messageGroups}
            // Mount already scrolled to the last message, bottom-aligned.
            initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
            customScrollParent={scrollParentEl ?? undefined}
            computeItemKey={(index, group) => group[0]?.id ?? index}
            components={virtuosoComponents}
            // Stick to bottom on new/growing content, but only while already
            // at the bottom — Virtuoso pauses this itself once the user
            // scrolls up. 'auto' (instant) rather than 'smooth': streamed
            // text arrives in small, frequent chunks, so instant jumps read
            // as continuous motion without fighting a CSS scroll animation
            // that's still in flight when the next chunk lands.
            followOutput="auto"
            atBottomStateChange={(atBottom) => {
              setIsAtBottom(atBottom);
              // Reaching the bottom (by any means) re-engages the lock.
              if (atBottom) updatePinned(true);
            }}
            atBottomThreshold={100}
            // The bottom lock: whenever late-measured content (widget iframes,
            // images, charts) changes the total list height while the user is
            // pinned, re-stick to the newest message. Event-driven — replaces
            // any "scroll again after N ms" guesswork.
            totalListHeightChanged={() => {
              if (pinnedRef.current) stickToBottom(scrollParentEl);
            }}
            // Keep ~one viewport of rows mounted above/below the visible window.
            // Rows still virtualize (far-off messages stay unmounted), but this
            // widens the live band so inline iframe widgets (HtmlWidgetBlock)
            // survive the small scroll jitter of normal reading without the
            // srcdoc reload + in-widget JS state reset that a bare unmount causes.
            increaseViewportBy={{ top: 900, bottom: 900 }}
            context={{
              // Typing indicator - brief flash before assistant message is created
              showTypingIndicator:
                activeConv?.status === 'running' && messages.every((m) => m.role === 'user'),
              retryingLabel: retryInfo
                ? format(t.chat.retrying, { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })
                : null,
              thinkingLabel: t.chat.thinking,
            }}
            itemContent={(index, group) =>
              group.length === 1 && isCompactBoundary(group[0]) ? (
                <CompactDivider message={group[0]} />
              ) : (
                <MessageGroup messages={group} isLastGroup={index === messageGroups.length - 1} highlightMessageId={highlightedMessageId} />
              )
            }
          />

          {/* Bottom sentinel — keeps a sliver of space after last message */}
          <div className="h-px w-full" />
        </div>

        {/* Scroll-to-bottom button — only when the user has actually left the
            bottom (unpinned). While the lock is engaged we're headed to the
            bottom anyway, and Virtuoso's transient atBottom=false during
            mount/measure would otherwise flash the button on every switch. */}
        {!isAtBottom && !pinned && (
          <button
            onClick={() => scrollToLatest('smooth')}
            className="sticky bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--abu-bg-base)]/90 border border-[var(--abu-border)] text-body text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-base)] transition-all backdrop-blur-sm"
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
            <div className="flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-text-tertiary)]">
              <Check className="h-3.5 w-3.5 shrink-0 text-[var(--abu-success)]" />
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
            <p className="text-caption text-[var(--abu-text-muted)] truncate">
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

