import { useEffect, useRef, useState, useCallback } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { getVisibleTabs, isTabVisibleFor, useHasTabs, usePreviewStore } from '@/stores/previewStore';
import { useActiveConversation } from '@/stores/chatStore';
import { cn } from '@/lib/utils';
import WorkspacePanel from './workspace/WorkspacePanel';
import {
  PREVIEW_MIN_WIDTH,
  clampChatWidth,
  resolveChatWidth,
  getViewportWidth,
} from './panelWidths';

// Narrow mode (task summary / empty) keeps its own fixed, resizable width.
// Wide content (preview / browser / terminal) flex-fills and the chat owns its width.
const PANEL_WIDTH = 320;          // Default width when showing the summary / empty state
const MIN_PANEL_WIDTH = 260;      // Lower bound when dragging the narrow panel
const MAX_PANEL_WIDTH = 560;      // Upper bound for the narrow panel

export default function RightPanel() {
  const collapsed = useSettingsStore((s) => s.rightPanelCollapsed);
  const setRightPanelCollapsed = useSettingsStore((s) => s.setRightPanelCollapsed);
  const viewMode = useSettingsStore((s) => s.viewMode);
  // `visibleTabs`, not `tabs`: a browser tab adopted for ANOTHER conversation
  // stays in the store (its native view is alive) but is not this
  // conversation's content and must not size or open this conversation's panel.
  const hasAnyTab = useHasTabs();
  // "Wide" content (preview/browser/terminal) flex-fills; the summary tab and
  // the empty state stay at the narrow fixed width.
  const hasWideContent = usePreviewStore(
    (s) => s.tabs.some((t) => t.kind !== 'summary' && isTabVisibleFor(t, s.currentConversationId)),
  );
  // The conversation the tab set is currently scoped to. Read from the STORE
  // (not `conversationId` below, which is the chat's active conversation and
  // changes one commit earlier): this and `hasWideContent` come from the same
  // store snapshot, so they always move together in a single commit. The
  // wide-content effect relies on that to tell "content appeared" apart from
  // "a different conversation's tabs came into view".
  const scopedConversationId = usePreviewStore((s) => s.currentConversationId);
  const conversation = useActiveConversation();
  const prevHasMessagesRef = useRef(false);
  // Track whether auto-expand already fired for this conversation
  const autoExpandedRef = useRef(false);
  // Track whether the default summary tab has been opened for this conversation
  const summaryInitedRef = useRef(false);

  // Drag resize state — use refs for event handlers to avoid stale closures
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragWidthRef = useRef<number | null>(null);
  const moveHandlerRef = useRef<((ev: MouseEvent) => void) | null>(null);
  const upHandlerRef = useRef<(() => void) | null>(null);

  // Keep ref in sync with state
  useEffect(() => { dragWidthRef.current = dragWidth; }, [dragWidth]);

  // Cleanup on unmount — remove any lingering listeners
  useEffect(() => {
    return () => {
      if (moveHandlerRef.current) document.removeEventListener('mousemove', moveHandlerRef.current);
      if (upHandlerRef.current) document.removeEventListener('mouseup', upHandlerRef.current);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    // Only respond to left mouse button
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    // Clean up any previous listeners first
    if (moveHandlerRef.current) document.removeEventListener('mousemove', moveHandlerRef.current);
    if (upHandlerRef.current) document.removeEventListener('mouseup', upHandlerRef.current);

    const startX = e.clientX;
    // Wide content flex-fills, so the divider resizes the chat; otherwise it
    // resizes the narrow panel itself.
    const isWide = getVisibleTabs().some((t) => t.kind !== 'summary');
    const sidebarOpen = !useSettingsStore.getState().sidebarCollapsed;

    setIsDragging(true);

    let onMouseMove: (ev: MouseEvent) => void;
    if (isWide) {
      // Wide mode: the divider resizes the CHAT column (content flex-fills the rest).
      const startChat = resolveChatWidth(usePreviewStore.getState().chatWidth, getViewportWidth(), sidebarOpen);
      onMouseMove = (ev) => {
        ev.preventDefault();
        const next = clampChatWidth(startChat + (ev.clientX - startX), getViewportWidth(), sidebarOpen);
        usePreviewStore.getState().setChatWidth(next);
      };
    } else {
      // Narrow mode: the divider resizes the panel itself.
      const startWidth = dragWidthRef.current ?? PANEL_WIDTH;
      onMouseMove = (ev) => {
        ev.preventDefault();
        const delta = startX - ev.clientX;
        const newWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, startWidth + delta));
        setDragWidth(newWidth);
      };
    }

    const onMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      moveHandlerRef.current = null;
      upHandlerRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    moveHandlerRef.current = onMouseMove;
    upHandlerRef.current = onMouseUp;

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  // Check if conversation has started (has messages)
  const hasMessages = (conversation?.messages?.length ?? 0) > 0;

  // Conversation has a workspace → panel is meaningful
  const hasWorkspace = !!conversation?.workspacePath;

  // Reset per-conversation flags when switching conversations.
  // Also auto-collapse if new conversation has no workspace.
  const conversationId = conversation?.id ?? null;
  useEffect(() => {
    autoExpandedRef.current = false;
    summaryInitedRef.current = false;
    if (!conversation?.workspacePath && !collapsed) {
      setRightPanelCollapsed(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Close the conversation-scoped workspace tabs when switching conversations
  // (summary / preview / terminal / subagent). Defined BEFORE the summary-open
  // effect so that runs against a cleared tab list.
  //
  // Browser tabs are exempt: their native view is a page an agent may still be
  // driving in the background, and closing the tab destroyed it mid-task
  // (losing the page, its login state and any typed form data) — the panel's
  // per-conversation reset must not reach into the agent's runtime. Passing the
  // conversation id re-scopes visibility instead: an agent tab adopted for
  // another conversation goes hidden here and comes back when the user does.
  useEffect(() => {
    usePreviewStore.getState().closeTabsForConversationSwitch(conversationId);
  }, [conversationId]);

  // Default the panel to the "task summary" tab: once per conversation, when the
  // panel is visible (expanded, has messages) and no tab is open yet. Closing
  // the summary tab afterwards leaves the "从这里开始" empty state (not reopened).
  useEffect(() => {
    if (collapsed || !hasMessages || summaryInitedRef.current) return;
    // "No tab" means no tab THIS conversation can see: another conversation's
    // surviving agent browser tab must not suppress this one's summary.
    if (getVisibleTabs().length === 0) {
      summaryInitedRef.current = true;
      usePreviewStore.getState().openSummary();
    }
  }, [collapsed, hasMessages, conversationId]);

  // Auto-expand: only when workspace is attached (meaningful context)
  // Tool calls alone don't justify opening an empty panel
  // Only fires once per conversation — does not fight manual collapse
  useEffect(() => {
    if (autoExpandedRef.current || !collapsed || !hasMessages) return;
    if (hasWorkspace) {
      autoExpandedRef.current = true;
      setRightPanelCollapsed(false);
    }
  }, [hasMessages, hasWorkspace, collapsed, setRightPanelCollapsed]);

  // Track message state for rendering logic
  useEffect(() => {
    prevHasMessagesRef.current = hasMessages;
  }, [hasMessages]);

  // Auto-expand right panel + collapse left sidebar when WIDE content opens
  // (preview/browser/terminal — not the summary tab, which is the default and
  // shouldn't fight the sidebar), and reset the drag width whenever the panel
  // crosses between the narrow and wide layouts.
  //
  // Both react to the SAME edge, so they share one guard: only a narrow↔wide
  // flip WITHIN one conversation counts. A conversation switch swaps the whole
  // visible tab set at once, and the resulting flip is not the user opening or
  // closing anything — it is a conversation's own layout leaving and coming
  // back. Treating that as an open would re-expand the panel and re-collapse
  // the sidebar on every return to a conversation with an agent browser tab,
  // overriding a collapse the user had just made.
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const wideEdgeRef = useRef<{ conversationId: string | null; wide: boolean } | null>(null);
  useEffect(() => {
    const previous = wideEdgeRef.current;
    // Re-seed first: after a switch, whatever this conversation already had
    // open becomes the new baseline rather than an edge.
    wideEdgeRef.current = { conversationId: scopedConversationId, wide: hasWideContent };
    if (!previous || previous.conversationId !== scopedConversationId) return;
    if (previous.wide === hasWideContent) return;

    setDragWidth(null);
    if (!hasWideContent) return;
    if (collapsed) setRightPanelCollapsed(false);
    // In file-tree mode the sidebar hosts the tree the user is browsing, so
    // collapsing it on file-open would hide the tree — keep it open then.
    if (!sidebarCollapsed && !usePreviewStore.getState().fileTreeMode) toggleSidebar();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasWideContent, scopedConversationId]);

  // Narrow-panel width (only meaningful when NOT wide — in wide mode the panel
  // flex-fills and the chat owns the width).
  const currentWidth = dragWidth ?? PANEL_WIDTH;

  // Hide the panel when collapsed (the toggle lives in the title bar), when the
  // app is not on the chat view, or before a conversation has anything to show.
  //
  // HIDE, never unmount: unmounting tears down every tab body, and a browser
  // tab body owns a live native webview an agent may be driving. Same
  // keep-alive contract WorkspacePanel already applies to its inactive tabs —
  // the hidden placeholder yields a zero rect, which is exactly the signal
  // BrowserTab uses to hide its native layer.
  const panelHidden = viewMode !== 'chat' || (!hasMessages && !hasAnyTab) || collapsed;

  // When expanded, render the tabbed workspace.
  // Wide content: flex-fill the space the chat column leaves (chat owns width).
  // Summary / empty: fixed, resizable width.
  return (
    <div
      data-abu-right-panel
      data-electron-no-drag
      hidden={panelHidden}
      className={cn(
        // Raised content card floating on the canvas (matches dev's panel redesign):
        // margins on 3 sides + rounded/border/shadow. No h-full — flex fills height
        // minus the margins.
        'bg-[var(--abu-bg-base)] flex overflow-hidden relative',
        'mt-2 mb-2 mr-2 rounded-[var(--abu-radius-panel)] border border-[var(--abu-border)] shadow-[var(--abu-shadow-card)]',
        hasWideContent ? 'flex-1 min-w-0' : 'shrink-0',
      )}
      style={
        // Inline `display: none` (not just the `hidden` attribute): the layout
        // classes above set `display: flex`, which would otherwise win over the
        // UA stylesheet's `[hidden] { display: none }`.
        panelHidden
          ? { display: 'none' }
          : hasWideContent
            ? { minWidth: PREVIEW_MIN_WIDTH }
            : { width: currentWidth, minWidth: currentWidth, maxWidth: currentWidth, transition: isDragging ? 'none' : 'width 200ms, min-width 200ms, max-width 200ms' }
      }
    >
      {/* Full-screen overlay during drag — blocks iframe/webview from stealing mouse events */}
      {isDragging && (
        <div data-electron-no-drag className="fixed inset-0 z-50 cursor-col-resize select-none" />
      )}
      {/* Drag handle on left edge */}
      <div
        onMouseDown={handleDragStart}
        className={cn(
          'absolute left-0 top-0 bottom-0 w-[5px] cursor-col-resize z-20 select-none',
          'hover:bg-[var(--abu-clay-20)] transition-colors',
          isDragging && 'bg-[var(--abu-clay-40)]'
        )}
      />
      {/* Panel content — always the tabbed workspace (summary is the default tab) */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <WorkspacePanel />
      </div>
    </div>
  );
}
