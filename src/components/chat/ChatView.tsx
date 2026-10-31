import { useState, useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore, useMemo } from 'react';
import { getConversationAgentState, useChatStore, useActiveConversation } from '@/stores/chatStore';
import type { Message, ImageAttachment } from '@/types';
import {
  runAgentLoopDispatched,
  type AgentLoopDispatchResult,
} from '@/core/agent/agentLoopRunner';
import { AgentLoopDispatchError } from '@/core/agent/agentLoopDispatchError';
import { failureIsOwnedByTranscript, shouldRestoreComposerAfterDispatch } from './composerSendResult';
import { getPendingCommandConfirmation, resolveCommandConfirmation, subscribeToCommandConfirmation, getPendingFilePermission, resolveFilePermission, subscribeToFilePermission, getPendingWorkspaceRequest, resolveWorkspaceRequest, resolveWorkspaceRequestById, subscribeToWorkspaceRequest, getPendingUserQuestions, subscribeUserQuestion, findQuestionOwningMessage } from '@/core/agent/permissionBridge';
import { getDefaultImageBackend, useSettingsStore } from '@/stores/settingsStore';
import type { ImageEditDraft, MediaJobRecord } from '@/types/media';
import { invokeElectronMedia } from '@/utils/electronHost';
import { imageEditCapabilities } from '@/core/media/imageEditCapabilities';
import { discardPreparedImageEdit, refreshMediaJobs } from '@/core/media/mediaJobs';
import { providerHasCredentials } from '@/utils/settingsSelectors';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { PermissionDuration } from '@/stores/permissionStore';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useI18n } from '@/i18n';
import MessageGroup from './MessageGroup';
import MessageBubble from './MessageBubble';
import { expertIdentity, teamIdentity, isIntroductionMessage } from '@/core/team/expertContact';
import type { ExpertContact } from '@/types/expertContact';
import CompactDivider from './CompactDivider';
import BrowserRunReportCard from './BrowserRunReportCard';
import MaxTurnsNoticeCard from './MaxTurnsNoticeCard';
import GoalRoundMarker from './GoalRoundMarker';
import GoalBar from './GoalBar';
import ChapterRail from './ChapterRail';
import ChapterMenu from './ChapterMenu';
import BackgroundCommandsButton from './BackgroundCommandsButton';
import { activeChapterIndex, deriveChapters, shouldShowRail, topVisibleGroup, type Chapter, type RowPosition } from './chapters';
import { isCompactBoundary } from '@/core/context/compactBoundary';
import { isBrowserRunReportMessage } from '@/core/observability/browserRunReport';
import { isMaxTurnsNoticeMessage } from '@/core/agent/maxTurnsNotice';
import { compactConversationManually } from '@/core/context/compactionService';
import { applyGoalCommand, checkGoalCreatable, clearGoalForReplacement, createGoalFromCommand, parseGoalCommand } from '@/core/goal/goalCommand';
import { useConfirm } from '@/components/ds/confirm-context';
import { useToastStore } from '@/stores/toastStore';
import { useBackgroundCommandStore } from '@/stores/backgroundCommandStore';
import { isTauriEnv } from '@/utils/tauriEnv';
import { ensureConversationModelUsable } from './sendModelGuard';
import ChatInput from './ChatInput';
import { focusComposer, focusComposerAfterPageChange, focusComposerFromWindow } from './composerFocus';
import { ConversationBranchOrigin } from './ConversationBranchOrigin';
import { getComposerDraftKey, getComposerDraftScopeForEnterpriseMode, readComposerDraft } from '@/stores/composerDraftStore';
import UserQuestionDock, { type ArrivedQuestion } from './UserQuestionDock';
import AgentStatusStrip from './AgentStatusStrip';
import TeamMemberBar from './TeamMemberBar';
import TeamConfirmationsStrip from './TeamConfirmationsStrip';
import QueuedMessagesStrip from './QueuedMessagesStrip';
import ScenarioGuide from './ScenarioGuide';
import { PROMPT_GRID_CLASS, PROMPT_ITEM_CLASS } from './promptGrid';
import { agentRegistry } from '@/core/agent/registry';
import { matchTeamMention } from '@/core/team/chatEntry';
import { getVisibleTeamById } from '@/stores/teamStore';
import { useVisibleTeams } from '@/core/team/useVisibleTeams';
import { localizedTeam } from '@/core/team/localizedTeam';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { effectiveRoleId } from '@/core/team/roleIdentity';
import PermissionDialog from '@/components/common/PermissionDialog';
import CommandConfirmDialog from '@/components/common/CommandConfirmDialog';
import { pickVisibleApproval } from '@/components/common/approvalQueueView';
import abuAvatar from '@/assets/abu-avatar.png';
import WelcomeAvatar from '@/components/chat/WelcomeAvatar';
import IMInfoBar from './IMInfoBar';
import SourceInfoBar from './SourceInfoBar';
import ComputerUseStatusBar from './ComputerUseStatusBar';
import ConvIdBadge from './ConvIdBadge';
import { cn } from '@/lib/utils';
import { isMacOS } from '@/utils/platform';
import { windowDragRowProps } from '@/utils/windowDrag';
import { Button } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { LoadError } from '@/components/ds/load-error';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import { Tag } from '@/components/ds/tag';
import { TextField } from '@/components/ds/text-field';
import UsageChip from './UsageChip';
import { shouldShowTypingIndicator } from './typingIndicator';
import { groupMessagesByLoop, lastGroupIndexByLoop } from './messageGrouping';
import { ThinkingStatusLine, AssistantRowAvatar } from './ThinkingStatusLine';
import { useConversationTeamLeader } from '@/components/team/useConversationTeamLeader';
import AgentAvatar from '@/components/common/AgentAvatar';
import TeamAvatar from '@/components/team/TeamAvatar';
import AppHome, { AppHomeScenes } from './AppHome';
import ConversationAppBadge from './ConversationAppBadge';
import ConversationAppNotice from './ConversationAppNotice';
import { appBindingShown, useAppsLabOn, useSelectedApp } from '@/stores/appStore';
import { GENERAL_APP_ID } from '@/types/app';
import {
  CHAT_ROW_TRAILING_PAD,
  TYPING_FOOTER_GAP_COMPENSATION,
} from './chatSpacing';
import ChatMessageList, { type ChatMessageListHandle } from './ChatMessageList';
import type { ChatListLocation } from './chatListRange';
import { searchJumpTarget } from './searchJumpTarget';
import { emitChatScrollTrace, type ChatScrollFollowSource } from './chatScrollTrace';
import {
  announceChatTurnScrollIntent,
  subscribeChatTurnScrollIntent,
} from './chatTurnScrollIntent';
import {
  ANCHOR_TOLERANCE_PX,
  CHAT_AT_BOTTOM_THRESHOLD_PX,
  armTurnScrollAnchor,
  canArmTurnScrollAnchor,
  exitTurnScrollAnchor,
  findUserMessageAnchor,
  isAtBottomFromGeometry,
  isChapterRailAtBottom,
  resolveTurnAnchorLayout,
  selectLatestUserAnchor,
  settleTurnScrollAnchor,
  shouldFollowOutput,
  type TurnScrollAnchor,
  type TurnScrollAnchorExitReason,
} from './turnScrollAnchor';

// Spacing between message groups is each row's bottom padding
// (CHAT_ROW_TRAILING_PAD in chatSpacing.ts), applied to every row uniformly.
// This is deliberately unconditional (no "skip on last item" special-casing):
// virtualized rows are NOT reliably `:first-child`/`:last-child` in the DOM
// (whichever row is topmost/bottommost in the mounted window varies as the user
// scrolls), so a CSS positional selector would apply to the wrong row. Net
// effect: one ~1.25rem gap after the final row, before the `pb-16` wrapper
// padding.

// Typing indicator, rendered after the last message group as the list's
// footer so it stays part of the scrolled content (needed for stick-to-bottom
// behavior).
function TypingFooter({
  showTypingIndicator,
  retryingLabel,
  thinkingLabel,
}: {
  showTypingIndicator: boolean;
  retryingLabel: string | null;
  thinkingLabel: string;
}) {
  // Layout mirrors a MessageGroup's assistant row (shared AssistantRowAvatar,
  // gap-3, shared ThinkingStatusLine) so the hand-off from this footer to the
  // real assistant placeholder — and then to the TaskBlock header / "用时
  // Xs" fold header — keeps the label on the same baseline at the same size
  // instead of hopping between typographies ("错行"). The negative top margin
  // bridges the item-pad vs in-group-gap difference — see chatSpacing.ts.
  const footerConv = useActiveConversation();
  const footerLeader = useConversationTeamLeader(footerConv?.id);
  if (!showTypingIndicator) return null;
  return (
    <div className={cn(TYPING_FOOTER_GAP_COMPENSATION, 'flex gap-3')}>
      <AssistantRowAvatar avatar={footerLeader ? <AgentAvatar agent={footerLeader.leader} size="md" round /> : undefined} name={footerLeader?.leaderName} />
      <ThinkingStatusLine label={retryingLabel ?? thinkingLabel} />
    </div>
  );
}

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

// Rows the transcript shows: internal system prompts are left out, crash
// recovery notices (which explain an interrupted task) and goal-round openers
// (rendered as a round marker) are kept.
function isShownMessage(message: Message): boolean {
  return !message.isSystem || Boolean(message.isRecoveryNotice) || Boolean(message.goalRound);
}

function syncElementToBottom(element: HTMLElement): number {
  const previousScrollTop = element.scrollTop;
  element.scrollTop = element.scrollHeight;
  return element.scrollTop - previousScrollTop;
}

// F13: the record of the conversation in view is on disk and could not be read. The page says so
// and offers a retry. The host's own error text is never shown, in no attribute either: it can
// carry a path with the account name. The explanation stays while a retry reads, so the button
// that was pressed stays under the focus; when the read succeeds this page leaves with that
// button and the message field takes the focus. The same holds when another caller's read
// succeeds while a control of this page has the focus: the page leaves under it, so the message
// field takes it, and only when it would otherwise be on the window.
function ConversationLoadError({ convId }: { convId: string }) {
  const { t } = useI18n();
  const [retrying, setRetrying] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const page = pageRef.current;
    // Runs before the page's nodes are taken out, so the focus can still be read.
    return () => {
      if (!page?.contains(document.activeElement)) return;
      const state = useChatStore.getState();
      if (state.activeConversationId === convId && state.conversations[convId]) focusComposerAfterPageChange();
    };
  }, [convId]);
  const retry = useCallback(() => {
    setRetrying(true);
    void useChatStore.getState().retryLoadConversation(convId).finally(() => {
      setRetrying(false);
      if (useChatStore.getState().conversations[convId]) focusComposerAfterPageChange();
    });
  }, [convId]);
  return (
    <div ref={pageRef} className="flex h-full flex-col">
      {/* No header row here either: the same 44px drag band as the welcome page. */}
      <div {...windowDragRowProps()} className="h-11 shrink-0" />
      <div className="flex flex-1 items-center justify-center">
        <LoadError reason={t.chat.recordUnreadable} onRetry={retry} busy={retrying} />
      </div>
    </div>
  );
}

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
  const imageRequestIds = activeConv?.messages.flatMap(message => message.imageEditRequest ? [message.imageEditRequest.id] : []).join(',') ?? '';
  useEffect(() => {
    if (activeConvId && imageRequestIds) void refreshMediaJobs(activeConvId);
  }, [activeConvId, imageRequestIds]);
  const loadFailed = useChatStore((s) => (s.activeConversationId ? s.loadFailures[s.activeConversationId] === true : false));
  const pendingSearchJump = useChatStore((s) => s.pendingSearchJump);
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const renameConversation = useChatStore((s) => s.renameConversation);
  // Goal mode: `/goal <new>` while another goal is unfinished asks the user first.
  const confirm = useConfirm();
  const [isRenamingTitle, setIsRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleTeamLeader = useConversationTeamLeader(activeConv?.id);

  // Cancel any in-progress title rename when the active conversation changes.
  // The rename state is component-local; without this reset a draft started on
  // one conversation would carry over to whatever conversation becomes active
  // (e.g. a background/programmatic switch that doesn't fire the Input's onBlur)
  // and the next Enter/blur would commit it against the WRONG conversation's id.
  useEffect(() => {
    setIsRenamingTitle(false);
  }, [activeConvId]);
  useEffect(() => {
    if (!activeConvId || !isTauriEnv()) return;
    void useBackgroundCommandStore.getState().refresh(activeConvId);
  }, [activeConvId]);
  const createConversation = useChatStore((s) => s.createConversation);
  const setConversationTeamId = useChatStore((s) => s.setConversationTeamId);
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
        avatar: pendingAgent.avatar,
      }
    : null;
  const pendingExpertContact = useChatStore((s) => s.pendingExpertContact);

  // The composer already owns the pending team pin. After creation the
  // conversation owns it instead, so welcome identity follows the same source.
  const pendingTeamId = useChatStore((s) => s.pendingTeamId);
  const welcomeTeamId = activeConv ? activeConv.teamId : pendingTeamId;
  const visibleTeams = useVisibleTeams();
  const storedWelcomeTeam = visibleTeams.find((team) => team.id === welcomeTeamId);
  const welcomeTeam = storedWelcomeTeam ? localizedTeam(storedWelcomeTeam, locale) : undefined;
  const expertPrompts = pendingAgent
    ? pendingAgent.samplePromptsI18n?.[locale] ?? pendingAgent.samplePrompts
    : welcomeTeam?.samplePrompts;
  const discoveredAgents = useDiscoveryStore((s) => s.agents);
  const welcomeAgents = useMemo(() => discoveredAgents.map((meta) => agentRegistry.getAgent(meta.name)).filter((agent) => agent !== undefined), [discoveredAgents]);
  const welcomeRole = (roleId: string) => welcomeAgents.find((agent) => effectiveRoleId(agent) === roleId);
  const welcomeRoleLabel = (roleId: string) => {
    const agent = welcomeRole(roleId);
    return agent?.displayNames?.[locale] ?? agent?.name ?? t.team.unknownMember;
  };

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

  // The workspace request first: it answers itself 60 seconds after it was asked.
  const visibleApproval = pickVisibleApproval(
    { command: commandConfirmRequest, file: filePermissionRequest, workspace: workspaceRequest },
    activeConvId,
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
    const request = workspaceRequest;
    if (!request) return;
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: request.suggestedPath || undefined,
      });
      if (selected && typeof selected === 'string') {
        // The system picker can stay open past the request it was opened for
        // (60s timeout, abort, or a newer request taking its place). A folder
        // picked for a request that is gone answers nothing and grants nothing.
        if (getPendingWorkspaceRequest()?.id !== request.id) {
          useToastStore.getState().addToast({ type: 'info', title: t.permission.folderRequestEnded });
          return;
        }
        useWorkspaceStore.getState().setWorkspace(selected);
        useChatStore.getState().setConversationWorkspace(request.conversationId, selected);
        resolveWorkspaceRequestById(request.id, selected);
      } else {
        resolveWorkspaceRequestById(request.id, null);
      }
    } catch {
      resolveWorkspaceRequestById(request.id, null);
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

  // The message list virtualizes inside this scrollable node instead of
  // creating its own nested scroller.
  const [scrollParentEl, setScrollParentEl] = useState<HTMLDivElement | null>(null);
  const listRef = useRef<ChatMessageListHandle>(null);
  // Bottom-lock (stick-to-bottom) state: while pinned, every list-height change
  // (late-measured widgets/iframes/images) re-sticks the view to the newest
  // message via `totalListHeightChanged`. Unpinned only by explicit upward user
  // intent (wheel/touch up); re-pinned when the user reaches the bottom again.
  // Event-driven — no timers guessing when heavy content finishes measuring.
  const pinnedRef = useRef(true);
  // Render mirror of pinnedRef — gates the "back to bottom" button. While the
  // lock is engaged the button is meaningless (we're headed to the bottom), and
  // a list still measuring late content can report atBottom=false for a moment,
  // which would flash the button.
  const [pinned, setPinned] = useState(true);
  const updatePinned = useCallback((v: boolean) => {
    pinnedRef.current = v;
    setPinned(v);
  }, []);
  // Mirrors the list's own atBottomStateChange callback. Geometry-sensitive
  // exits update this from the real distance instead of forcing a stale value.
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Active-turn geometry is intentionally transient and ref-backed. Streamed
  // tokens can resize the final list row several times per frame; mirroring
  // those measurements through React state would add another render/measure
  // loop on top of the list's own one.
  const turnAnchorRef = useRef<TurnScrollAnchor | null>(null);
  // Render mirror of "the anchor holds", for the list's `followOutput` prop.
  // Any value but a literal `false` lets the list scroll its end into view when
  // rows are appended or the viewport shrinks at the bottom, and a held turn
  // keeps the list end above the viewport bottom.
  const [turnAnchorHolds, setTurnAnchorHolds] = useState(false);
  const commitTurnAnchor = useCallback((anchor: TurnScrollAnchor | null) => {
    turnAnchorRef.current = anchor;
    setTurnAnchorHolds(anchor?.phase === 'armed');
  }, []);
  const pendingTurnAnchorRef = useRef<PendingTurnAnchor | null>(null);
  // The conversation whose first message was sent from the new-task page and has not replaced
  // that page with the chat page yet.
  const firstMessageOfRef = useRef<string | null>(null);
  // The scrolled content holds the active turn's minimum height; the filler
  // after the list shows the part of that hold the list does not cover yet.
  // Both sit outside the list: its container carries an explicit height from
  // the list's own size model, so the hold cannot live inside it.
  const turnContentElementRef = useRef<HTMLDivElement | null>(null);
  const turnSpacerElementRef = useRef<HTMLDivElement | null>(null);
  const turnMinContentHeightRef = useRef(0);
  const armAnchorRafRef = useRef(0);
  const runningConversationRef = useRef<string | null>(null);
  const dismissedTurnAnchorRef = useRef<{ conversationId: string; messageId: string } | null>(null);
  const writeTurnMinContentHeight = useCallback((height: number) => {
    const nextHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
    turnMinContentHeightRef.current = nextHeight;
    const element = turnContentElementRef.current;
    if (!element) return;
    element.style.minHeight = nextHeight > 0 ? `${nextHeight}px` : '';
  }, []);
  const writeTurnMinContentHeightWithCompensation = useCallback((
    element: HTMLElement | null,
    height: number,
    mode: 'preserve-position' | 'sync-bottom',
  ) => {
    const previousHeight = turnMinContentHeightRef.current;
    const previousScrollTop = element?.scrollTop ?? 0;
    writeTurnMinContentHeight(height);
    if (!element || height !== 0 || previousHeight === 0) return;

    // Releasing the hold can clamp scrollTop immediately. Pair the DOM write
    // with an explicit scroll decision in this layout pass so no later
    // list height callback can deliver a one-frame hard jump.
    void element.scrollHeight;
    if (mode === 'sync-bottom') {
      element.scrollTop = element.scrollHeight;
      return;
    }
    const maximumScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.min(previousScrollTop, maximumScrollTop);
  }, [writeTurnMinContentHeight]);
  const registerTurnContent = useCallback((element: HTMLDivElement | null) => {
    turnContentElementRef.current = element;
    if (!element) return;
    const height = turnMinContentHeightRef.current;
    element.style.minHeight = height > 0 ? `${height}px` : '';
  }, []);
  const readTurnSpacerHeight = useCallback(() => {
    const element = turnSpacerElementRef.current;
    return element ? element.getBoundingClientRect().height : 0;
  }, []);
  const handOffTurnAnchorToBottom = useCallback((
    el: HTMLElement,
    anchor: TurnScrollAnchor,
    totalListHeight?: number,
  ) => {
    commitTurnAnchor({ ...anchor, phase: 'exhausted', minContentHeight: 0 });
    const previousScrollTop = el.scrollTop;
    writeTurnMinContentHeight(0);
    void el.scrollHeight;
    el.scrollTop = el.scrollHeight;
    emitChatScrollTrace('turn-anchor', 'applied', el, {
      totalListHeight,
      scrollDelta: el.scrollTop - previousScrollTop,
      spacerHeight: readTurnSpacerHeight(),
      minContentHeight: 0,
    });
    updatePinned(true);
    setIsAtBottom(true);
  }, [commitTurnAnchor, readTurnSpacerHeight, updatePinned, writeTurnMinContentHeight]);
  const reconcileActiveTurnGeometry = useCallback((el: HTMLElement, totalListHeight?: number) => {
    const anchor = turnAnchorRef.current;
    if (anchor?.phase !== 'armed') return;
    const anchorElement = findUserMessageAnchor(el, anchor.messageId);
    const content = turnContentElementRef.current;
    if (!anchorElement || !content) {
      handOffTurnAnchorToBottom(el, anchor, totalListHeight);
      return;
    }
    const viewportTop = el.getBoundingClientRect().top;
    const anchorTop = anchorElement.getBoundingClientRect().top - viewportTop;
    const layout = resolveTurnAnchorLayout({
      targetTop: anchor.targetTop,
      anchorTop,
      contentTop: content.getBoundingClientRect().top - viewportTop,
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
    });
    writeTurnMinContentHeight(layout.minContentHeight);
    const settled = settleTurnScrollAnchor(anchor, {
      minContentHeight: layout.minContentHeight,
      fillerHeight: readTurnSpacerHeight(),
    });
    if (settled.phase === 'exhausted') {
      handOffTurnAnchorToBottom(el, anchor, totalListHeight);
      return;
    }
    commitTurnAnchor(settled);
    if (layout.scrollCorrection === 0) return;
    const previousScrollTop = el.scrollTop;
    emitChatScrollTrace('turn-anchor', 'scheduled', el, {
      totalListHeight,
      anchorTop,
      spacerHeight: readTurnSpacerHeight(),
      minContentHeight: layout.minContentHeight,
    });
    el.scrollTop += layout.scrollCorrection;
    emitChatScrollTrace('turn-anchor', 'applied', el, {
      totalListHeight,
      scrollDelta: el.scrollTop - previousScrollTop,
      anchorTop: anchorElement.getBoundingClientRect().top - el.getBoundingClientRect().top,
      spacerHeight: readTurnSpacerHeight(),
      minContentHeight: layout.minContentHeight,
    });
  }, [
    commitTurnAnchor,
    handOffTurnAnchorToBottom,
    readTurnSpacerHeight,
    writeTurnMinContentHeight,
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
    commitTurnAnchor(exit.anchor);
    pendingTurnAnchorRef.current = null;
    if (exit.minContentHeight === 0) {
      writeTurnMinContentHeightWithCompensation(
        scrollParentEl,
        0,
        exit.pinned ? 'sync-bottom' : 'preserve-position',
      );
    } else {
      writeTurnMinContentHeight(exit.minContentHeight);
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
  }, [
    commitTurnAnchor,
    scrollParentEl,
    updatePinned,
    writeTurnMinContentHeight,
    writeTurnMinContentHeightWithCompensation,
  ]);
  // Message id to briefly highlight after a search-hit jump (see effect below).
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  // Ids of the compaction rows whose summary is shown. Kept here because the
  // list unmounts rows that scroll far out of view.
  const [expandedCompactIds, setExpandedCompactIds] = useState<ReadonlySet<string>>(() => new Set());
  const expandedCompactIdsRef = useRef<ReadonlySet<string>>(expandedCompactIds);
  useLayoutEffect(() => {
    if (expandedCompactIdsRef.current.size === 0) return;
    const empty = new Set<string>();
    expandedCompactIdsRef.current = empty;
    setExpandedCompactIds(empty);
  }, [activeConvId]);
  const toggleCompactSummary = useCallback((messageId: string) => {
    const next = new Set(expandedCompactIdsRef.current);
    if (next.has(messageId)) {
      next.delete(messageId);
    } else {
      // Expanding counts as reading upward, exactly like an upward scroll: the
      // bottom lock and any active-turn anchor are released, so the row stays
      // where it is and the summary opens below it.
      leaveTurnAnchor('user-scroll-intent');
      next.add(messageId);
    }
    expandedCompactIdsRef.current = next;
    setExpandedCompactIds(next);
  }, [leaveTurnAnchor]);
  // Index of the message group at the top of the viewport — what the chapter
  // rail highlights. Measured from the DOM (see the scroll-spy effect below).
  const [firstVisibleGroup, setFirstVisibleGroup] = useState(0);
  // Whether the transcript column leaves enough gutter to hold the rail.
  // Measured, not guessed from the viewport: the sidebar and the preview
  // panel both collapse this container without the window changing size.
  const [railFits, setRailFits] = useState(true);

  // Imperative stick-to-bottom: raw scrollTop assignment on the scroll parent,
  // deferred one frame. Raw scrollTop = scrollHeight bypasses the list's row
  // targets entirely and always lands on the true bottom of the scrolled
  // content, the footer and the turn filler included.
  const stickRafRef = useRef(0);
  const stickToBottom = useCallback((
    el: HTMLElement | null,
    source: Exclude<ChatScrollFollowSource, 'list-follow-output'>,
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
    listRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior });
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
  // The list's rendered range looks like the signal for this and is not: it
  // includes the 900px the list mounts above the viewport. Any conversation
  // shorter than viewport + 1800px therefore renders every row at once and
  // starts at index 0 forever — the rail would pin to the first chapter and
  // never move, whatever the user scrolled.
  //
  // Real geometry instead. The list stamps `data-index` on every rendered row,
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
  // consumes the pending jump exactly once. A list mounted for this
  // conversation already starts at the hit (`initialListLocation` below); the
  // scroll here serves a hit in the conversation already in view.
  useEffect(() => {
    const jump = pendingSearchJump;
    if (!jump || jump.convId !== activeConvId) return;
    const conv = useChatStore.getState().conversations[activeConvId];
    if (!conv || conv.messages.length === 0) return; // not loaded yet — retry on next messageCount change
    // Consume regardless of match so a missing target doesn't retry forever.
    useChatStore.getState().setPendingSearchJump(null);
    const shown = conv.messages.filter(isShownMessage);
    const hit = searchJumpTarget(conv.messages, groupMessagesByLoop(shown), jump.query, jump.messageId);
    if (!hit) return;
    // Release the bottom lock so late height-measurements don't yank the view
    // from the hit back to the bottom.
    leaveTurnAnchor('search-jump');
    setHighlightedMessageId(hit.messageId);
    requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index: hit.groupIndex, align: 'center', behavior: 'auto' });
    });
    clearTimeout(highlightFadeTimerRef.current);
    highlightFadeTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 2600);
  }, [pendingSearchJump, activeConvId, leaveTurnAnchor, messageCount]);

  const handleSend = async (
    text: string,
    images?: ImageAttachment[],
    workspacePath?: string | null,
    onAccepted?: () => void,
    imageEditDraft?: ImageEditDraft,
  ) => {
    // Goal mode: /goal is handled here, before any dispatch — never sent to the
    // model. Every form but `/goal <objective>` ends here and needs no model;
    // that one creates the goal below and sends the objective as the first
    // message.
    const goalCommand = imageEditDraft ? null : parseGoalCommand(text);
    if (goalCommand && goalCommand.kind !== 'create') {
      const outcome = applyGoalCommand(activeConv?.id, goalCommand);
      useToastStore.getState().addToast({ type: outcome.ok ? 'success' : 'error', title: outcome.message });
      return outcome.ok ? undefined : false;
    }

    // Check the model THIS conversation will run on (its pin, else the global
    // default). Returning false hands the text back to the composer — opening
    // settings used to swallow whatever the user had typed.
    if (!ensureConversationModelUsable(activeConv ?? undefined, t.chat)) return false;
    let imageEdit: MediaJobRecord | undefined;
    let imageAccepted = false;
    try {
    if (imageEditDraft) {
      if (imageEditDraft.conversationId !== activeConv?.id) throw new Error('Image draft belongs to another conversation');
      const backend = getDefaultImageBackend(useSettingsStore.getState());
      const capability = imageEditCapabilities(backend);
      if (!capability.whole || !backend?.apiKey) {
        useToastStore.getState().addToast({ type: 'error', title: t.media.serviceUnavailable });
        return false;
      }
      if ((imageEditDraft.comments.length && !capability.comments) || (imageEditDraft.markup.length && !capability.markup)
        || (imageEditDraft.region.length && !capability.region)) {
        useToastStore.getState().addToast({ type: 'error', title: t.media.instructionsUnsupported });
        return false;
      }
      const id = crypto.randomUUID();
      imageEdit = await invokeElectronMedia<MediaJobRecord>('prepare-edit', { draft: { ...imageEditDraft, id, messageId: `image-edit:${id}` }, backend });
    }

    if (!imageEditDraft && text.trim() === '/compact') {
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

    if (goalCommand) {
      const precheck = checkGoalCreatable(activeConv?.id, goalCommand.objective);
      if (!precheck.ok && precheck.replaces && activeConv) {
        // An unfinished goal is in the way: the user decides whether the new
        // one takes its place. Declining hands the text back to the composer.
        const unfinished = precheck.replaces;
        const replace = await confirm({
          title: t.chat.goal.replaceConfirmTitle,
          message: format(t.chat.goal.replaceConfirmBody, { objective: unfinished.objective }),
          confirmLabel: t.chat.goal.actionReplace,
        });
        if (!replace) return false;
        if (!clearGoalForReplacement(activeConv.id, unfinished)) {
          useToastStore.getState().addToast({ type: 'error', title: t.chat.goal.staleRevision });
          return false;
        }
      } else if (!precheck.ok) {
        useToastStore.getState().addToast({ type: 'error', title: precheck.message });
        return false;
      }
    }

    // A typed `@<team> …` that the composer did not turn into the team chip
    // (sent before the exact-name detection, pasted, …) still pins the
    // conversation to that team; the mention itself is not sent to the model.
    const teamMention = imageEditDraft ? null : matchTeamMention(text);
    // A conversation already pinned to another team is not silently re-pinned:
    // say so and send the text as typed (the chip is the way to switch).
    const shownTeamName = (teamId: string) => {
      const team = getVisibleTeamById(teamId);
      return team ? localizedTeam(team, locale).name : '';
    };
    if (teamMention && activeConv?.teamId && activeConv.teamId !== teamMention.teamId) {
      useToastStore.getState().addToast({ type: 'info', title: format(t.team.chatReceiptOtherTeam, { current: shownTeamName(activeConv.teamId), other: shownTeamName(teamMention.teamId) }) });
      return false;
    }
    if (teamMention && !teamMention.rest) {
      useToastStore.getState().addToast({ type: 'info', title: format(t.team.chatReceiptEmptyGoal, { team: shownTeamName(teamMention.teamId) }) });
      return false; // hand the text back to the composer
    }
    const sendText = goalCommand?.kind === 'create'
      ? goalCommand.objective.trim()
      : teamMention ? teamMention.rest : text;

    // Capture the selected identity before any asynchronous identity setup.
    const pendingBeforeSend = useChatStore.getState();
    let contact: ExpertContact | undefined;
    if (!activeConv?.messages.some((m) => m.role === 'user' && !m.isSystem)) {
      const addressedName = !teamMention ? /^@([^\s]+)/.exec(text)?.[1] : undefined;
      const addressedAgent = addressedName ? agentRegistry.getAgent(addressedName) : undefined;
      const teamId = teamMention?.teamId ?? welcomeTeamId;
      const team = teamId ? getVisibleTeamById(teamId) : undefined;
      if (addressedAgent) {
        let identity = expertIdentity(addressedAgent, locale);
        const shown = pendingExpertContact?.identity.key === identity.key ? pendingExpertContact : undefined;
        if (!addressedAgent.roleId && !addressedAgent.source && !addressedAgent.managed && !identity.key.startsWith('agent:builtin:')) {
          try {
            const { ensureRoleId } = await import('@/core/team/roleIdentity');
            const { roleId, wrote } = await ensureRoleId(addressedAgent);
            identity = expertIdentity({ ...addressedAgent, roleId }, locale);
            if (wrote) await useDiscoveryStore.getState().refresh();
          } catch { /* Onboarding must not prevent the user's actual task. */ }
        }
        contact = { identity: shown ? { ...shown.identity, key: identity.key } : identity, introduction: shown?.introduction };
      } else if (team) {
        const identity = teamIdentity(localizedTeam(team, locale));
        contact = pendingExpertContact?.identity.key === identity.key ? pendingExpertContact : { identity };
      }
      const latest = useChatStore.getState();
      if (latest.activeConversationId !== (activeConv?.id ?? null)
        || latest.pendingAgentName !== pendingBeforeSend.pendingAgentName
        || latest.pendingTeamId !== pendingBeforeSend.pendingTeamId
        || latest.pendingExpertContact !== pendingBeforeSend.pendingExpertContact) return false;
    }

    let convId = activeConv?.id;
    const isNewConversation = !convId;
    if (!convId) {
      convId = createConversation(workspacePath, teamMention ? { teamId: teamMention.teamId } : undefined);
    } else if (teamMention && activeConv?.teamId !== teamMention.teamId) {
      setConversationTeamId(convId, teamMention.teamId);
    }
    if (contact) useChatStore.getState().stageExpertContact(convId, contact);
    if (goalCommand?.kind === 'create') {
      const created = createGoalFromCommand(convId, goalCommand.objective);
      useToastStore.getState().addToast({ type: created.ok ? 'success' : 'error', title: created.message });
      if (!created.ok) return false;
    }
    if (isNewConversation && !useSettingsStore.getState().sidebarCollapsed) {
      useSettingsStore.getState().toggleSidebar();
    }
    // Re-enable follow + jump to the new message. The list measures the
    // freshly-appended row while it commits, so this doesn't need to wait for
    // a DOM mutation callback.
    scrollToLatest('auto');
    // Suppress both legacy bottom-follow paths during the gap between dispatch
    // and the new persisted user row mounting. The list's layout effects run
    // before ChatView's and can report the new total height before ChatView's
    // parent layout effect
    // has had a chance to arm the DOM anchor.
    announceChatTurnScrollIntent({ conversationId: convId, source: 'composer' });
    // Sent from the new-task page: the page changes once the runner has added the message.
    const sentFromNewTaskPage = !activeConv || activeConv.messages.length === 0;
    if (sentFromNewTaskPage) firstMessageOfRef.current = convId;
    let dispatch: AgentLoopDispatchResult;
    try {
      dispatch = await runAgentLoopDispatched(convId, sendText, {
        images,
        ...(imageEdit ? { imageEditRequest: imageEdit.request } : {}),
        onMessageTaken: () => { imageAccepted = true; onAccepted?.(); },
        // A human typed this — attended, even inside a scheduled/trigger
        // conversation (the browser gate offers dialogs on that basis).
        initiatedBy: 'user',
      });
    } catch (error) {
      if (firstMessageOfRef.current === convId) firstMessageOfRef.current = null;
      // The runner deliberately keeps persistence/transport failures as
      // rejections for non-UI callers. Once it has appended the user message,
      // however, the failed transcript row (and its Retry action) owns
      // recovery; handing the same text back to ChatInput would duplicate it.
      if (!(error instanceof AgentLoopDispatchError) || !error.messageTaken) {
        pendingTurnAnchorRef.current = null;
        useChatStore.getState().clearStagedExpertContact(convId);
        throw error;
      }
      // #549: same rule as the returned-result path below — a row that already
      // states the failure and offers its action needs no toast on top.
      if (!failureIsOwnedByTranscript(useChatStore.getState().conversations[convId]?.messages ?? [])) {
        useToastStore.getState().addToast({
          type: 'error',
          title: error.message || t.chat.conversationBusy,
        });
      }
      return;
    }
    // The dispatch returned with the new-task page still in view: no page change is due any more.
    if (firstMessageOfRef.current === convId) firstMessageOfRef.current = null;
    if (!useChatStore.getState().conversations[convId]?.messages.some((m) => m.role === 'user' && !m.isSystem)) {
      useChatStore.getState().clearStagedExpertContact(convId);
    }
    // A rejected dispatch (conversation busy, attachment mid-run) used to be
    // discarded here: the composer had already cleared, so the text and any
    // images simply vanished with no feedback. Surface it and hand the draft
    // back instead.
    if (dispatch?.reason === 'error') {
      if (!dispatch.messageTaken) pendingTurnAnchorRef.current = null;
      // #549: a pre-accept failure already states itself in the failed row, with
      // the action that resolves it (Retry / 新建对话). A toast carrying the same
      // sentence would say it twice and point nowhere.
      if (!dispatch.runErrorKind) {
        useToastStore.getState().addToast({
          type: 'error',
          title: dispatch.error || t.chat.conversationBusy,
        });
      }
      if (shouldRestoreComposerAfterDispatch(dispatch)) {
        return false;
      }
    }
    } finally {
      if (imageEdit && !imageAccepted) await discardPreparedImageEdit(imageEdit.request.conversationId, imageEdit.request.id);
    }
  };


  // First-run banner: show when no provider has been configured yet.
  // "Configured" = has an API key OR needs none (providerNeedsApiKey).
  const needsPersonalModelSetup = useSettingsStore((s) => {
    return !s.providers.some(providerHasCredentials);
  });
  const needsSetup = !isEnterprise && needsPersonalModelSetup;

  // Scenario guide state — lifted here so ChatInput can receive the custom placeholder
  const [scenarioPlaceholder, setScenarioPlaceholder] = useState<string | null>(null);
  const [guideVisible, setGuideVisible] = useState(true);
  // Optimistic feedback for the beat between submitting a question/plan answer
  // and the resumed loop producing anything (Bug 1: 点同意后无反应).
  const [resuming, setResuming] = useState(false);
  const handleQuestionSubmitted = useCallback(() => {
    setResuming(true);
    // Fallback clear — normally hidden once the loop sets a status.
    setTimeout(() => setResuming(false), 4000);
  }, []);
  const agentStatus = useChatStore((s) => getConversationAgentState(s.agentStates, activeConvId).status);
  // The words of a question whose dock left the focus in the message field, for the live element.
  const [arrivedQuestion, setArrivedQuestion] = useState<ArrivedQuestion | null>(null);

  const handleSelectPrompt = useCallback((prompt: string) => {
    // Fill the prompt into the input via pendingInput
    useChatStore.getState().setPendingInput(prompt);
  }, []);

  const handleScenarioChange = useCallback((placeholder: string | null) => {
    setScenarioPlaceholder(placeholder);
  }, []);

  // Inside an app the welcome page is the app's home (product spec §5.4); the
  // team or expert the app pins shows in the composer chip, the header stays
  // the app's.
  const selectedApp = useSelectedApp();
  const appsLabOn = useAppsLabOn();
  const appHome = selectedApp.appId === GENERAL_APP_ID ? null : selectedApp;

  // Hide guide when user starts typing (called from ChatInput)
  const handleWelcomeInputChange = useCallback((hasText: boolean) => {
    setGuideVisible(!hasText);
  }, []);

  // The first message of a task replaces the new-task page with the chat page, and the message
  // field that was typed in leaves with it. The chat page's field takes the focus on the next
  // frame, from no control and from no layer. Only for a message sent from this page: one that
  // arrives by another way moves no focus.
  const onNewTaskPage = !activeConv || activeConv.messages.length === 0;
  useLayoutEffect(() => {
    if (onNewTaskPage || firstMessageOfRef.current === null) return;
    const sentIn = firstMessageOfRef.current;
    firstMessageOfRef.current = null;
    if (sentIn === activeConvId) focusComposerAfterPageChange();
  }, [onNewTaskPage, activeConvId]);

  // Message projection for the list. Computed above the early returns below
  // so the hooks that depend on it stay unconditional (rules-of-hooks).
  const visibleMessages = messages.filter(isShownMessage);
  const messageGroups = groupMessagesByLoop(visibleMessages);
  const branchBoundaryId = visibleMessages.filter(message => message.inheritedFromBranch).at(-1)?.id;
  useEffect(() => {
    if (!activeConvId || !scrollParentEl) return;
    const conversation = useChatStore.getState().conversations[activeConvId];
    if (!conversation?.branchInitialOpenPending) return;
    const scope = getComposerDraftScopeForEnterpriseMode(useEnterpriseStore.getState().mode);
    const draft = readComposerDraft(getComposerDraftKey(activeConvId, scope));
    const emptyDraft = !draft.text && !draft.images.length && !draft.files.length && !draft.references.length
      && !draft.selectedSkill && !draft.selectedAgent;
    if (!emptyDraft || !conversation.messages.every(message => message.inheritedFromBranch)) {
      useChatStore.getState().completeBranchInitialOpen(activeConvId);
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (useChatStore.getState().activeConversationId !== activeConvId
        || document.querySelector('[data-ds-layer]:not([hidden])')) return;
      if (focusComposer()) useChatStore.getState().completeBranchInitialOpen(activeConvId);
    });
    return () => cancelAnimationFrame(frame);
  }, [activeConvId, scrollParentEl]);
  const lastGroupOfLoop = lastGroupIndexByLoop(messageGroups);
  // Where the list stands when it mounts for this conversation: on the search
  // hit when one is waiting for it, else at the newest message. The list reads
  // it at mount only.
  const searchHit = pendingSearchJump?.convId === activeConvId
    ? searchJumpTarget(messages, messageGroups, pendingSearchJump.query, pendingSearchJump.messageId)
    : null;
  const initialListLocation: ChatListLocation = searchHit
    ? { index: searchHit.groupIndex, align: 'center' }
    : { index: 'LAST', align: 'end' };
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
      if (!anchorElement || !turnContentElementRef.current) {
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
      turnAnchorRef.current = armTurnScrollAnchor({
        ...candidate,
        targetTop: TURN_ANCHOR_TARGET_TOP_PX,
      });
      emitChatScrollTrace('turn-anchor', 'scheduled', scrollParentEl, {
        anchorTop: anchorElement.getBoundingClientRect().top - scrollParentEl.getBoundingClientRect().top,
        spacerHeight: readTurnSpacerHeight(),
      });
      // The hold and the scroll move land in this layout pass, before paint. A
      // queue rebind replaces the previous turn's hold in the same write, so
      // scrollTop is never clamped in between. An answer that already fills
      // the viewport hands over to bottom-follow here.
      reconcileActiveTurnGeometry(scrollParentEl);
    };

    tryArm();
    return () => cancelAnimationFrame(armAnchorRafRef.current);
  }, [
    activeConvId,
    leaveTurnAnchor,
    messageCount,
    readTurnSpacerHeight,
    reconcileActiveTurnGeometry,
    scrollParentEl,
  ]);
  // The viewport's own height decides how tall the hold must be (the composer
  // grows, the window resizes), and no list or content resize reports it.
  useLayoutEffect(() => {
    if (!scrollParentEl || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => reconcileActiveTurnGeometry(scrollParentEl));
    observer.observe(scrollParentEl);
    return () => observer.disconnect();
  }, [reconcileActiveTurnGeometry, scrollParentEl]);
  // Whether a height change in the transcript keeps a pinned reader at the
  // bottom. A turn whose anchor has been announced but not yet armed, or is
  // armed, is holding the bottom-pin off on purpose (see
  // shouldSuppressLegacyFollow, whose callers "must agree" so one path cannot
  // re-enable what another holds off). Reading the refs rather than calling
  // that helper keeps these resize paths out of its suppression budget, which
  // belongs to the list callbacks.
  const keepsBottomPinned = useCallback(() =>
    pinnedRef.current
    && !pendingTurnAnchorRef.current
    && turnAnchorRef.current?.phase !== 'armed', []);
  // The bottom lock's last mile. `totalListHeightChanged` reports the list's
  // own height model and its correction is deferred a frame, so content that
  // reaches the scroller after that write — the footer, the turn filler, a
  // row's final measurement settling once tokens stop — produces no further
  // list event and would leave a pinned reader parked a few pixels above the
  // bottom for the rest of the turn.
  // Observing the scrolled content closes that race at its source: the
  // scroller's own geometry is the authority, and ResizeObserver runs after
  // layout and before paint, so the correction is invisible rather than the
  // one-frame jump a deferred re-scroll would show.
  useLayoutEffect(() => {
    if (!scrollParentEl || typeof ResizeObserver === 'undefined') return;
    const content = scrollParentEl.querySelector<HTMLElement>('[data-chat-scroll-content]');
    if (!content) return;

    const observer = new ResizeObserver(() => {
      // An armed anchor owns its own geometry. The content grows past its
      // hold only once the list alone fills it, which is the hand-off moment.
      if (turnAnchorRef.current?.phase === 'armed') {
        reconcileActiveTurnGeometry(scrollParentEl);
        return;
      }
      if (!keepsBottomPinned()) return;
      const distanceToBottom =
        scrollParentEl.scrollHeight - scrollParentEl.scrollTop - scrollParentEl.clientHeight;
      // Same dead zone the other writers use, so a settled scroller stays put
      // instead of trading sub-pixel corrections with them every resize.
      if (distanceToBottom <= ANCHOR_TOLERANCE_PX) return;
      emitChatScrollTrace('content-resize', 'scheduled', scrollParentEl, {});
      const scrollDelta = syncElementToBottom(scrollParentEl);
      emitChatScrollTrace('content-resize', 'applied', scrollParentEl, { scrollDelta });
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [keepsBottomPinned, reconcileActiveTurnGeometry, scrollParentEl]);
  useLayoutEffect(() => {
    if (scrollParentEl) reconcileActiveTurnGeometry(scrollParentEl);
  });
  // Derived from the very array the list renders, so a chapter's groupIndex is
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
    listRef.current?.scrollToIndex({ index: chapter.groupIndex, align: 'start', behavior: 'auto' });
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
    emitChatScrollTrace('list-follow-output', 'decision', scrollParentEl, { atBottom });
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
    // A user who naturally scrolls down to the end of the list under a frozen,
    // post-unpin hold has explicitly reached "latest" again. Release the hold
    // and restore the ordinary pinned/follow contract in one state transition.
    if (turnMinContentHeightRef.current > 0) {
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

  // The record could not be read: say so, with a retry. Keyed, so a retry in flight for one
  // conversation shows no busy button on another.
  if (activeConvId && !activeConv && loadFailed) {
    return <ConversationLoadError key={activeConvId} convId={activeConvId} />;
  }

  // Conversation loading from disk (LRU cache miss) — show a loading line instead of the welcome page
  if (activeConvId && !activeConv) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label={t.common.loading} />
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
      <div className="flex flex-col h-full">
        {/* The welcome screen has no header row, so it gets the same 44px drag
            band the conversation view's title row provides. In flow, never
            overlaying, so it cannot cover the scroller underneath. */}
        <div {...windowDragRowProps()} className="shrink-0 h-11" />
        <div className="flex-1 flex flex-col items-center justify-start overflow-y-auto px-8 pt-[12vh] pb-8">
          <div className="w-full max-w-2xl">
            {/* Title */}
            {appHome ? (
              <AppHome app={appHome} onPlaceholderChange={handleScenarioChange} />
            ) : (
            <div className="text-center mb-8">
              {pendingAgentDisplay ? (
                <>
                  {/* Agent avatar: a built-in icon reference, an emoji, or the default mark */}
                  <WelcomeAvatar avatar={pendingAgentDisplay.avatar} />

                  <h1 className="mb-2 text-title-lg text-label">
                    {pendingAgentDisplay.name}
                  </h1>
                  <p className="mb-3 text-ui text-label-secondary">
                    {pendingAgentDisplay.description}
                  </p>
                </>
              ) : welcomeTeam ? (
                <div data-testid="team-welcome">
                  <TeamAvatar avatar={welcomeTeam.avatar} size="lg" round className="size-20 mx-auto mb-4 [&>svg]:h-10 [&>svg]:w-10 [&>span]:text-title-lg" />
                  <h1 className="mb-2 text-title-lg text-label">{welcomeTeam.name}</h1>
                  {welcomeTeam.description && <p className="mb-3 text-ui text-label-secondary">{welcomeTeam.description}</p>}
                  <div data-testid="team-welcome-members" className="mt-3 flex flex-wrap items-center justify-center gap-2 text-ui-sm text-label-secondary">
                    <span>{t.team.detailLeader}</span>
                    <span className="inline-flex items-center gap-1">
                      <AgentAvatar agent={welcomeRole(welcomeTeam.leaderRoleId) ?? { name: t.team.unknownMember }} size="sm" />
                      <span>{welcomeRoleLabel(welcomeTeam.leaderRoleId)}</span>
                    </span>
                    <span>·</span>
                    {welcomeTeam.memberRoleIds.some((id) => id !== welcomeTeam.leaderRoleId) ? (
                      <>
                        <span>{t.team.fieldMembers}</span>
                        {welcomeTeam.memberRoleIds.filter((id) => id !== welcomeTeam.leaderRoleId).map((id) => (
                          <span key={id} className="inline-flex items-center gap-1">
                            <AgentAvatar agent={welcomeRole(id) ?? { name: t.team.unknownMember }} size="sm" />
                            <span>{welcomeRoleLabel(id)}</span>
                          </span>
                        ))}
                      </>
                    ) : <span>{t.team.detailNoMembers}</span>}
                  </div>
                </div>
              ) : (
                <>
                  {/* Mascot */}
                  <div className="w-20 h-20 mx-auto mb-4 rounded-full overflow-hidden">
                    <img src={abuAvatar} alt="Abu" className="w-full h-full object-cover" />
                  </div>

                  {/* Slogan */}
                  <h1 className="mb-2 text-title-lg text-label">
                    {t.chat.welcomeTitle}
                  </h1>
                  <p className="text-ui text-label-secondary">
                    {t.chat.welcomeSubtitle}
                  </p>
                </>
              )}
            </div>
            )}

            {/* First-run setup prompt */}
            {needsSetup && (
              <div className="mb-6 mx-auto max-w-md">
                <div className="rounded-panel border border-separator bg-surface px-5 py-4 text-center">
                  <p className="mb-1 text-title text-label">
                    {t.chat.setupRequired}
                  </p>
                  <p className="mb-3 text-ui text-label-secondary">
                    {t.chat.setupRequiredDesc}
                  </p>
                  <Button
                    variant="primary"
                    icon={AppIcons.settings}
                    onClick={() => useSettingsStore.getState().openSystemSettings('ai-services')}
                  >
                    {t.chat.setupButton}
                  </Button>
                </div>
              </div>
            )}

            {appHome && <AppHomeScenes app={appHome} visible={guideVisible} />}

            {/* Main input */}
            <div>
              <ChatInput
                variant="welcome"
                onSend={handleSend}
                scenarioPlaceholder={scenarioPlaceholder}
                onInputChange={handleWelcomeInputChange}
              />
            </div>

            {/* General-shell prompt suggestions */}
            {!appHome && (pendingAgent || welcomeTeam ? (
              !!expertPrompts?.length && guideVisible && <div className={cn(PROMPT_GRID_CLASS, 'mt-4')} data-testid="expert-prompts">
                {expertPrompts.map((prompt, index) => <Pressable key={index} className={PROMPT_ITEM_CLASS} onClick={() => handleSelectPrompt(prompt)}>{prompt}</Pressable>)}
              </div>
            ) : <ScenarioGuide
              onSelectPrompt={handleSelectPrompt}
              onScenarioChange={handleScenarioChange}
              visible={guideVisible}
            />)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0">
      {/* Conversation title header — flush at card top (TRAE-style header row).
          The divider separates navigation context from the conversation body;
          platform overlays receive only the padding needed by existing controls. */}
      <div {...windowDragRowProps()} className={cn(
        'shrink-0 flex items-center h-11 px-4',
        windowsWorkspaceHeader && 'border-b border-separator',
        // Collapsed platform controls float over the card's top-left; indent
        // the title to clear the controls present on that platform.
        sidebarCollapsed && isMacOS() && 'pl-48',
        sidebarCollapsed && windowsWorkspaceHeader && 'pl-20',
        // The panel toggle floats over the header's right end on macOS too;
        // keep the chapter menu button out from under it.
        rightPanelToggleVisible && (windowsWorkspaceHeader || isMacOS()) && 'pr-12',
      )}>
        {isRenamingTitle ? (
          <TextField
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
            className="max-w-md"
          />
        ) : (
          <span
            className="cursor-default truncate text-ui font-medium text-label"
            onDoubleClick={() => { setTitleDraft(activeConv.title); setIsRenamingTitle(true); }}
            title={activeConv.title}
          >
            {activeConv.title}
          </span>
        )}
        {activeConv.appBinding && appBindingShown(activeConv.appBinding, appsLabOn) && !isRenamingTitle && <ConversationAppBadge binding={activeConv.appBinding} />}
        {titleTeamLeader && !isRenamingTitle && (
          <span
            data-testid="chat-title-team-badge"
            className="ml-2 inline-flex shrink-0"
            title={`${titleTeamLeader.leaderName} · ${titleTeamLeader.teamName}`}
          >
            <Tag>
              <TeamAvatar avatar={titleTeamLeader.teamAvatar} size="xs" round />
              <span className="max-w-40 truncate">{titleTeamLeader.teamName}</span>
            </Tag>
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <BackgroundCommandsButton key={activeConv.id} conversationId={activeConv.id} />
          {/* Chapter navigation moves into the header exactly when the gutter can
              no longer hold the rail, so the two never appear at once. */}
          {chapterNavVisible && !railFits && (
            <ChapterMenu chapters={chapters} currentIndex={currentChapter} onJump={jumpToChapter} />
          )}
        </div>
      </div>

      {/* One approval at a time, and only one that belongs to this conversation. The others
          wait in their queues, unanswered. */}
      {visibleApproval?.kind === 'command' && commandConfirmRequest && (
        // Keyed by request: the next one in the queue is a new window, which opens with the
        // focus on its Cancel button like the first.
        <CommandConfirmDialog
          key={commandConfirmRequest.id}
          request={commandConfirmRequest.info}
          isRequestActive={() => getPendingCommandConfirmation() === commandConfirmRequest}
          onConfirm={handleCommandConfirm}
          onCancel={handleCommandCancel}
          onFocusUnplaced={focusComposerFromWindow}
        />
      )}

      {visibleApproval?.kind === 'file' && filePermissionRequest && (
        // Keyed by request, like the command approval: the next grant in the queue opens from
        // the default duration with the focus on Deny, also when it asks about the same path.
        <PermissionDialog
          key={filePermissionRequest.id}
          request={{
            type: filePermissionRequest.capability === 'write' ? 'file-write' : 'file-read',
            path: filePermissionRequest.path,
          }}
          onAllow={handleFilePermissionAllow}
          onDeny={handleFilePermissionDeny}
          onFocusUnplaced={focusComposerFromWindow}
        />
      )}

      {visibleApproval?.kind === 'workspace' && workspaceRequest && (
        // Keyed by request: a newer request that takes the place of this one is a new window.
        <PermissionDialog
          key={workspaceRequest.id}
          request={{
            type: 'folder-select',
            reason: workspaceRequest.reason,
            path: workspaceRequest.suggestedPath,
          }}
          onAllow={() => {}}
          onChooseFolder={handleWorkspaceSelect}
          onAuthorize={handleWorkspaceAuthorize}
          onDeny={handleWorkspaceDeny}
          onFocusUnplaced={focusComposerFromWindow}
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
      <ComputerUseStatusBar onStop={(conversationId) => useChatStore.getState().cancelStreaming(
        conversationId,
        { source: 'computer-use-status-bar' },
      )} />

      {/* Messages Area — overlay-scroll hides the native scrollbar (thumb shows
          only while scrolling, via the global is-scrolling toggle in main.tsx);
          overflow-y-scroll (not auto) keeps the transparent gutter always
          reserved so opening the preview panel doesn't flash a scrollbar and
          shift the content. */}
      <div className="relative flex-1 min-h-0 overflow-y-scroll overlay-scroll" ref={setScrollParentEl}>
        {chapterNavVisible && railFits && (
          <ChapterRail chapters={chapters} currentIndex={currentChapter} onJump={jumpToChapter} />
        )}
        <div
          ref={registerTurnContent}
          data-chat-scroll-content
          className="flex flex-col w-full max-w-4xl mx-auto px-6 md:px-10 pt-5 pb-16 overflow-hidden"
        >
          {activeConv.branchOrigin && messageGroups.length === 0 &&
            <ConversationBranchOrigin origin={activeConv.branchOrigin} />}
          {scrollParentEl && <ChatMessageList
            // Remount per conversation: the list computes its first rows at
            // `initialLocation` and scrolls there before the first paint, so a
            // switch goes from the old transcript to the new one in one frame.
            key={activeConvId}
            ref={listRef}
            data={messageGroups}
            initialLocation={initialListLocation}
            scrollParent={scrollParentEl}
            computeItemKey={(index, group) => group[0]?.id ?? index}
            itemClassName={CHAT_ROW_TRAILING_PAD}
            // Follow appended rows, but only while already at the bottom.
            // 'auto' (instant) rather than 'smooth': streamed text arrives in
            // small, frequent chunks, so instant jumps read as continuous
            // motion without fighting a CSS scroll animation that's still in
            // flight when the next chunk lands.
            followOutput={turnAnchorHolds ? false : handleFollowOutput}
            atBottomStateChange={handleAtBottomStateChange}
            atBottomThreshold={CHAT_AT_BOTTOM_THRESHOLD_PX}
            // The bottom lock: whenever late-measured content (widget iframes,
            // images, charts, streamed tokens) changes the total list height
            // while the user is pinned, re-stick to the newest message.
            // Event-driven — replaces any "scroll again after N ms" guesswork.
            //
            // Gated on an actual gap from the bottom: the content observer
            // below already re-sticks in the same layout pass, so an
            // unconditional raw `scrollTop = scrollHeight` here would race it —
            // two independent corrections computed from slightly different
            // scrollHeight snapshots, which read as the answer pane jittering
            // up/down while streaming.
            totalListHeightChanged={handleTotalListHeightChanged}
            keepsBottom={keepsBottomPinned}
            footer={(
              <>
              {activeConv.isCompressing && !activeConv.compressingLoopId && (
                <CompactDivider
                  message={{ id: `compressing-${activeConv.id}`, role: 'system', content: '', timestamp: 0 }}
                  pending
                  expanded={false}
                  onToggle={() => {}}
                />
              )}
              <TypingFooter
                // Covers the gap before the next assistant placeholder is created.
                // This occurs both on a normal send and when a staged queue item
                // is consumed after earlier assistant turns already exist.
                showTypingIndicator={shouldShowTypingIndicator(activeConv?.status, visibleMessages)}
                // AgentStatusStrip above the composer (always mounted for the
                // active conversation) says 「正在重试」; the list keeps 「思考中」 so
                // the sentence shows once.
                retryingLabel={null}
                // status.thinking ("思考中", no trailing ellipsis) — the same
                // string the in-group placeholder shows and the TaskBlock active
                // header reduces to (it strips the ellipsis). chat.thinking
                // ("思考中…") here made the "…" blink out at the footer →
                // placeholder hand-off, and reads odd before the animated dots.
                thinkingLabel={t.status.thinking}
              />
              </>
            )}
            itemContent={(index, group) => <>
              {index === 0 && activeConv.branchOrigin && !branchBoundaryId &&
                <ConversationBranchOrigin origin={activeConv.branchOrigin} />}
              {
              group.length === 1 && isCompactBoundary(group[0]) ? (
                <CompactDivider
                  message={group[0]}
                  expanded={expandedCompactIds.has(group[0].id)}
                  onToggle={() => toggleCompactSummary(group[0].id)}
                />
              ) : group.length === 1 && isMaxTurnsNoticeMessage(group[0]) ? (
                // The turn-cap notice. Its own group by construction: the
                // marker carries no loopId, and `groupMessagesByLoop` starts a
                // fresh group at every message without one.
                <MaxTurnsNoticeCard conversationId={activeConv.id} message={group[0]} />
              ) : group.length === 1 && isIntroductionMessage(group[0]) ? (
                // The configured first-contact greeting: a plain bubble with
                // the expert's identity, never a model turn with run actions.
                <MessageBubble message={group[0]} />
              ) : group[0].goalRound ? (
                // Goal mode: the round's opening row is the driver's prompt,
                // not user input — a marker, then the run as usual.
                <>
                  <GoalRoundMarker message={group[0]} />
                  {group.length > 1 && (
                    <MessageGroup
                      conversationId={activeConv.id}
                      messages={group.slice(1)}
                      isLastGroup={index === messageGroups.length - 1}
                      isLastGroupOfLoop={lastGroupOfLoop.get(group[0].loopId ?? '') === index}
                      highlightMessageId={highlightedMessageId}
                      expandedCompactIds={expandedCompactIds}
                      onToggleCompactSummary={toggleCompactSummary}
                    />
                  )}
                </>
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
                  isLastGroupOfLoop={lastGroupOfLoop.get(group[0].loopId ?? '') === index}
                  highlightMessageId={highlightedMessageId}
                  expandedCompactIds={expandedCompactIds}
                  onToggleCompactSummary={toggleCompactSummary}
                />
              )}
              {activeConv.branchOrigin && group.some(message => message.id === branchBoundaryId) &&
                <ConversationBranchOrigin origin={activeConv.branchOrigin} />}
            </>}
          />}

          {/* Active-turn filler: takes the part of the turn's minimum content
              height that the list does not cover yet. */}
          <div ref={turnSpacerElementRef} data-turn-bottom-spacer aria-hidden="true" className="grow" />

          {/* Bottom sentinel — keeps a sliver of space after last message */}
          <div className="h-px w-full" />
        </div>

        {/* Scroll-to-bottom button — only when the user has actually left the
            bottom (unpinned). While the lock is engaged we're headed to the
            bottom anyway, and a transient atBottom=false while late content
            measures would otherwise flash the button. */}
        {!isAtBottom && !pinned && (
          <div className="pointer-events-none sticky bottom-3 z-sticky flex justify-center">
            <div className="pointer-events-auto rounded-control bg-raised shadow-float">
              <Button variant="plain" size="sm" icon={AppIcons.expand} onClick={() => scrollToLatest('smooth')}>
                {t.chat.scrollToBottom}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Input */}
      <div className="shrink-0 px-6 md:px-10 pb-4 pt-2">
        <div className="max-w-4xl mx-auto flex flex-col gap-2">
          {/* Docked ask_user_question card — sits flush above the composer,
              same width. Render the first pending question that belongs to the
              active conversation and whose owning message can be located. */}
          {/* A question that leaves the focus with a user who is writing is read out from here.
              The element is on the page before the question arrives, or nothing is read. */}
          <div aria-live="polite" aria-atomic="true" className="sr-only">
            {arrivedQuestion && (
              <>
                <span>{arrivedQuestion.header}</span>
                {' '}
                <span>{arrivedQuestion.question}</span>
              </>
            )}
          </div>
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
                onSubmitted={handleQuestionSubmitted}
                onArrivedWithoutFocus={setArrivedQuestion}
              />
            );
          })()}
          {/* Optimistic "resuming" flash — only in the gap before the loop sets
              a real status, so it never stacks with AgentStatusStrip. */}
          {resuming && agentStatus === 'idle' && (
            <div className="flex items-center gap-2 px-3 py-2 text-ui-sm text-label-secondary">
              <StatusIcon tone="success" size="sm" />
              <span className="truncate">{t.chat.resuming}</span>
            </div>
          )}
          {/* Live agent status — compaction / retry, so a slow provider isn't a
              silent dead wait above the composer. */}
          {activeConv.teamId && <TeamMemberBar conversationId={activeConv.id} />}
          {activeConv.teamId && <TeamConfirmationsStrip conversationId={activeConv.id} />}
          <AgentStatusStrip conversationId={activeConv.id} />
          {/* Goal mode: objective, round usage and controls. Keyed by conversation: an inline
              edit or a clearing question opened in one conversation belongs to that one only. */}
          {activeConv.goal && <GoalBar key={activeConv.id} conversationId={activeConv.id} />}
          {/* Staged mid-task messages — cancellable pills at the composer's
              top-right edge; they enter the transcript when the loop drains them */}
          <QueuedMessagesStrip conversationId={activeConv.id} />
          {activeConv.appBinding && appBindingShown(activeConv.appBinding, appsLabOn) && <ConversationAppNotice binding={activeConv.appBinding} />}
          <ChatInput variant="chat" onSend={handleSend} />
          <div className="mt-2 flex items-center justify-center gap-3 overflow-hidden whitespace-nowrap">
            <UsageChip conversationId={activeConv.id} />
            <p className="truncate text-caption text-label-tertiary">
              {t.chat.disclaimer}
            </p>
            <span className="text-caption text-label-tertiary">·</span>
            <ConvIdBadge conversationId={activeConv.id} />
          </div>
        </div>
      </div>
    </div>
  );
}
