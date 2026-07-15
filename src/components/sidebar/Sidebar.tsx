import { useEffect, useLayoutEffect, useCallback, useState, useRef } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useProjectStore } from '@/stores/projectStore';
import { useNoticeBadgeStore } from '@/stores/noticeBadgeStore';
import { useInboxStore } from '@/stores/inboxStore';
import { useI18n } from '@/i18n';
import { useLabsFlag } from '@/core/labs/resolve';
import { LABS_TODOS_INBOX } from '@/core/labs/registry';
import { Plus, Workflow, Wrench, Trash2, Download, Pencil, Undo2, FolderInput, FolderClosed, ChevronRight, Minus, Search, X, CheckSquare, Inbox, ListTree, ArrowLeft } from 'lucide-react';
import GuideModal from '@/components/common/GuideModal';
import ProfileEditModal from '@/components/common/ProfileEditModal';
import AccountMenu from '@/components/sidebar/AccountMenu';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { getPlatformShortLabel } from '@/core/im/platformLabels';
import type { ConversationStatus } from '@/types';
import ProjectsSection from '@/components/sidebar/ProjectsSection';
import WorkspaceFileTree from '@/components/panel/WorkspaceFileTree';
import { usePreviewStore } from '@/stores/previewStore';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import ShareExportDialog from '@/components/share/ShareExportDialog';
import ImportedBadge from './ImportedBadge';
import { isMacOS } from '@/utils/platform';
import { catalogSearch, type SearchHit, type ConversationMeta } from '@/core/session/conversationStorage';
import { renderMarkedText, highlightQuery } from '@/utils/searchHighlight';
import EnterpriseStatusBadge from '@/components/enterprise/EnterpriseStatusBadge';
// Side-effect import: registers BrandSlot in the enterprise mounts registry
import '@/components/enterprise/BrandSlot';

interface StatusIndicatorProps {
  status: ConversationStatus;
  onComplete: () => void;
}

function StatusIndicator({ status, onComplete }: StatusIndicatorProps) {
  useEffect(() => {
    if (status === 'completed') {
      const timer = setTimeout(onComplete, 3000);
      return () => clearTimeout(timer);
    }
    if (status === 'error') {
      // Auto-clear error indicator after 10 seconds (user has seen it)
      const timer = setTimeout(onComplete, 10_000);
      return () => clearTimeout(timer);
    }
  }, [status, onComplete]);

  if (status === 'running') {
    return <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />;
  }
  if (status === 'completed') {
    return <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />;
  }
  if (status === 'error') {
    return <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />;
  }
  return null;
}

function IMPlatformDot({ platform }: { platform: string }) {
  return (
    <span
      className="shrink-0 h-4 w-4 rounded text-[8px] font-bold leading-4 text-center bg-[var(--abu-clay-bg-15)] text-[var(--abu-clay)]"
      title={platform}
    >
      {getPlatformShortLabel(platform)}
    </span>
  );
}

interface ConversationRowProps {
  conv: ConversationMeta;
  /** `conv.id === activeConversationId && viewMode === 'chat'` — computed by
   * the caller since both `activeConversationId` and `viewMode` live outside
   * this component. */
  isActive: boolean;
  isEditing: boolean;
  status: ConversationStatus;
  /** Set only in search-results mode: highlights matches in the title
   * against this (trimmed) query. `undefined` in plain-recents mode, where
   * the title renders as plain text — identical to pre-unification behavior. */
  titleQuery?: string;
  /** FTS/LIKE body-hit snippet (search-results mode only), rendered below
   * the title. `undefined` for plain recents rows and for search rows that
   * matched by title rather than body. */
  snippet?: React.ReactNode;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onOpenFileTree: () => void;
  onDelete: (e: React.MouseEvent) => void;
  onRenameCommit: (title: string) => void;
  onRenameCancel: () => void;
  onStatusComplete: () => void;
}

/**
 * Single conversation row shared by BOTH the plain recents list and the
 * search-results list. Before this was extracted, search-results rows were a
 * stripped-down duplicate (bare title[+snippet], no affordances) — so typing
 * a 1-2 char filter silently lost the context menu, inline rename, delete,
 * move-to-project (via context menu), file-tree shortcut, status dot, and
 * active-conversation highlight that recents rows have. Unifying on one
 * component means any query length keeps full conversation-management
 * affordances.
 */
function ConversationRow({
  conv,
  isActive,
  isEditing,
  status,
  titleQuery,
  snippet,
  onSelect,
  onContextMenu,
  onOpenFileTree,
  onDelete,
  onRenameCommit,
  onRenameCancel,
  onStatusComplete,
}: ConversationRowProps) {
  const { t } = useI18n();
  const displayTitle = conv.title.replace(/\[Attachment:\s*`[^`]*`\]\s*/g, '').trim() || conv.title;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      aria-current={isActive ? 'true' : undefined}
      className={cn(
        'group flex flex-col gap-0.5 px-2 py-2 rounded-lg cursor-pointer transition-colors w-full text-left',
        isActive
          ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
          : 'text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
      )}
    >
      <div className="flex items-center gap-2">
        {conv.imPlatform && (
          <IMPlatformDot platform={conv.imPlatform} />
        )}
        {conv.importedFrom && (
          <ImportedBadge importedAt={conv.importedFrom.importedAt} />
        )}
        {isEditing ? (
          <input
            autoFocus
            defaultValue={conv.title}
            className="flex-1 text-[13px] bg-transparent border-b border-[var(--abu-clay)] outline-none min-w-0"
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const val = e.target.value.trim();
              if (val && val !== conv.title) onRenameCommit(val);
              onRenameCancel();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') onRenameCancel();
            }}
          />
        ) : (
          <span className="flex-1 truncate text-[13px]">
            {titleQuery !== undefined
              ? highlightQuery(displayTitle, titleQuery, 'bg-[var(--abu-clay-bg-15)] text-[var(--abu-clay)] rounded-sm')
              : displayTitle}
          </span>
        )}
        <StatusIndicator status={status} onComplete={onStatusComplete} />
        {conv.workspacePath && (
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => { e.stopPropagation(); onOpenFileTree(); }}
            className="h-5 w-5 opacity-0 group-hover:opacity-100 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)] hover:bg-transparent shrink-0"
            title={t.sidebar.projectFiles}
          >
            <ListTree className="h-3.5 w-3.5" strokeWidth={1.5} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={onDelete}
          className="h-5 w-5 opacity-0 group-hover:opacity-100 text-[var(--abu-text-tertiary)] hover:text-red-500 hover:bg-transparent shrink-0"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
        </Button>
      </div>
      {snippet && (
        <span className="line-clamp-2 text-[12px] leading-snug text-[var(--abu-text-tertiary)]">
          {snippet}
        </span>
      )}
    </div>
  );
}

export default function Sidebar() {
  const conversationIndex = useChatStore((s) => s.conversationIndex);
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const switchConversation = useChatStore((s) => s.switchConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const clearCompletedStatus = useChatStore((s) => s.clearCompletedStatus);
  const exportConversation = useChatStore((s) => s.exportConversation);
  const importConversation = useChatStore((s) => s.importConversation);
  const loadConversation = useChatStore((s) => s.loadConversation);
  const openToolbox = useSettingsStore((s) => s.openToolbox);
  const openAutomation = useSettingsStore((s) => s.openAutomation);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const setViewMode = useSettingsStore((s) => s.setViewMode);
  const clearBadge = useNoticeBadgeStore((s) => s.clear);
  // Badge shows items still requiring user decision (pending), not just unread.
  // Once a user accepts/ignores an item, the count drops even if other items
  // remain unread — matches the "things you still owe a decision on" mental model.
  const pendingInboxCount = useInboxStore((s) => s.getPendingCount());
  const { t } = useI18n();
  const showTodosInbox = useLabsFlag(LABS_TODOS_INBOX);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; convId: string } | null>(null);
  const [shareConvId, setShareConvId] = useState<string | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const moveSubmenuRef = useRef<HTMLDivElement>(null);
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
  const [moveSubmenuStyle, setMoveSubmenuStyle] = useState<React.CSSProperties>({});
  const projectsMap = useProjectStore((s) => s.projects);
  const [recentsCollapsed, setRecentsCollapsed] = useState(false);
  // File-tree mode: the sidebar swaps its conversation list for the active
  // conversation's project file tree (TRAE-style), entered from a per-row
  // folder icon and exited via "back". Clicking a file opens it in the right
  // PreviewPanel — which is a separate column, so the tree stays visible
  // (left tree + right editor), unlike when the tree lived in the swapping
  // right panel.
  const showFileTree = usePreviewStore((s) => s.fileTreeMode);
  const setShowFileTree = usePreviewStore((s) => s.setFileTreeMode);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Backend search (catalogSearch) runs for ANY non-empty query — the
  // backend picks trigram MATCH for ≥3-char queries and a LIKE-based
  // fallback for 1-2 char queries (see search_core's jsdoc-equivalent
  // comment in catalog_db.rs), so there's no length threshold to gate on
  // here anymore.
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const searchTokenRef = useRef(0);
  const trimmedSearchQuery = searchQuery.trim();
  const isFtsSearching = trimmedSearchQuery.length > 0;

  useEffect(() => {
    if (!isFtsSearching) {
      // Bump the token here too: an in-flight request for an abandoned
      // query would otherwise still pass the `searchTokenRef.current ===
      // token` guard below and populate searchHits after the query has been
      // cleared, flashing stale results when the user types a new query.
      searchTokenRef.current++;
      setSearchHits([]);
      return;
    }
    // Bump the token before debouncing so a stale in-flight request (from a
    // previous keystroke) can be told apart from the latest one once both
    // resolve — guards against out-of-order responses overwriting results.
    const token = ++searchTokenRef.current;
    const timer = setTimeout(() => {
      catalogSearch(trimmedSearchQuery).then((hits) => {
        if (searchTokenRef.current === token) {
          setSearchHits(hits);
        }
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [trimmedSearchQuery, isFtsSearching]);

  // Undo delete state
  const [pendingDelete, setPendingDelete] = useState<{ id: string; data: string } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Inline rename state
  const [editingId, setEditingId] = useState<string | null>(null);

  // Guide modal state lives in the store so it can be reopened from Settings ›
  // About. Auto-opens on first launch only (below).
  const guideOpen = useSettingsStore((s) => s.guideOpen);
  const openGuide = useSettingsStore((s) => s.openGuide);
  const closeGuide = useSettingsStore((s) => s.closeGuide);
  const guideCheckedRef = useRef(false);

  useEffect(() => {
    if (guideCheckedRef.current) return;
    // Wait for persist rehydration — guideShown stays false (default) until rehydrated
    const unsub = useSettingsStore.persist.onFinishHydration(() => {
      guideCheckedRef.current = true;
      if (!useSettingsStore.getState().guideShown) {
        openGuide();
      }
    });
    // If already hydrated (e.g. hot reload), check immediately
    if (useSettingsStore.persist.hasHydrated()) {
      guideCheckedRef.current = true;
      if (!useSettingsStore.getState().guideShown) {
        openGuide();
      }
    }
    return unsub;
  }, [openGuide]);

  // Profile edit modal state
  const [profileOpen, setProfileOpen] = useState(false);

  // Close context menu when clicking outside
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => { setContextMenu(null); setShowMoveSubmenu(false); };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [contextMenu]);

  // Clamp context menu inside viewport once its real size is known.
  useLayoutEffect(() => {
    if (!contextMenu) return;
    const el = contextMenuRef.current;
    if (!el) return;
    const margin = 8;
    const rect = el.getBoundingClientRect();
    const overflowX = rect.right - (window.innerWidth - margin);
    const overflowY = rect.bottom - (window.innerHeight - margin);
    if (overflowX <= 0 && overflowY <= 0) return;
    setContextMenu((prev) => prev && {
      ...prev,
      x: Math.max(margin, prev.x - Math.max(0, overflowX)),
      y: Math.max(margin, prev.y - Math.max(0, overflowY)),
    });
  }, [contextMenu]);

  // Position "move to project" submenu: clamp to viewport, flip up when there isn't enough space below.
  useLayoutEffect(() => {
    if (!showMoveSubmenu) { setMoveSubmenuStyle({}); return; }
    const el = moveSubmenuRef.current;
    const trigger = el?.parentElement;
    if (!el || !trigger) return;
    const margin = 8;
    const triggerRect = trigger.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const spaceBelow = viewportH - triggerRect.top - margin;
    const spaceAbove = triggerRect.bottom - margin;
    const contentH = el.scrollHeight;
    const flipUp = contentH > spaceBelow && spaceAbove > spaceBelow;
    const maxH = Math.max(120, flipUp ? spaceAbove : spaceBelow);
    setMoveSubmenuStyle(flipUp
      ? { bottom: 0, top: 'auto', maxHeight: `${maxH}px` }
      : { top: 0, maxHeight: `${maxH}px` });
  }, [showMoveSubmenu]);

  // Sort by createdAt to keep positions stable during status updates
  // Filter out conversations belonging to projects, scheduled tasks, or triggers — they appear in their own sections
  // Use conversationIndex (lightweight metadata) instead of full conversations for listing
  const sortedConvs = Object.values(conversationIndex)
    .filter((c) => !c.scheduledTaskId && !c.triggerId && !c.projectId)
    .filter((c) => !trimmedSearchQuery || c.title.toLowerCase().includes(trimmedSearchQuery.toLowerCase()))
    .sort((a, b) => b.createdAt - a.createdAt);

  // FTS/LIKE body-hit results (any non-empty query), scoped and deduped
  // against `sortedConvs`'s instant title matches:
  //  - Title matches always come from `sortedConvs` (already scoped to
  //    exclude project/scheduled/trigger convs), so they render reliably even
  //    if the SQLite catalog is cold/uninitialized/failed — never "No
  //    matches" for a plainly-existing title.
  //  - `searchHits` (FTS body hits) are filtered to the same project/
  //    scheduled/trigger exclusion so search never leaks a conversation that
  //    the recents list deliberately hides, then deduped against the title
  //    matches so nothing shows twice.
  const titleMatchIds = new Set(sortedConvs.map((c) => c.id));
  const scopedBodyHits = isFtsSearching
    ? searchHits.filter((hit) => {
        if (titleMatchIds.has(hit.conv_id)) return false;
        const meta = conversationIndex[hit.conv_id];
        if (meta?.projectId || meta?.scheduledTaskId || meta?.triggerId) return false;
        return true;
      })
    : [];

  const handleDeleteConversation = async (e: React.MouseEvent, convId: string) => {
    e.stopPropagation();
    // Ensure conversation is loaded before exporting for undo
    await loadConversation(convId);
    // Save conversation data for undo before deleting
    const json = exportConversation(convId);
    deleteConversation(convId);
    if (json) {
      // Cancel any previous undo timer
      clearTimeout(undoTimerRef.current);
      setPendingDelete({ id: convId, data: json });
      undoTimerRef.current = setTimeout(() => setPendingDelete(null), 5000);
    }
  };

  const handleUndoDelete = () => {
    if (pendingDelete) {
      importConversation(pendingDelete.data);
      clearTimeout(undoTimerRef.current);
      setPendingDelete(null);
    }
  };

  const handleClearCompletedStatus = useCallback((convId: string) => {
    clearCompletedStatus(convId);
  }, [clearCompletedStatus]);

  const handleContextMenu = (e: React.MouseEvent, convId: string) => {
    e.preventDefault();
    e.stopPropagation();
    // Initial position — useLayoutEffect below fine-tunes after measuring real size.
    setContextMenu({ x: e.clientX, y: e.clientY, convId });
  };

  const handleExport = async (convId: string) => {
    // Ensure the conversation is loaded before the dialog reads from it;
    // the dialog itself will call exportConversationForShare which also
    // guards with loadConversation, but awaiting here means the dialog
    // opens straight into the "ready" state when possible.
    await loadConversation(convId);
    setShareConvId(convId);
    setContextMenu(null);
  };

  const handleImport = async () => {
    try {
      const filePath = await openDialog({
        filters: [{ name: 'JSON', extensions: ['json'] }],
        multiple: false,
      });
      if (filePath) {
        const json = await readTextFile(filePath as string);
        importConversation(json);
      }
    } catch (err) {
      console.error('Import failed:', err);
    }
  };

  return (
    <div className="flex flex-col h-full w-[260px] bg-[var(--abu-bg-subtle)] border-r border-[var(--abu-border)]">
      {/* Drag region — covers the title bar area above sidebar content */}
      <div
        data-tauri-drag-region
        className={isMacOS() ? 'h-11 shrink-0' : 'h-8 shrink-0'}
      />
      {/* Top Navigation */}
      <nav className="px-4 pb-2 space-y-0.5" aria-label="Main navigation">
        <button
          onClick={() => { startNewConversation(); setViewMode('chat'); setShowFileTree(false); }}
          className={cn(
            'btn-ghost flex items-center gap-3 w-full px-3 py-2.5 text-[14px] font-medium rounded-lg',
            activeConversationId === null && viewMode === 'chat'
              ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
              : 'text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]'
          )}
        >
          <Plus className={cn('h-[18px] w-[18px]', activeConversationId === null && viewMode === 'chat' ? 'text-[var(--abu-clay)]' : 'text-[var(--abu-text-tertiary)]')} strokeWidth={2} />
          <span>{t.sidebar.newTask}</span>
        </button>
        {showTodosInbox && (
          <>
            <button
              onClick={() => setViewMode('todos')}
              className={cn(
                'btn-ghost flex items-center gap-3 w-full px-3 py-2.5 text-[14px] rounded-lg',
                viewMode === 'todos'
                  ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
                  : 'text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
              )}
            >
              <CheckSquare className={cn('h-[18px] w-[18px]', viewMode === 'todos' ? 'text-[var(--abu-clay)]' : 'text-[var(--abu-text-tertiary)]')} strokeWidth={1.75} />
              <span>{t.sidebar.todos}</span>
            </button>
            <button
              onClick={() => setViewMode('inbox')}
              className={cn(
                'btn-ghost flex items-center gap-3 w-full px-3 py-2.5 text-[14px] rounded-lg',
                viewMode === 'inbox'
                  ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
                  : 'text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
              )}
            >
              <Inbox className={cn('h-[18px] w-[18px]', viewMode === 'inbox' ? 'text-[var(--abu-clay)]' : 'text-[var(--abu-text-tertiary)]')} strokeWidth={1.75} />
              <span className="flex-1 text-left">{t.sidebar.inbox}</span>
              {pendingInboxCount > 0 && (
                <span className="min-w-[18px] h-[18px] px-1.5 rounded-full bg-red-500 text-white text-[11px] font-medium leading-[18px] text-center">
                  {pendingInboxCount > 99 ? '99+' : pendingInboxCount}
                </span>
              )}
            </button>
          </>
        )}
        <button
          onClick={() => { openToolbox(); setShowFileTree(false); }}
          className={cn(
            'btn-ghost flex items-center gap-3 w-full px-3 py-2.5 text-[14px] rounded-lg',
            viewMode === 'toolbox'
              ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
              : 'text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
          )}
        >
          <Wrench className={cn('h-[18px] w-[18px]', viewMode === 'toolbox' ? 'text-[var(--abu-clay)]' : 'text-[var(--abu-text-tertiary)]')} strokeWidth={1.75} />
          <span>{t.sidebar.toolbox}</span>
        </button>
        <button
          onClick={() => { openAutomation(); setShowFileTree(false); }}
          className={cn(
            'btn-ghost flex items-center gap-3 w-full px-3 py-2.5 text-[14px] rounded-lg',
            viewMode === 'automation'
              ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
              : 'text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
          )}
        >
          <Workflow className={cn('h-[18px] w-[18px]', viewMode === 'automation' ? 'text-[var(--abu-clay)]' : 'text-[var(--abu-text-tertiary)]')} strokeWidth={1.75} />
          <span>{t.sidebar.automation}</span>
        </button>
      </nav>

      {/* File-tree mode swaps the whole conversation list for the active
          conversation's project file tree (TRAE-style). Files open in the
          right PreviewPanel, so the tree (here in the sidebar) stays put. */}
      {showFileTree ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <button
            onClick={() => setShowFileTree(false)}
            className="flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
            <span>{t.sidebar.backToConversations}</span>
          </button>
          <div className="flex-1 min-h-0 px-4">
            <WorkspaceFileTree />
          </div>
        </div>
      ) : (
      /* Scrollable middle section: projects + scheduled + triggers + recents */
      <ScrollArea className="flex-1 min-h-0">
        {/* Projects Section */}
        <ProjectsSection />

        {/* Recents Section */}
        <div className="px-4 pt-2 pb-0">
          <div className="group flex items-center justify-between pr-1">
            <button
              onClick={() => setRecentsCollapsed(!recentsCollapsed)}
              className="flex items-center gap-1 px-2 py-1.5 text-[13px] font-medium text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
            >
              <span>{t.sidebar.recents}</span>
            </button>
            {!recentsCollapsed && (
              <div className="flex items-center gap-0.5">
                {/* Import is a rare action — revealed only on row hover (or keyboard focus) to keep the header clean */}
                <button
                  onClick={handleImport}
                  className="p-1 rounded hover:bg-[var(--abu-bg-hover)] text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                  title={t.sidebar.importSession}
                >
                  <FolderInput className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
                <button
                  // preventDefault keeps the input from blurring first when the
                  // toggle is clicked to close — otherwise the input's onBlur
                  // (auto-close-when-empty) would fire and this onClick would
                  // immediately re-open it.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    const next = !searchOpen;
                    setSearchOpen(next);
                    if (!next) setSearchQuery('');
                    else setTimeout(() => searchInputRef.current?.focus(), 0);
                  }}
                  className="p-1 rounded hover:bg-[var(--abu-bg-hover)] text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
                  title={t.sidebar.searchPlaceholder}
                >
                  <Search className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Search Box */}
        {!recentsCollapsed && searchOpen && (
          <div className="px-4 pt-1 pb-1">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSearchQuery('');
                    setSearchOpen(false);
                  }
                }}
                // Click away from an empty search box → collapse it (natural
                // dismiss). Only when empty: with a query typed there are result
                // rows whose click must land before the box unmounts, and the X
                // button's mousedown-preventDefault keeps focus so clearing then
                // clicking away still closes.
                onBlur={() => {
                  if (!searchQuery.trim()) setSearchOpen(false);
                }}
                placeholder={t.sidebar.searchPlaceholder}
                className="w-full h-7 pl-8 pr-7 rounded-md text-xs bg-[var(--abu-bg-muted)] border border-[var(--abu-border-subtle)] focus:border-[var(--abu-clay-40)] focus:outline-none text-[var(--abu-text-primary)] placeholder:text-[var(--abu-text-muted)]"
              />
              {searchQuery && (
                <button
                  // Keep input focus so clearing doesn't blur-close, and so a
                  // subsequent click-away still collapses the (now empty) box.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Conversation List — replaced by a merged title-match + FTS5/LIKE
            body-hit result list while any non-empty query is active (see
            isFtsSearching effect above and the scopedBodyHits comment). */}
        {!recentsCollapsed && isFtsSearching && (
        <div className="px-4">
          <div className="px-2 py-1.5 text-[13px] font-medium text-[var(--abu-text-muted)]">
            {t.sidebar.searchResults}
          </div>
          {sortedConvs.length === 0 && scopedBodyHits.length === 0 ? (
            <div className="px-2 py-3">
              <p className="text-[13px] text-[var(--abu-text-tertiary)]">{t.sidebar.searchNoResults}</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {sortedConvs.map((conv) => {
                const convStatus = conversations[conv.id]?.status ?? 'idle';
                return (
                  <ConversationRow
                    key={conv.id}
                    conv={conv}
                    isActive={conv.id === activeConversationId && viewMode === 'chat'}
                    isEditing={editingId === conv.id}
                    status={convStatus}
                    titleQuery={trimmedSearchQuery}
                    onSelect={() => { switchConversation(conv.id); setViewMode('chat'); clearBadge(conv.id); if (convStatus === 'error') clearCompletedStatus(conv.id); }}
                    onContextMenu={(e) => handleContextMenu(e, conv.id)}
                    onOpenFileTree={() => { switchConversation(conv.id); setViewMode('chat'); clearBadge(conv.id); setShowFileTree(true); }}
                    onDelete={(e) => handleDeleteConversation(e, conv.id)}
                    onRenameCommit={(title) => renameConversation(conv.id, title)}
                    onRenameCancel={() => setEditingId(null)}
                    onStatusComplete={() => handleClearCompletedStatus(conv.id)}
                  />
                );
              })}
              {scopedBodyHits.map((hit) => {
                const meta = conversationIndex[hit.conv_id];
                if (!meta) return null;
                const convStatus = conversations[hit.conv_id]?.status ?? 'idle';
                return (
                  <ConversationRow
                    key={hit.conv_id}
                    conv={meta}
                    isActive={hit.conv_id === activeConversationId && viewMode === 'chat'}
                    isEditing={editingId === hit.conv_id}
                    status={convStatus}
                    titleQuery={trimmedSearchQuery}
                    snippet={renderMarkedText(hit.snippet, 'bg-[var(--abu-clay-bg-15)] text-[var(--abu-clay)] rounded-sm')}
                    onSelect={() => { switchConversation(hit.conv_id); setViewMode('chat'); clearBadge(hit.conv_id); if (convStatus === 'error') clearCompletedStatus(hit.conv_id); }}
                    onContextMenu={(e) => handleContextMenu(e, hit.conv_id)}
                    onOpenFileTree={() => { switchConversation(hit.conv_id); setViewMode('chat'); clearBadge(hit.conv_id); setShowFileTree(true); }}
                    onDelete={(e) => handleDeleteConversation(e, hit.conv_id)}
                    onRenameCommit={(title) => renameConversation(hit.conv_id, title)}
                    onRenameCancel={() => setEditingId(null)}
                    onStatusComplete={() => handleClearCompletedStatus(hit.conv_id)}
                  />
                );
              })}
            </div>
          )}
        </div>
        )}

        {!recentsCollapsed && !isFtsSearching && (
        <div className="px-4">
        {sortedConvs.length === 0 ? (
          <div className="px-4 py-3">
            <p className="text-[13px] text-[var(--abu-text-tertiary)]">{t.sidebar.noSessionsYet}</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {sortedConvs.map((conv) => {
              // Look up runtime status from loaded conversations (ConversationMeta doesn't have status)
              const convStatus = conversations[conv.id]?.status ?? 'idle';
              return (
                <ConversationRow
                  key={conv.id}
                  conv={conv}
                  isActive={conv.id === activeConversationId && viewMode === 'chat'}
                  isEditing={editingId === conv.id}
                  status={convStatus}
                  onSelect={() => { switchConversation(conv.id); setViewMode('chat'); clearBadge(conv.id); if (convStatus === 'error') clearCompletedStatus(conv.id); }}
                  onContextMenu={(e) => handleContextMenu(e, conv.id)}
                  onOpenFileTree={() => { switchConversation(conv.id); setViewMode('chat'); clearBadge(conv.id); setShowFileTree(true); }}
                  onDelete={(e) => handleDeleteConversation(e, conv.id)}
                  onRenameCommit={(title) => renameConversation(conv.id, title)}
                  onRenameCancel={() => setEditingId(null)}
                  onStatusComplete={() => handleClearCompletedStatus(conv.id)}
                />
              );
            })}
          </div>
        )}
        </div>
        )}
      </ScrollArea>
      )}

      {/* Enterprise status badge — shown above user section when in enterprise mode */}
      <EnterpriseStatusBadge />

      {/* User Section — single avatar trigger opening the account popover */}
      <div className="px-3 py-3 shrink-0">
        <AccountMenu onEditProfile={() => setProfileOpen(true)} />
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-[var(--abu-bg-base)] rounded-lg shadow-lg border border-[var(--abu-border)] py-1 min-w-[140px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => {
              setEditingId(contextMenu.convId);
              setContextMenu(null);
            }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-active)]"
          >
            <Pencil className="h-3.5 w-3.5" />
            {t.sidebar.renameConversation}
          </button>
          <button
            onClick={() => handleExport(contextMenu.convId)}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-active)]"
          >
            <Download className="h-3.5 w-3.5" />
            {t.sidebar.exportConversation}
          </button>
          {/* Move to project — submenu with project list */}
          {(() => {
            const activeProjects = Object.values(projectsMap).filter(p => !p.archived);
            if (activeProjects.length === 0) return null;
            const convMeta = conversationIndex[contextMenu.convId];
            return (
              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setShowMoveSubmenu(!showMoveSubmenu); }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-active)]"
                >
                  <FolderInput className="h-3.5 w-3.5" />
                  <span className="flex-1 text-left">{t.project.moveToProject}</span>
                  <ChevronRight className="h-3 w-3" />
                </button>
                {showMoveSubmenu && (
                  <div
                    ref={moveSubmenuRef}
                    style={moveSubmenuStyle}
                    className="absolute left-full ml-1 bg-[var(--abu-bg-base)] rounded-lg shadow-lg border border-[var(--abu-border)] py-1 min-w-[140px] overflow-y-auto overscroll-contain z-10"
                  >
                    {activeProjects.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          useChatStore.getState().setConversationProject(contextMenu.convId, p.id);
                          setContextMenu(null);
                          setShowMoveSubmenu(false);
                        }}
                        className={cn(
                          'flex items-center gap-2 w-full px-3 py-1.5 text-[13px] hover:bg-[var(--abu-bg-active)]',
                          convMeta?.projectId === p.id ? 'text-[var(--abu-clay)]' : 'text-[var(--abu-text-secondary)]'
                        )}
                      >
                        <FolderClosed className="h-3.5 w-3.5" strokeWidth={1.5} />
                        <span className="truncate">{p.name}</span>
                      </button>
                    ))}
                    {convMeta?.projectId && (
                      <>
                        <div className="my-1 border-t border-[var(--abu-border)]" />
                        <button
                          onClick={() => {
                            useChatStore.getState().setConversationProject(contextMenu.convId, undefined);
                            setContextMenu(null);
                            setShowMoveSubmenu(false);
                          }}
                          className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-active)]"
                        >
                          <Minus className="h-3.5 w-3.5" />
                          {t.project.removeFromProject}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
          <button
            onClick={(e) => {
              handleDeleteConversation(e, contextMenu.convId);
              setContextMenu(null);
            }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-red-500 hover:bg-[var(--abu-bg-active)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t.sidebar.deleteConversation}
          </button>
        </div>
      )}

      {/* Guide modal */}
      <GuideModal
        open={guideOpen}
        onClose={() => closeGuide()}
        onNavigateToAIServices={() => {
          useSettingsStore.getState().openSystemSettings('ai-services');
        }}
      />

      {/* Profile edit modal */}
      <ProfileEditModal open={profileOpen} onClose={() => setProfileOpen(false)} />

      {/* Share export preview */}
      {shareConvId && (
        <ShareExportDialog
          convId={shareConvId}
          defaultFilename={`abu-conversation-${conversationIndex[shareConvId]?.title || shareConvId}.abu.json`}
          onClose={() => setShareConvId(null)}
        />
      )}


      {/* Undo delete toast */}
      {pendingDelete && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 bg-[var(--abu-text-primary)] text-white rounded-xl shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200" role="alert" aria-live="assertive">
          <span className="text-sm">{t.sidebar.conversationDeleted}</span>
          <button
            onClick={handleUndoDelete}
            className="flex items-center gap-1 text-sm font-medium text-[var(--abu-clay)] hover:text-[var(--abu-clay)] transition-colors"
          >
            <Undo2 className="h-3.5 w-3.5" />
            {t.sidebar.undo}
          </button>
        </div>
      )}
    </div>
  );
}
