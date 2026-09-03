import { useState, useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { Virtuoso, type Components, type VirtuosoHandle } from 'react-virtuoso';
import { getConversationAgentState, useChatStore, useActiveConversation } from '@/stores/chatStore';
import type { Message, ImageAttachment } from '@/types';
import {
  runAgentLoopDispatched,
  type AgentLoopDispatchResult,
} from '@/core/agent/agentLoopRunner';
import { AgentLoopDispatchError } from '@/core/agent/agentLoopDispatchError';
import { shouldRestoreComposerAfterDispatch } from './composerSendResult';
import { getPendingCommandConfirmation, resolveCommandConfirmation, subscribeToCommandConfirmation, getPendingFilePermission, resolveFilePermission, subscribeToFilePermission, getPendingWorkspaceRequest, resolveWorkspaceRequest, subscribeToWorkspaceRequest, getPendingUserQuestions, subscribeUserQuestion, findQuestionOwningMessage } from '@/core/agent/permissionBridge';
import { useSettingsStore, getActiveApiKey, providerRequiresApiKey } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { PermissionDuration } from '@/stores/permissionStore';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useI18n } from '@/i18n';
import MessageGroup from './MessageGroup';
import CompactDivider from './CompactDivider';
import BrowserRunReportCard from './BrowserRunReportCard';
import ChapterRail from './ChapterRail';
import ChapterMenu from './ChapterMenu';
import { activeChapterIndex, deriveChapters, shouldShowRail, topVisibleGroup, type Chapter, type RowPosition } from './chapters';
import { isCompactBoundary } from '@/core/context/compactBoundary';
import { isBrowserRunReportMessage } from '@/core/observability/browserRunReport';
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
import { windowDragRowProps } from '@/utils/windowDrag';
import { Input } from '@/components/ui/input';
import UsageChip from './UsageChip';
import { shouldShowTypingIndicator } from './typingIndicator';
import { groupMessagesByLoop } from './messageGrouping';
import { ThinkingStatusLine, AssistantRowAvatar } from './ThinkingStatusLine';
import {
  VIRTUOSO_ITEM_TRAILING_PAD,
  TYPING_FOOTER_GAP_COMPENSATION,
} from './chatSpacing';
import { emitChatScrollTrace, type ChatScrollFollowSource } from './chatScrollTrace';
import {
  announceChatTurnScrollIntent,
  subscribeChatTurnScrollIntent,
} from './chatTurnScrollIntent';
import {
  VIRTUOSO_AT_BOTTOM_THRESHOLD_PX,
  armTurnScrollAnchor,
  canArmTurnScrollAnchor,
  exitTurnScrollAnchor,
  findUserMessageAnchor,
  getAnchorScrollCorrection,
  isAtBottomFromGeometry,
  isChapterRailAtBottom,
  reclaimTurnSpacerSurplus,
  reconcileTurnScrollAnchor,
  selectLatestUserAnchor,
  shouldFollowOutput,
  type TurnScrollAnchor,
  type TurnScrollAnchorExitReason,
} from './turnScrollAnchor';

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
  registerTurnSpacer: (element: HTMLDivElement | null) => void;
}

// Row wrapper for each virtualized message group. Spacing between groups
// MUST be padding, not margin (react-virtuoso guidance: margins on measured
// rows break height measurement/collapse behavior), so this replaces the
// previous `space-y-5` (margin) gap with a padding-bottom
// (VIRTUOSO_ITEM_TRAILING_PAD in chatSpacing.ts) applied
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
  <div {...props} className={VIRTUOSO_ITEM_TRAILING_PAD}>
    {children}
  </div>
);

// Typing indicator, rendered after the last message group via Virtuoso's
// `Footer` slot so it stays part of the scrollable/measured content (needed
// for stick-to-bottom behavior).
const VirtuosoTypingFooter: NonNullable<Components<Message[], MessageListContext>['Footer']> = ({
  context,
}) => {
  // Layout mirrors a MessageGroup's assistant row (shared AssistantRowAvatar,
  // gap-3, shared ThinkingStatusLine) so the hand-off from this footer to the
  // real assistant placeholder — and then to the TaskBlock header / "用时
  // Xs" fold header — keeps the label on the same baseline at the same size
  // instead of hopping between typographies ("错行"). The negative top margin
  // bridges the item-pad vs in-group-gap difference — see chatSpacing.ts.
  return (
    <>
      {context?.showTypingIndicator && (
        <div className={cn(TYPING_FOOTER_GAP_COMPENSATION, 'flex gap-3')}>
          <AssistantRowAvatar />
          <ThinkingStatusLine label={context.retryingLabel ?? context.thinkingLabel} />
        </div>
      )}
      <div
        ref={context?.registerTurnSpacer}
        data-turn-bottom-spacer
        aria-hidden="true"
        style={{ height: 0 }}
      />
    </>
  );
};

interface PendingTurnAnchor {
  conversationId: string;
  previousMessageId: string | null;
  /** Follow events this pending gate may still suppress before self-clearing. */
  suppressionBudget: number;
}

const TURN_ANCHOR_TARGET_TOP_PX = 20;
// An announced intent whose dispatch fails (message never persisted) leaves no
// owner to clear the pending gate, and the arm effect's frame timeout never
// starts. Budget how many follow events the gate may eat: a successful arm
// clears pending within a couple of height events, so a spent budget can only
// mean the turn never materialized.
const PENDING_TURN_ANCHOR_SUPPRESSION_BUDGET = 30;

function syncElementToBottom(element: HTMLElement): number {
  const previousScrollTop = element.scrollTop;
  element.scrollTop = element.scrollHeight;
  return element.scrollTop - previousScrollTop;
}

// Declared at module scope (not inline in the component) — react-virtuoso
// requires stable `components` object/function references, otherwise it
// remounts its internal list machinery on every ChatView render.
const virtuosoComponents: Components<Message[], MessageListContext> = {
  Item: VirtuosoMessageItem,
  Footer: VirtuosoTypingFooter,
};

interface ChatViewProps {
  windowsWorkspaceHeader?: boolean;
  rightPanelToggleVisible?: boolean;
}

export default function ChatView({
  windowsWorkspaceHeader = false,
  rightPanelToggleVisible = false,
}: ChatViewProps) {
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
  const isEnterprise = useEnterpriseStore((s) => s.mode.kind !== 'personal');
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
  // Mirrors Virtuoso's own atBottomStateChange callback. Geometry-sensitive
  // exits update this from the real distance instead of forcing a stale value.
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Active-turn geometry is intentionally transient and ref-backed. Streamed
  // tokens can resize the final Virtuoso row several times per frame; mirroring
  // those measurements through React state would add another render/measure
  // loop on top of Virtuoso's own one.
  const turnAnchorRef = useRef<TurnScrollAnchor | null>(null);
  const pendingTurnAnchorRef = useRef<PendingTurnAnchor | null>(null);
  const turnSpacerElementRef = useRef<HTMLDivElement | null>(null);
  const turnSpacerHeightRef = useRef(0);
  /** scrollHeight the last spacer-surplus reclaim expects once Virtuoso
   *  applies the shrink — further reclaims wait for this catch-up because the
   *  measured gap is stale until then (see reclaimTurnSpacerSurplus). */
  const reclaimSettleScrollHeightRef = useRef<number | null>(null);
  const armAnchorRafRef = useRef(0);
  const runningConversationRef = useRef<string | null>(null);
  const dismissedTurnAnchorRef = useRef<{ conversationId: string; messageId: string } | null>(null);
  const writeTurnSpacerHeight = useCallback((height: number) => {
    const nextHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
    turnSpacerHeightRef.current = nextHeight;
    const element = turnSpacerElementRef.current;
    if (!element) return;
    element.style.height = `${nextHeight}px`;
    element.dataset.spacerHeight = String(nextHeight);
  }, []);
  const writeTurnSpacerWithCompensation = useCallback((
    element: HTMLElement | null,
    height: number,
    mode: 'preserve-position' | 'sync-bottom',
  ) => {
    const previousHeight = turnSpacerHeightRef.current;
    const previousScrollTop = element?.scrollTop ?? 0;
    writeTurnSpacerHeight(height);
    if (!element || height !== 0 || previousHeight === 0) return;

    // Clearing physical spacer can clamp scrollTop immediately. Pair the DOM
    // write with an explicit scroll decision in this layout pass so no later
    // Virtuoso height callback can deliver the old one-frame hard jump.
    void element.scrollHeight;
    if (mode === 'sync-bottom') {
      element.scrollTop = element.scrollHeight;
      return;
    }
    const maximumScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.min(previousScrollTop, maximumScrollTop);
  }, [writeTurnSpacerHeight]);
  const registerTurnSpacer = useCallback((element: HTMLDivElement | null) => {
    turnSpacerElementRef.current = element;
    if (!element) return;
    element.style.height = `${turnSpacerHeightRef.current}px`;
    element.dataset.spacerHeight = String(turnSpacerHeightRef.current);
  }, []);
  const readTurnSpacerHeight = useCallback(() => {
    const element = turnSpacerElementRef.current;
    return element ? element.getBoundingClientRect().height : turnSpacerHeightRef.current;
  }, []);
  const measureActiveTailHeight = useCallback((anchorElement: HTMLElement) => {
    const messageRow = anchorElement.closest<HTMLElement>('[data-index]');
    const spacerElement = turnSpacerElementRef.current;
    if (!messageRow || !spacerElement) return null;
    // Both values come from the same painted coordinate space. Unlike
    // Virtuoso's total-height callback versus the scroll parent's scrollHeight,
    // their difference cannot feed the spacer's own height back into the next
    // measurement. The spacer's top also captures footer/typing hand-offs while
    // excluding the spacer height itself.
    return Math.max(
      0,
      spacerElement.getBoundingClientRect().top - messageRow.getBoundingClientRect().top,
    );
  }, []);
  const reconcileActiveTurnGeometry = useCallback((el: HTMLElement, totalListHeight?: number) => {
    const anchor = turnAnchorRef.current;
    if (anchor?.phase !== 'armed') return;
    const anchorElement = findUserMessageAnchor(el, anchor.messageId);
    const contentHeight = anchorElement ? measureActiveTailHeight(anchorElement) : null;
    const reconciled = reconcileTurnScrollAnchor(anchor, {
      contentHeight: contentHeight ?? anchor.baselineContentHeight,
      anchorPresent: anchorElement != null,
    });
    turnAnchorRef.current = reconciled.anchor;
    if (reconciled.handoff === 'sync-bottom') {
      const previousScrollTop = el.scrollTop;
      writeTurnSpacerWithCompensation(el, 0, 'sync-bottom');
      emitChatScrollTrace('turn-anchor', 'applied', el, {
        totalListHeight,
        scrollDelta: el.scrollTop - previousScrollTop,
        spacerHeight: 0,
        contentHeight: reconciled.contentHeight,
        baselineContentHeight: anchor.baselineContentHeight,
      });
      updatePinned(true);
      setIsAtBottom(true);
      return;
    }
    writeTurnSpacerHeight(reconciled.spacerHeight);
    if (!anchorElement) return;

    const currentTop = anchorElement.getBoundingClientRect().top - el.getBoundingClientRect().top;
    const correction = getAnchorScrollCorrection(anchor.targetTop, currentTop);
    if (correction !== 0) {
      const previousScrollTop = el.scrollTop;
      emitChatScrollTrace('turn-anchor', 'scheduled', el, {
        totalListHeight,
        anchorTop: currentTop,
        spacerHeight: reconciled.spacerHeight,
        contentHeight: reconciled.contentHeight,
        baselineContentHeight: anchor.baselineContentHeight,
      });
      el.scrollTop += correction;
      emitChatScrollTrace('turn-anchor', 'applied', el, {
        totalListHeight,
        scrollDelta: el.scrollTop - previousScrollTop,
        anchorTop: anchorElement.getBoundingClientRect().top - el.getBoundingClientRect().top,
        spacerHeight: readTurnSpacerHeight(),
        contentHeight: measureActiveTailHeight(anchorElement) ?? undefined,
        baselineContentHeight: anchor.baselineContentHeight,
      });
    }

    // With the anchor pinned at targetTop, any scroll range still left below
    // is spacer ledger that never corresponded to missing range (the arm's
    // settlement spreads over frames — see reclaimTurnSpacerSurplus). Return
    // it by shrinking the spacer; the viewport does not move.
    const settled = turnAnchorRef.current;
    if (settled?.phase !== 'armed') return;
    if (reclaimSettleScrollHeightRef.current != null) {
      // The previous reclaim's shrink reaches scrollHeight only on Virtuoso's
      // next height pass; until then the measured gap still carries the
      // reclaimed pixels and re-reclaiming would drain the spacer.
      if (el.scrollHeight > reclaimSettleScrollHeightRef.current) return;
      reclaimSettleScrollHeightRef.current = null;
    }
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const reclaim = reclaimTurnSpacerSurplus(settled, distanceToBottom);
    if (reclaim.reclaimed === 0) return;
    reclaimSettleScrollHeightRef.current = el.scrollHeight - reclaim.reclaimed;
    turnAnchorRef.current = reclaim.anchor;
    if (reclaim.anchor.phase === 'exhausted') {
      const previousScrollTop = el.scrollTop;
      writeTurnSpacerWithCompensation(el, 0, 'sync-bottom');
      emitChatScrollTrace('turn-anchor', 'applied', el, {
        totalListHeight,
        scrollDelta: el.scrollTop - previousScrollTop,
        spacerHeight: 0,
        contentHeight: reconciled.contentHeight,
        baselineContentHeight: anchor.baselineContentHeight,
      });
      updatePinned(true);
      setIsAtBottom(true);
      return;
    }
    writeTurnSpacerHeight(reclaim.spacerHeight);
    emitChatScrollTrace('turn-anchor', 'applied', el, {
      totalListHeight,
      scrollDelta: 0,
      anchorTop: anchorElement.getBoundingClientRect().top - el.getBoundingClientRect().top,
      spacerHeight: readTurnSpacerHeight(),
      contentHeight: measureActiveTailHeight(anchorElement) ?? undefined,
      baselineContentHeight: reclaim.anchor.baselineContentHeight,
    });
  }, [
    measureActiveTailHeight,
    readTurnSpacerHeight,
    updatePinned,
    writeTurnSpacerHeight,
    writeTurnSpacerWithCompensation,
  ]);
  // Fade timer for the search-hit highlight. Kept in a ref (NOT an effect
  // cleanup) — consuming the pending jump re-runs the effect, and a cleanup
  // would cancel the fade, leaving the highlight stuck on.
  const highlightFadeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const leaveTurnAnchor = useCallback((reason: TurnScrollAnchorExitReason) => {
    const activeAnchor = turnAnchorRef.current;
    const state = useChatStore.getState();
    const activeConversationId = state.activeConversationId;
    const latestCandidate = activeConversationId
      ? selectLatestUserAnchor(
          activeConversationId,
          state.conversations[activeConversationId]?.messages ?? [],
        )
      : null;
    dismissedTurnAnchorRef.current = activeAnchor ?? latestCandidate;
    const exit = exitTurnScrollAnchor(turnAnchorRef.current, reason);
    turnAnchorRef.current = exit.anchor;
    pendingTurnAnchorRef.current = null;
    reclaimSettleScrollHeightRef.current = null;
    if (exit.spacerHeight === 0) {
      writeTurnSpacerWithCompensation(
        scrollParentEl,
        0,
        exit.pinned ? 'sync-bottom' : 'preserve-position',
      );
    } else {
      writeTurnSpacerHeight(exit.spacerHeight);
    }
    updatePinned(exit.pinned);
    if (reason === 'user-scroll-intent') {
      const element = scrollParentEl;
      const distanceToBottom = element
        ? element.scrollHeight - element.scrollTop - element.clientHeight
        : Number.POSITIVE_INFINITY;
      setIsAtBottom(isAtBottomFromGeometry(distanceToBottom));
    } else if (reason === 'search-jump' || reason === 'chapter-jump') {
      setIsAtBottom(false);
    } else {
      setIsAtBottom(true);
    }
  }, [scrollParentEl, updatePinned, writeTurnSpacerHeight, writeTurnSpacerWithCompensation]);
  // Message id to briefly highlight after a search-hit jump (see effect below).
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  // Index of the message group at the top of the viewport — what the chapter
  // rail highlights. Measured from the DOM (see the scroll-spy effect below).
  const [firstVisibleGroup, setFirstVisibleGroup] = useState(0);
  // Whether the transcript column leaves enough gutter to hold the rail.
  // Measured, not guessed from the viewport: the sidebar and the preview
  // panel both collapse this container without the window changing size.
  const [railFits, setRailFits] = useState(true);

  // Imperative stick-to-bottom: raw scrollTop assignment on the scroll parent,
  // deferred one frame. scrollToIndex is NOT reliable here — called during
  // Virtuoso's measurement storm, its target gets clobbered by Virtuoso's own
  // scroll compensation in the same cycle, and once measuring stops no further
  // event re-corrects the position. Raw scrollTop = scrollHeight bypasses
  // virtualization state entirely and always lands on the true bottom.
  const stickRafRef = useRef(0);
  const stickToBottom = useCallback((
    el: HTMLElement | null,
    source: Exclude<ChatScrollFollowSource, 'virtuoso-follow-output'>,
    totalListHeight?: number,
  ) => {
    if (!el) return;
    cancelAnimationFrame(stickRafRef.current);
    emitChatScrollTrace(source, 'scheduled', el, { totalListHeight });
    stickRafRef.current = requestAnimationFrame(() => {
      const previousScrollTop = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      emitChatScrollTrace(source, 'applied', el, {
        totalListHeight,
        scrollDelta: el.scrollTop - previousScrollTop,
      });
    });
  }, []);

  const scrollToLatest = useCallback((behavior: 'smooth' | 'auto' = 'smooth') => {
    // Explicit "go to bottom" — re-engage the bottom lock.
    leaveTurnAnchor('explicit-latest');
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior });
    // Optimistic — atBottomStateChange will confirm once the scroll settles.
    setIsAtBottom(true);
  }, [leaveTurnAnchor]);

  const prepareTurnAnchorIntent = useCallback((conversationId: string) => {
    const state = useChatStore.getState();
    if (state.activeConversationId !== conversationId) return;
    const conversation = state.conversations[conversationId];
    // A composer send during an active run is only staged. Keep the current
    // anchor until the queue actually persists its own user row; message-id
    // rebinding below will then hand ownership to that turn.
    if (conversation?.status === 'running') return;
    const previousAnchor = selectLatestUserAnchor(conversationId, conversation?.messages ?? []);
    leaveTurnAnchor('explicit-latest');
    pendingTurnAnchorRef.current = {
      conversationId,
      previousMessageId: previousAnchor?.messageId ?? null,
      suppressionBudget: PENDING_TURN_ANCHOR_SUPPRESSION_BUDGET,
    };
  }, [leaveTurnAnchor]);

  useEffect(() => subscribeChatTurnScrollIntent((intent) => {
    prepareTurnAnchorIntent(intent.conversationId);
  }), [prepareTurnAnchorIntent]);

  useEffect(() => {
    const observeTerminalState = () => {
      const state = useChatStore.getState();
      const conversationId = state.activeConversationId;
      const status = conversationId ? state.conversations[conversationId]?.status : undefined;
      if (conversationId && status === 'running') {
        runningConversationRef.current = conversationId;
        return;
      }
      if (conversationId && runningConversationRef.current === conversationId) {
        runningConversationRef.current = null;
        // User/navigation exits already terminated the anchor. Preserve their
        // frozen spacer and viewport ownership when the background run later
        // reaches idle; terminal cleanup is only for a still-live lifecycle.
        if (
          turnAnchorRef.current != null
          || pendingTurnAnchorRef.current?.conversationId === conversationId
        ) {
          leaveTurnAnchor('run-terminal');
        }
      }
    };
    observeTerminalState();
    return useChatStore.subscribe(observeTerminalState);
  }, [leaveTurnAnchor]);

  // Conversation switch: engage the bottom lock (unless a search jump is about
  // to position the view on a hit) and reset the jump-button state so it doesn't
  // flash with the previous conversation's scrolled-up state. Layout effect —
  // must apply before paint or the stale unpinned/not-at-bottom state from the
  // previous conversation paints for one frame (the button flash).
  useLayoutEffect(() => {
    const jumpPending = useChatStore.getState().pendingSearchJump?.convId === activeConvId;
    leaveTurnAnchor(jumpPending ? 'search-jump' : 'conversation-switch');
    updatePinned(!jumpPending);
    setIsAtBottom(true);
    if (pinnedRef.current) stickToBottom(scrollParentEl, 'conversation-switch');
  }, [activeConvId, leaveTurnAnchor, scrollParentEl, stickToBottom, updatePinned]);

  // The rail lives inside the transcript column's own left padding (40px from
  // `md:px-10`, which any desktop viewport gets), and is 26px wide at its
  // furthest. So it fits at essentially every pane width — this gate only
  // catches a pane squeezed so far that the ticks would crowd the text, and
  // then the header button takes over as the way into the chapter list.
  //
  // An earlier 940px gate came from measuring the gutter between the WINDOW and
  // the column instead; that was the wrong frame of reference and hid the rail
  // on ordinary layouts.
  useEffect(() => {
    if (!scrollParentEl) return;
    const measure = () => setRailFits(scrollParentEl.clientWidth >= 640);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scrollParentEl);
    return () => observer.disconnect();
  }, [scrollParentEl]);

  // Scroll-spy for the chapter rail.
  //
  // Virtuoso's `rangeChanged` looks like the signal for this and is not: it is
  // derived from `listState.items`, the RENDERED range, which includes the
  // 900px of overscan `increaseViewportBy` adds above the viewport. Any
  // conversation shorter than viewport + 1800px therefore renders every row at
  // once and reports startIndex 0 forever — the rail would pin to the first
  // chapter and never move, whatever the user scrolled.
  //
  // Real geometry instead. Virtuoso stamps `data-index` on every rendered row,
  // and the row occupying the top of the viewport is by definition rendered,
  // so reading the last row whose top has passed the viewport's is exact at
  // any scroll speed — which an IntersectionObserver on chapter starts would
  // not be, since those rows unmount once they are far enough away.
  useEffect(() => {
    if (!scrollParentEl) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const viewportTop = scrollParentEl.getBoundingClientRect().top;
      const rows: RowPosition[] = [];
      for (const row of scrollParentEl.querySelectorAll<HTMLElement>('[data-index]')) {
        rows.push({ index: Number(row.dataset.index), top: row.getBoundingClientRect().top - viewportTop });
      }
      // Resting at the bottom is its own case — see `topVisibleGroup`. Measured
      // here rather than read off `isAtBottom`, which is React state one render
      // behind and would leave the rail a frame stale on every scroll.
      const distanceToBottom =
        scrollParentEl.scrollHeight - scrollParentEl.scrollTop - scrollParentEl.clientHeight;
      setFirstVisibleGroup(topVisibleGroup(rows, {
        atBottom: isChapterRailAtBottom(
          distanceToBottom,
          turnAnchorRef.current,
          pinnedRef.current,
        ),
      }));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };
    // Also measure now: mounting lands on the newest message without any
    // scroll event of its own, and the rail must start on the LAST chapter.
    frame = requestAnimationFrame(measure);
    scrollParentEl.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scrollParentEl.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [scrollParentEl, activeConvId, messageCount]);

  // Any explicit scrolling gesture owns the viewport. While anchored that
  // includes downward wheel/keys and native scrollbar drags; otherwise only an
  // upward gesture releases the ordinary bottom lock.
  useEffect(() => {
    if (!scrollParentEl) return;
    const hasTransientAnchor = () => (
      turnAnchorRef.current != null
      || pendingTurnAnchorRef.current?.conversationId === activeConvId
    );
    const unpin = () => leaveTurnAnchor('user-scroll-intent');
    const onWheel = (event: WheelEvent) => {
      if ((hasTransientAnchor() && event.deltaY !== 0) || event.deltaY < 0) unpin();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement
        && target.matches('input, textarea, [contenteditable="true"]')
      ) return;
      const navigationKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
      if (!navigationKeys.has(event.key)) return;
      const upwardKeys = new Set(['ArrowUp', 'PageUp', 'Home']);
      if (hasTransientAnchor() || upwardKeys.has(event.key)) unpin();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!hasTransientAnchor()) return;
      const rect = scrollParentEl.getBoundingClientRect();
      const scrollbarWidth = Math.max(16, scrollParentEl.offsetWidth - scrollParentEl.clientWidth);
      if (event.clientX >= rect.right - scrollbarWidth) unpin();
    };
    scrollParentEl.addEventListener('wheel', onWheel, { passive: true });
    scrollParentEl.addEventListener('touchmove', unpin, { passive: true });
    scrollParentEl.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      scrollParentEl.removeEventListener('wheel', onWheel);
      scrollParentEl.removeEventListener('touchmove', unpin);
      scrollParentEl.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, [activeConvId, leaveTurnAnchor, scrollParentEl]);

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
      (m) => (!m.isSystem || m.isRecoveryNotice)
        && getMessageText(m.content).toLowerCase().includes(q),
    );
    // Consume regardless of match so a missing target doesn't retry forever.
    useChatStore.getState().setPendingSearchJump(null);
    if (!target) return;
    const groups = groupMessagesByLoop(
      conv.messages.filter((m) => !m.isSystem || m.isRecoveryNotice),
    );
    const index = groups.findIndex((g) => g.some((m) => m.id === target.id));
    if (index < 0) return;
    // Release the bottom lock so late height-measurements don't yank the view
    // from the hit back to the bottom.
    leaveTurnAnchor('search-jump');
    setHighlightedMessageId(target.id);
    // Defer a frame so Virtuoso (freshly remounted via `key`) is mounted and can
    // resolve the index before we scroll.
    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index, align: 'center', behavior: 'auto' });
    });
    clearTimeout(highlightFadeTimerRef.current);
    highlightFadeTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 2600);
  }, [pendingSearchJump, activeConvId, leaveTurnAnchor, messageCount]);

  const handleSend = async (
    text: string,
    images?: ImageAttachment[],
    workspacePath?: string | null,
    onAccepted?: () => void,
  ) => {
    // Block sending if API key is not configured (Ollama doesn't need one).
    // Returning false hands the text back to the composer — opening settings
    // used to swallow whatever the user had typed.
    const currentState = useSettingsStore.getState();
    if (!isEnterprise && providerRequiresApiKey(currentState) && !getActiveApiKey(currentState)?.trim()) {
      currentState.openSystemSettings('ai-services');
      return false;
    }

    if (text.trim() === '/compact') {
      const convId = activeConv?.id;
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

    let convId = activeConv?.id;
    const isNewConversation = !convId;
    if (!convId) {
      convId = createConversation(workspacePath);
    }
    if (isNewConversation && !useSettingsStore.getState().sidebarCollapsed) {
      useSettingsStore.getState().toggleSidebar();
    }
    // Re-enable follow + jump to the new message. Virtuoso measures the
    // freshly-appended item on its own next render, so this doesn't need to
    // wait for a DOM mutation callback the way the old MutationObserver did.
    scrollToLatest('auto');
    // Suppress both legacy bottom-follow paths during the gap between dispatch
    // and the new persisted user row mounting. Child Virtuoso layout effects
    // can report the new total height before ChatView's parent layout effect
    // has had a chance to arm the DOM anchor.
    announceChatTurnScrollIntent({ conversationId: convId, source: 'composer' });
    let dispatch: AgentLoopDispatchResult;
    try {
      dispatch = await runAgentLoopDispatched(convId, text, {
        images,
        onMessageTaken: () => onAccepted?.(),
        // A human typed this — attended, even inside a scheduled/trigger
        // conversation (the browser gate offers dialogs on that basis).
        initiatedBy: 'user',
      });
    } catch (error) {
      // The runner deliberately keeps persistence/transport failures as
      // rejections for non-UI callers. Once it has appended the user message,
      // however, the failed transcript row (and its Retry action) owns
      // recovery; handing the same text back to ChatInput would duplicate it.
      if (!(error instanceof AgentLoopDispatchError) || !error.messageTaken) {
        pendingTurnAnchorRef.current = null;
        throw error;
      }
      useToastStore.getState().addToast({
        type: 'error',
        title: error.message || t.chat.conversationBusy,
      });
      return;
    }
    // A rejected dispatch (conversation busy, attachment mid-run) used to be
    // discarded here: the composer had already cleared, so the text and any
    // images simply vanished with no feedback. Surface it and hand the draft
    // back instead.
    if (dispatch?.reason === 'error') {
      if (!dispatch.messageTaken) pendingTurnAnchorRef.current = null;
      useToastStore.getState().addToast({
        type: 'error',
        title: dispatch.error || t.chat.conversationBusy,
      });
      if (shouldRestoreComposerAfterDispatch(dispatch)) {
        return false;
      }
    }
  };


  // First-run banner: show when no provider has been configured yet.
  // "Configured" = has an API key OR is a keyless provider (ollama/lmstudio).
  const needsPersonalModelSetup = useSettingsStore((s) => {
    return !s.providers.some(
      p => p.apiKey.trim().length > 0 || p.id === 'ollama' || p.id === 'lmstudio'
    );
  });
  const needsSetup = !isEnterprise && needsPersonalModelSetup;

  // Scenario guide state — lifted here so ChatInput can receive the custom placeholder
  const [scenarioPlaceholder, setScenarioPlaceholder] = useState<string | null>(null);
  const [guideVisible, setGuideVisible] = useState(true);
  // Optimistic feedback for the beat between submitting a question/plan answer
  // and the resumed loop producing anything (Bug 1: 点同意后无反应).
  const [resuming, setResuming] = useState(false);
  const agentStatus = useChatStore((s) => getConversationAgentState(s.agentStates, activeConvId).status);
  const retryInfo = useChatStore((s) => getConversationAgentState(s.agentStates, activeConvId).retryInfo);

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

  // Message projection for the list. Computed above the early returns below
  // so the hooks that depend on it stay unconditional (rules-of-hooks).
  // Filter out internal system prompts while retaining explicit crash
  // recovery notices that explain an interrupted task to the user.
  const visibleMessages = messages.filter(m => !m.isSystem || m.isRecoveryNotice);
  const messageGroups = groupMessagesByLoop(visibleMessages);
  useLayoutEffect(() => {
    if (!scrollParentEl || !activeConvId) return;
    const conversation = useChatStore.getState().conversations[activeConvId];
    const candidate = selectLatestUserAnchor(activeConvId, conversation?.messages ?? []);
    if (!candidate) return;
    const dismissed = dismissedTurnAnchorRef.current;
    if (
      dismissed?.conversationId === candidate.conversationId
      && dismissed.messageId === candidate.messageId
    ) return;
    let pending = pendingTurnAnchorRef.current;
    const activeAnchor = turnAnchorRef.current;
    // Queue auto-handoff happens inside the runner, without another UI click.
    // A new persisted user id during a live run is therefore the authoritative
    // rebind signal even when no explicit pending intent exists.
    if (
      conversation?.status === 'running'
      && activeAnchor?.messageId !== candidate.messageId
      && pending?.conversationId !== activeConvId
    ) {
      pending = {
        conversationId: activeConvId,
        previousMessageId: activeAnchor?.messageId ?? null,
        suppressionBudget: PENDING_TURN_ANCHOR_SUPPRESSION_BUDGET,
      };
      pendingTurnAnchorRef.current = pending;
    }
    if (pending?.conversationId !== activeConvId || candidate.messageId === pending.previousMessageId) return;

    let attempts = 0;
    const tryArm = () => {
      armAnchorRafRef.current = 0;
      const anchorElement = findUserMessageAnchor(scrollParentEl, candidate.messageId);
      const contentHeight = anchorElement ? measureActiveTailHeight(anchorElement) : null;
      if (!anchorElement || contentHeight == null) {
        attempts += 1;
        if (attempts < 8) {
          armAnchorRafRef.current = requestAnimationFrame(tryArm);
        } else {
          // A virtualized/unmounted candidate must not leave followOutput gated
          // forever. Abandoning is a complete state transition.
          leaveTurnAnchor('arm-abandoned');
        }
        return;
      }

      const anchorHeight = anchorElement.getBoundingClientRect().height;
      if (!canArmTurnScrollAnchor({
        anchorHeight,
        viewportHeight: scrollParentEl.clientHeight,
        targetTop: TURN_ANCHOR_TARGET_TOP_PX,
      })) {
        leaveTurnAnchor('arm-abandoned');
        return;
      }

      pendingTurnAnchorRef.current = null;
      dismissedTurnAnchorRef.current = null;
      const viewportTop = scrollParentEl.getBoundingClientRect().top;
      const anchorTop = anchorElement.getBoundingClientRect().top - viewportTop;
      const distanceToBottom =
        scrollParentEl.scrollHeight - scrollParentEl.scrollTop - scrollParentEl.clientHeight;
      const anchor = armTurnScrollAnchor({
        ...candidate,
        anchorTop,
        targetTop: TURN_ANCHOR_TARGET_TOP_PX,
        distanceToBottom,
        contentHeight,
      });
      turnAnchorRef.current = anchor;
      reclaimSettleScrollHeightRef.current = null;
      const previousScrollTop = scrollParentEl.scrollTop;
      emitChatScrollTrace('turn-anchor', 'scheduled', scrollParentEl, {
        anchorTop,
        spacerHeight: anchor.spacerHeight,
        contentHeight: anchor.baselineContentHeight,
        baselineContentHeight: anchor.baselineContentHeight,
      });
      // Route through the compensated writer: on a queue rebind the previous
      // anchor's spacer may still be non-zero, and writing 0 bare would clamp
      // scrollTop before the arm's own scroll math runs.
      writeTurnSpacerWithCompensation(scrollParentEl, anchor.spacerHeight, 'preserve-position');
      // Force the spacer write into this layout pass so the initial anchor move
      // and its newly available scroll range land before paint.
      void scrollParentEl.scrollHeight;
      const maximumScrollTop = Math.max(0, scrollParentEl.scrollHeight - scrollParentEl.clientHeight);
      scrollParentEl.scrollTop = Math.min(
        maximumScrollTop,
        scrollParentEl.scrollTop + anchor.initialScrollDelta,
      );
      const mountedAnchor = findUserMessageAnchor(scrollParentEl, candidate.messageId);
      if (mountedAnchor) {
        const currentTop = mountedAnchor.getBoundingClientRect().top - viewportTop;
        scrollParentEl.scrollTop += getAnchorScrollCorrection(anchor.targetTop, currentTop);
      }
      emitChatScrollTrace('turn-anchor', 'applied', scrollParentEl, {
        scrollDelta: scrollParentEl.scrollTop - previousScrollTop,
        anchorTop: mountedAnchor
          ? mountedAnchor.getBoundingClientRect().top - viewportTop
          : undefined,
        spacerHeight: readTurnSpacerHeight(),
        contentHeight: mountedAnchor ? measureActiveTailHeight(mountedAnchor) ?? undefined : undefined,
        baselineContentHeight: anchor.baselineContentHeight,
      });
      if (anchor.phase === 'exhausted') {
        // Born-exhausted arm (no absorption capacity): hand off to bottom in
        // this same layout pass. The compensated writer above has already put
        // the ref at 0, so its previousHeight guard can never fire here —
        // sync the scroll explicitly instead of relying on it.
        void scrollParentEl.scrollHeight;
        scrollParentEl.scrollTop = scrollParentEl.scrollHeight;
      }
    };

    tryArm();
    return () => cancelAnimationFrame(armAnchorRafRef.current);
  }, [
    activeConvId,
    leaveTurnAnchor,
    measureActiveTailHeight,
    messageCount,
    readTurnSpacerHeight,
    scrollParentEl,
    writeTurnSpacerHeight,
    writeTurnSpacerWithCompensation,
  ]);
  useLayoutEffect(() => {
    const activeAnchor = turnAnchorRef.current;
    if (!scrollParentEl || activeAnchor?.phase !== 'armed') return;
    const anchorElement = findUserMessageAnchor(scrollParentEl, activeAnchor.messageId);
    const messageRow = anchorElement?.closest<HTMLElement>('[data-index]');
    if (!messageRow) return;

    const observer = new ResizeObserver(() => {
      // ResizeObserver runs after layout and before paint. Reading geometry
      // again here closes the same-frame loop: the growing message row and the
      // shrinking spacer are presented as one constant-height transaction to
      // Virtuoso instead of two visible total-height changes.
      reconcileActiveTurnGeometry(scrollParentEl);
    });
    observer.observe(messageRow);
    return () => observer.disconnect();
  }, [
    activeConvId,
    messageCount,
    reconcileActiveTurnGeometry,
    scrollParentEl,
  ]);
  useLayoutEffect(() => {
    if (scrollParentEl) reconcileActiveTurnGeometry(scrollParentEl);
  });
  // Derived from the very array Virtuoso renders, so a chapter's groupIndex is
  // always a valid scroll target — deriving from `messages` instead would let
  // the two drift the next time grouping rules change.
  //
  // Deliberately not memoized: `messageGroups` is a fresh array on every render
  // (the filter above already is), so a useMemo keyed on it would recompute
  // every time anyway while costing an extra dependency array to keep honest.
  // The walk is O(groups) and sits next to `groupMessagesByLoop`, which is
  // unmemoized for the same reason.
  const chapters = deriveChapters(messageGroups, t.chat.chapters.sessionStart);
  const currentChapter = activeChapterIndex(chapters, firstVisibleGroup);
  // One or two ticks navigate nothing — the conversation is already on screen.
  const chapterNavVisible = shouldShowRail(chapters);

  // Same landing behaviour as a search hit: release the bottom lock (so a late
  // height measurement cannot yank the view back down) and flash the target so
  // the eye finds where it arrived. Unlike a search hit the chapter is aligned
  // to the top, not centred — a chapter is read forwards from its first
  // message, and centring would hide the turn that opens it above the fold.
  const jumpToChapter = useCallback((chapter: Chapter) => {
    leaveTurnAnchor('chapter-jump');
    setHighlightedMessageId(chapter.messageId);
    virtuosoRef.current?.scrollToIndex({ index: chapter.groupIndex, align: 'start', behavior: 'auto' });
    clearTimeout(highlightFadeTimerRef.current);
    highlightFadeTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 2600);
  }, [leaveTurnAnchor]);

  // Shared by handleFollowOutput / handleTotalListHeightChanged (they must
  // agree, or one path re-enables the bottom-pin the other is holding off).
  const shouldSuppressLegacyFollow = useCallback(() => {
    const pending = pendingTurnAnchorRef.current;
    if (pending?.conversationId === activeConvId) {
      pending.suppressionBudget -= 1;
      if (pending.suppressionBudget > 0) return true;
      // Spent budget: the announced turn never persisted (failed dispatch).
      // Drop the gate so ordinary bottom-follow recovers on this very event.
      pendingTurnAnchorRef.current = null;
      return false;
    }
    if (!activeConvId) return false;
    const conversation = useChatStore.getState().conversations[activeConvId];
    const newest = selectLatestUserAnchor(activeConvId, conversation?.messages ?? []);
    return Boolean(
      conversation?.status === 'running'
      && newest
      && turnAnchorRef.current?.messageId !== newest.messageId
      && !(
        dismissedTurnAnchorRef.current?.conversationId === newest.conversationId
        && dismissedTurnAnchorRef.current.messageId === newest.messageId
      ),
    );
  }, [activeConvId]);

  const handleFollowOutput = useCallback((atBottom: boolean) => {
    emitChatScrollTrace('virtuoso-follow-output', 'decision', scrollParentEl, { atBottom });
    if (shouldSuppressLegacyFollow()) return false;
    return shouldFollowOutput(turnAnchorRef.current);
  }, [shouldSuppressLegacyFollow, scrollParentEl]);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setIsAtBottom(atBottom);
    if (!atBottom) return;
    if (turnAnchorRef.current?.phase === 'armed') {
      updatePinned(true);
      return;
    }
    // A user who naturally scrolls through a frozen, post-unpin spacer has
    // explicitly reached "latest" again. Remove that transient tail and restore
    // the ordinary pinned/follow contract in one state transition.
    if (turnSpacerHeightRef.current > 0) {
      leaveTurnAnchor('explicit-latest');
      return;
    }
    updatePinned(true);
  }, [leaveTurnAnchor, updatePinned]);

  const handleTotalListHeightChanged = useCallback((height: number) => {
    const el = scrollParentEl;
    if (!el) return;
    if (shouldSuppressLegacyFollow()) return;

    const activeAnchor = turnAnchorRef.current;
    if (activeAnchor?.phase === 'armed') {
      reconcileActiveTurnGeometry(el, height);
      return;
    }
    if (activeAnchor?.phase === 'exhausted' && pinnedRef.current) {
      // Exhaustion is a handoff phase, not permission to reintroduce the old
      // deferred total-height correction. Keep bottom geometry synchronized in
      // this callback until the run terminal clears the transient anchor.
      emitChatScrollTrace('turn-anchor', 'scheduled', el, {
        totalListHeight: height,
        spacerHeight: 0,
      });
      const scrollDelta = syncElementToBottom(el);
      emitChatScrollTrace('turn-anchor', 'applied', el, {
        totalListHeight: height,
        scrollDelta,
        spacerHeight: 0,
      });
      return;
    }

    if (!pinnedRef.current) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 2) {
      stickToBottom(el, 'total-list-height', height);
    }
  }, [
    reconcileActiveTurnGeometry,
    scrollParentEl,
    shouldSuppressLegacyFollow,
    stickToBottom,
  ]);

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
        {/* The welcome screen has no header row, so it gets the same 44px drag
            band the conversation view's title row provides. In flow, never
            overlaying, so it cannot cover the scroller underneath. */}
        <div {...windowDragRowProps()} className="shrink-0 h-11" />
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

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0 bg-[var(--abu-bg-base)]">
      {/* Conversation title header — flush at card top (TRAE-style header row).
          The divider separates navigation context from the conversation body;
          platform overlays receive only the padding needed by existing controls. */}
      <div {...windowDragRowProps()} className={cn(
        'shrink-0 flex items-center h-11 px-4',
        windowsWorkspaceHeader && 'border-b border-[var(--abu-border)]',
        // Collapsed platform controls float over the card's top-left; indent
        // the title to clear the controls present on that platform.
        sidebarCollapsed && isMacOS() && 'pl-48',
        sidebarCollapsed && windowsWorkspaceHeader && 'pl-20',
        rightPanelToggleVisible && windowsWorkspaceHeader && 'pr-12',
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
        {/* Chapter navigation moves into the header exactly when the gutter can
            no longer hold the rail, so the two never appear at once. */}
        {chapterNavVisible && !railFits && (
          <ChapterMenu chapters={chapters} currentIndex={currentChapter} onJump={jumpToChapter} />
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
      {/* The stopped conversation is the one that OWNS the CU session (passed
          up by the bar), NOT `activeConv.id` — a background conversation can be
          driving the screen while an unrelated tab is open. See the component. */}
      <ComputerUseStatusBar onStop={(conversationId) => useChatStore.getState().cancelStreaming(conversationId)} />

      {/* Messages Area — overlay-scroll hides the native scrollbar (thumb shows
          only while scrolling, via the global is-scrolling toggle in main.tsx);
          overflow-y-scroll (not auto) keeps the transparent gutter always
          reserved so opening the preview panel doesn't flash a scrollbar and
          shift the content. Both were lost in the Virtuoso-list merge — do not
          drop them again. */}
      <div className="relative flex-1 min-h-0 overflow-y-scroll overlay-scroll" ref={setScrollParentEl}>
        {chapterNavVisible && railFits && (
          <ChapterRail chapters={chapters} currentIndex={currentChapter} onJump={jumpToChapter} />
        )}
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
            followOutput={handleFollowOutput}
            atBottomStateChange={handleAtBottomStateChange}
            atBottomThreshold={VIRTUOSO_AT_BOTTOM_THRESHOLD_PX}
            // The bottom lock: whenever late-measured content (widget iframes,
            // images, charts) changes the total list height while the user is
            // pinned, re-stick to the newest message. Event-driven — replaces
            // any "scroll again after N ms" guesswork.
            //
            // Gated on an actual gap from the bottom: `followOutput="auto"`
            // already re-sticks on ordinary content growth (e.g. streamed
            // thinking/answer tokens, which fire this callback many times a
            // second), so an unconditional raw `scrollTop = scrollHeight` here
            // raced it every frame — two independent corrections computed from
            // slightly different scrollHeight snapshots, which read as the
            // answer pane jittering up/down while streaming. Only step in when
            // followOutput hasn't already closed the gap (its actual target
            // case: content whose size resolves after layout, like images/
            // iframes finishing their own async measurement).
            totalListHeightChanged={handleTotalListHeightChanged}
            // Keep ~one viewport of rows mounted above/below the visible window.
            // Rows still virtualize (far-off messages stay unmounted), but this
            // widens the live band so inline iframe widgets (HtmlWidgetBlock)
            // survive the small scroll jitter of normal reading without the
            // srcdoc reload + in-widget JS state reset that a bare unmount causes.
            increaseViewportBy={{ top: 900, bottom: 900 }}
            context={{
              // Covers the gap before the next assistant placeholder is created.
              // This occurs both on a normal send and when a staged queue item
              // is consumed after earlier assistant turns already exist.
              showTypingIndicator: shouldShowTypingIndicator(activeConv?.status, visibleMessages),
              retryingLabel: retryInfo
                ? format(t.chat.retrying, { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })
                : null,
              // status.thinking ("思考中", no trailing ellipsis) — the same
              // string the in-group placeholder shows and the TaskBlock active
              // header reduces to (it strips the ellipsis). chat.thinking
              // ("思考中…") here made the "…" blink out at the footer →
              // placeholder hand-off, and reads odd before the animated dots.
              thinkingLabel: t.status.thinking,
              registerTurnSpacer,
            }}
            itemContent={(index, group) =>
              group.length === 1 && isCompactBoundary(group[0]) ? (
                <CompactDivider message={group[0]} />
              ) : group.length === 1 && isBrowserRunReportMessage(group[0]) ? (
                // U7 — the unattended run's report card. Its own group by
                // construction: the marker carries no loopId, and
                // `groupMessagesByLoop` starts a fresh group at every message
                // without one.
                <BrowserRunReportCard message={group[0]} />
              ) : (
                <MessageGroup
                  conversationId={activeConv.id}
                  messages={group}
                  isLastGroup={index === messageGroups.length - 1}
                  highlightMessageId={highlightedMessageId}
                />
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
