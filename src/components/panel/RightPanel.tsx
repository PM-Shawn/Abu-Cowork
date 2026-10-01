import { memo, useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { getVisibleTabs, isTabVisibleFor, useHasTabs, usePreviewStore } from '@/stores/previewStore';
import { useChatStore } from '@/stores/chatStore';
import { cn } from '@/lib/utils';
import WorkspacePanel from './workspace/WorkspacePanel';
import {
  PREVIEW_MIN_WIDTH,
  clampChatWidth,
  clampNarrowPanelWidth,
  resolveChatWidth,
  getViewportWidth,
  useViewportWidth,
} from './panelWidths';

// Narrow mode (task summary / empty) keeps its own fixed, resizable width.
// Wide content (preview / browser / terminal) flex-fills and the chat owns its width.
const PANEL_WIDTH = 320;          // Default width when showing the summary / empty state
const MIN_PANEL_WIDTH = 260;      // Lower bound when dragging the narrow panel
const MAX_PANEL_WIDTH = 560;      // Upper bound for the narrow panel

function RightPanelImpl() {
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
  // Primitive values only: the conversation object is replaced on every streamed
  // token, and the whole panel (tab strip, every tab body) would re-render with it.
  const conversationId = useChatStore((s) => {
    const id = s.activeConversationId;
    return id && s.conversations[id] ? id : null;
  });
  // Check if conversation has started (has messages)
  const hasMessages = useChatStore((s) => {
    const id = s.activeConversationId;
    return ((id ? s.conversations[id]?.messages?.length : 0) ?? 0) > 0;
  });
  // Conversation has a workspace → panel is meaningful
  const hasWorkspace = useChatStore((s) => {
    const id = s.activeConversationId;
    return !!(id && s.conversations[id]?.workspacePath);
  });
  const teamId = useChatStore((s) => {
    const id = s.activeConversationId;
    return (id ? s.conversations[id]?.teamId : undefined) ?? null;
  });
  const prevHasMessagesRef = useRef(false);
  // Track whether auto-expand already fired for this conversation
  const autoExpandedRef = useRef(false);
  // Track whether the default summary tab has been opened for this conversation
  const summaryInitedRef = useRef(false);

  // Drag resize state — use refs for event handlers to avoid stale closures
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragWidthRef = useRef<number | null>(null);
  // The move function of the drag in progress (null when not dragging).
  const dragRef = useRef<((clientX: number) => void) | null>(null);

  // Keep ref in sync with state
  useEffect(() => { dragWidthRef.current = dragWidth; }, [dragWidth]);

  // Cleanup on unmount — a drag in progress must not leave its page styles behind
  useEffect(() => {
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (dragRef.current) document.body.style.pointerEvents = '';
    };
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Only respond to left mouse button
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    // Pointer capture keeps every move and the release coming to the handle, also
    // outside the window. An iframe under the pointer (an HTML preview, an embedded
    // app in the chat) would still take the moves for its own document, so the page
    // stops being a pointer target for the length of the drag.
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.pointerEvents = 'none';

    const startX = e.clientX;
    // Wide content flex-fills, so the divider resizes the chat; otherwise it
    // resizes the narrow panel itself.
    const isWide = getVisibleTabs().some((t) => t.kind !== 'summary');
    const sidebarOpen = !useSettingsStore.getState().sidebarCollapsed;

    if (isWide) {
      // Wide mode: the divider resizes the CHAT column (content flex-fills the rest).
      const startChat = resolveChatWidth(usePreviewStore.getState().chatWidth, getViewportWidth(), sidebarOpen);
      dragRef.current = (clientX) => {
        const next = clampChatWidth(startChat + (clientX - startX), getViewportWidth(), sidebarOpen);
        usePreviewStore.getState().setChatWidth(next);
      };
    } else {
      // Narrow mode: the divider resizes the panel itself — bounded by what the
      // chat column can spare, not by MAX_PANEL_WIDTH alone.
      const startWidth = dragWidthRef.current ?? PANEL_WIDTH;
      dragRef.current = (clientX) => {
        const delta = startX - clientX;
        const newWidth = clampNarrowPanelWidth(
          startWidth + delta,
          getViewportWidth(),
          sidebarOpen,
          MIN_PANEL_WIDTH,
          MAX_PANEL_WIDTH,
        );
        setDragWidth(newWidth);
      };
    }

    setIsDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  // Runs on release and again when the capture goes (the browser drops it after a
  // release or a cancelled pointer), so it only acts while a drag is in progress.
  const endDrag = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setIsDragging(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.body.style.pointerEvents = '';
  }, []);

  // Restore before paint so another conversation’s tabs never flash on screen.
  useLayoutEffect(() => {
    const store = usePreviewStore.getState();
    const restored = !!(conversationId && store.panelStateByConversation[conversationId]);
    autoExpandedRef.current = restored || hasWorkspace;
    summaryInitedRef.current = restored;
    store.closeTabsForConversationSwitch(conversationId, !hasWorkspace);
  // Workspace attachment after the switch is handled by the auto-expand effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Default the panel to the "task summary" tab: once per conversation, when the
  // panel is visible (expanded, has messages) and no tab is open yet. Closing
  // the summary tab afterwards leaves the "从这里开始" empty state (not reopened).
  useEffect(() => {
    if (useSettingsStore.getState().rightPanelCollapsed || !hasMessages || summaryInitedRef.current) return;
    // "No tab" means no tab THIS conversation can see: another conversation's
    // surviving agent browser tab must not suppress this one's summary.
    if (getVisibleTabs().length === 0) {
      summaryInitedRef.current = true;
      usePreviewStore.getState().openSummary();
      // Team-pinned conversation: the team overview sits next to the summary
      // and is what the user looks for first ("没看到 Agent 团队标签页").
      if (teamId && conversationId) {
        usePreviewStore.getState().openTeam(conversationId, { activate: true });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  //
  // Re-clamped at render time, the way resolveChatWidth is: a width that was
  // fine when dragged would otherwise keep starving the chat after the window
  // shrinks or the sidebar opens, and would stay shrunk after the space comes
  // back. The default is clamped too — on a small window with the sidebar open,
  // even the untouched 320 leaves the chat below its floor.
  const viewportWidth = useViewportWidth();
  const currentWidth = clampNarrowPanelWidth(
    dragWidth ?? PANEL_WIDTH,
    viewportWidth,
    !sidebarCollapsed,
    MIN_PANEL_WIDTH,
    MAX_PANEL_WIDTH,
  );

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
        'bg-surface flex overflow-hidden relative',
        'mt-2 mb-2 mr-2 rounded-panel shadow-panel',
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
      {/* Drag handle on left edge */}
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={(e) => dragRef.current?.(e.clientX)}
        onPointerUp={endDrag}
        onLostPointerCapture={endDrag}
        className={cn(
          'absolute inset-y-0 left-0 z-sticky w-[5px] cursor-col-resize select-none transition-colors duration-fast hover:bg-control-border',
          isDragging && 'bg-control-border',
        )}
      />
      {/* Panel content — always the tabbed workspace (summary is the default tab) */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <WorkspacePanel />
      </div>
    </div>
  );
}

export default memo(RightPanelImpl);
