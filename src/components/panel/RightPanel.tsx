import { useEffect, useRef, useState, useCallback } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useActiveConversation } from '@/stores/chatStore';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import TaskProgressPanel from './TaskProgressPanel';
import WorkspaceSection from './WorkspaceSection';
import ContextSection from './ContextSection';
import PreviewPanel from './PreviewPanel';
import {
  PREVIEW_MIN_WIDTH,
  clampChatWidth,
  resolveChatWidth,
  getViewportWidth,
} from './panelWidths';

// Details mode (workspace/context sidebar) keeps its own fixed, resizable width.
// This is NOT a file preview — the chat still flex-fills to its left.
const PANEL_WIDTH = 280;          // Default width of the details panel
const MIN_PANEL_WIDTH = 220;      // Lower bound when dragging the details panel
const MAX_PANEL_WIDTH = 520;      // Upper bound for the details panel

export default function RightPanel() {
  const collapsed = useSettingsStore((s) => s.rightPanelCollapsed);
  const setRightPanelCollapsed = useSettingsStore((s) => s.setRightPanelCollapsed);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const previewFilePath = usePreviewStore((s) => s.previewFilePath);
  const conversation = useActiveConversation();
  const prevHasMessagesRef = useRef(false);
  // Track whether auto-expand already fired for this conversation
  const autoExpandedRef = useRef(false);

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
    const isPreview = !!usePreviewStore.getState().previewFilePath;
    const sidebarOpen = !useSettingsStore.getState().sidebarCollapsed;

    setIsDragging(true);

    let onMouseMove: (ev: MouseEvent) => void;
    if (isPreview) {
      // Preview mode: the divider resizes the CHAT column (preview flex-fills the rest).
      // Dragging right widens the chat; dragging left narrows it.
      const startChat = resolveChatWidth(usePreviewStore.getState().chatWidth, getViewportWidth(), sidebarOpen);
      onMouseMove = (ev) => {
        ev.preventDefault();
        const next = clampChatWidth(startChat + (ev.clientX - startX), getViewportWidth(), sidebarOpen);
        usePreviewStore.getState().setChatWidth(next);
      };
    } else {
      // Details mode: the divider resizes the details panel itself.
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

  // Reset auto-expand flag when switching conversations
  // Also auto-collapse if new conversation has no workspace
  const conversationId = conversation?.id ?? null;
  useEffect(() => {
    autoExpandedRef.current = false;
    if (!conversation?.workspacePath && !collapsed) {
      setRightPanelCollapsed(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

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

  // Auto-expand right panel + collapse left sidebar when preview opens
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  useEffect(() => {
    if (!previewFilePath) return;
    if (collapsed) setRightPanelCollapsed(false);
    // In file-tree mode the sidebar hosts the tree the user is browsing, so
    // collapsing it on file-open would hide the tree — keep it open then.
    if (!sidebarCollapsed && !usePreviewStore.getState().fileTreeMode) toggleSidebar();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewFilePath]);

  // Close preview when switching conversations
  useEffect(() => {
    usePreviewStore.getState().closePreview();
  }, [conversationId]);

  // Reset drag width when preview mode changes
  const showPreview = !!previewFilePath;
  useEffect(() => {
    setDragWidth(null);
  }, [showPreview]);

  // Details-panel width (only meaningful when NOT previewing — in preview mode the
  // panel flex-fills and the chat owns the width).
  const currentWidth = dragWidth ?? PANEL_WIDTH;

  // Hide panel when not in chat view or no conversation has started yet
  if (viewMode !== 'chat' || (!hasMessages && !showPreview)) {
    return null;
  }

  // When collapsed, render nothing (toggle button is in the title bar)
  if (collapsed) {
    return null;
  }

  // When expanded, render the full panel.
  // Preview mode: flex-fill the space the chat column leaves (chat owns the width).
  // Details mode: fixed, resizable width.
  return (
    <div
      className={cn(
        'bg-[var(--abu-bg-subtle)] h-full flex overflow-hidden relative',
        showPreview ? 'flex-1 min-w-0' : 'shrink-0',
      )}
      style={
        showPreview
          ? { minWidth: PREVIEW_MIN_WIDTH }
          : { width: currentWidth, minWidth: currentWidth, maxWidth: currentWidth, transition: isDragging ? 'none' : 'width 200ms, min-width 200ms, max-width 200ms' }
      }
    >
      {/* Full-screen overlay during drag — blocks iframe from stealing mouse events */}
      {isDragging && (
        <div className="fixed inset-0 z-50 cursor-col-resize select-none" />
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
      {/* Panel content */}
      <div className="flex-1 flex flex-col overflow-hidden border-l border-[var(--abu-border)]">
      {showPreview ? (
        // Preview mode - full panel is preview
        <PreviewPanel />
      ) : (
        // Normal mode - show details sections
        <>
          {/* Scrollable content — pt-8 to clear overlay title bar area */}
          <ScrollArea className="flex-1 min-h-0 pt-5">
            <div className="p-4 space-y-5">
              {/* Progress - only show when has planned steps */}
              <TaskProgressPanel />
              {/* Workspace with files inside */}
              <WorkspaceSection />
              <div className="border-t border-[var(--abu-border)]" />
              <ContextSection />
            </div>
          </ScrollArea>
        </>
      )}
      </div>
    </div>
  );
}
