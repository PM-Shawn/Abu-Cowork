import { useEffect, useLayoutEffect, useCallback, useState, useRef } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useProjectStore } from '@/stores/projectStore';
import { useNoticeBadgeStore } from '@/stores/noticeBadgeStore';
import { useInboxStore } from '@/stores/inboxStore';
import { useI18n } from '@/i18n';
import { Plus, Workflow, Wrench, Trash2, Settings, Download, Upload, Pencil, Undo2, HelpCircle, FolderInput, FolderClosed, ChevronRight, Minus, Search, X, CheckSquare, Inbox } from 'lucide-react';
import GuideModal from '@/components/common/GuideModal';
import ProfileEditModal from '@/components/common/ProfileEditModal';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { getPlatformShortLabel } from '@/core/im/platformLabels';
import type { ConversationStatus } from '@/types';
import ProjectsSection from '@/components/sidebar/ProjectsSection';
import DefaultUserAvatar from '@/components/common/DefaultUserAvatar';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import ShareExportDialog from '@/components/share/ShareExportDialog';
import ImportedBadge from './ImportedBadge';
import { isMacOS } from '@/utils/platform';
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
  const openSystemSettings = useSettingsStore((s) => s.openSystemSettings);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const setViewMode = useSettingsStore((s) => s.setViewMode);
  const updateInfo = useSettingsStore((s) => s.updateInfo);
  const clearBadge = useNoticeBadgeStore((s) => s.clear);
  // Badge shows items still requiring user decision (pending), not just unread.
  // Once a user accepts/ignores an item, the count drops even if other items
  // remain unread — matches the "things you still owe a decision on" mental model.
  const pendingInboxCount = useInboxStore((s) => s.getPendingCount());
  const { t } = useI18n();

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; convId: string } | null>(null);
  const [shareConvId, setShareConvId] = useState<string | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const moveSubmenuRef = useRef<HTMLDivElement>(null);
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
  const [moveSubmenuStyle, setMoveSubmenuStyle] = useState<React.CSSProperties>({});
  const projectsMap = useProjectStore((s) => s.projects);
  const [recentsCollapsed, setRecentsCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Undo delete state
  const [pendingDelete, setPendingDelete] = useState<{ id: string; data: string } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Inline rename state
  const [editingId, setEditingId] = useState<string | null>(null);

  // Guide modal state — auto-open on first launch only
  const setGuideShown = useSettingsStore((s) => s.setGuideShown);
  const [guideOpen, setGuideOpen] = useState(false);
  const guideCheckedRef = useRef(false);

  useEffect(() => {
    if (guideCheckedRef.current) return;
    // Wait for persist rehydration — guideShown stays false (default) until rehydrated
    const unsub = useSettingsStore.persist.onFinishHydration(() => {
      guideCheckedRef.current = true;
      if (!useSettingsStore.getState().guideShown) {
        setGuideOpen(true);
      }
    });
    // If already hydrated (e.g. hot reload), check immediately
    if (useSettingsStore.persist.hasHydrated()) {
      guideCheckedRef.current = true;
      if (!useSettingsStore.getState().guideShown) {
        setGuideOpen(true);
      }
    }
    return unsub;
  }, []);

  // Profile edit modal state
  const [profileOpen, setProfileOpen] = useState(false);
  const userNickname = useSettingsStore((s) => s.userNickname);
  const userAvatar = useSettingsStore((s) => s.userAvatar);

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
    .filter((c) => !searchQuery || c.title.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => b.createdAt - a.createdAt);

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
          onClick={() => { startNewConversation(); setViewMode('chat'); }}
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
        <button
          onClick={() => openToolbox()}
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
          onClick={() => openAutomation()}
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

      {/* Scrollable middle section: projects + scheduled + triggers + recents */}
      <ScrollArea className="flex-1 min-h-0">
        {/* Projects Section */}
        <ProjectsSection />

        {/* Recents Section */}
        <div className="px-4 pt-2 pb-0">
          <div className="flex items-center justify-between pr-1">
            <button
              onClick={() => setRecentsCollapsed(!recentsCollapsed)}
              className="flex items-center gap-1 px-2 py-1.5 text-[13px] font-medium text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
            >
              <span>{t.sidebar.recents}</span>
            </button>
            {!recentsCollapsed && (
              <button
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
                placeholder={t.sidebar.searchPlaceholder}
                className="w-full h-7 pl-8 pr-7 rounded-md text-xs bg-[var(--abu-bg-muted)] border border-[var(--abu-border-subtle)] focus:border-[var(--abu-clay-40)] focus:outline-none text-[var(--abu-text-primary)] placeholder:text-[var(--abu-text-muted)]"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Conversation List */}
        {!recentsCollapsed && (
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
              <div
                key={conv.id}
                role="button"
                tabIndex={0}
                onClick={() => { switchConversation(conv.id); setViewMode('chat'); clearBadge(conv.id); if (convStatus === 'error') clearCompletedStatus(conv.id); }}
                onContextMenu={(e) => handleContextMenu(e, conv.id)}
                aria-current={conv.id === activeConversationId && viewMode === 'chat' ? 'true' : undefined}
                className={cn(
                  'group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors w-full text-left',
                  conv.id === activeConversationId && viewMode === 'chat'
                    ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
                    : 'text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
                )}
              >
                {conv.imPlatform && (
                  <IMPlatformDot platform={conv.imPlatform} />
                )}
                {conv.importedFrom && (
                  <ImportedBadge importedAt={conv.importedFrom.importedAt} />
                )}
                {editingId === conv.id ? (
                  <input
                    autoFocus
                    defaultValue={conv.title}
                    className="flex-1 text-[13px] bg-transparent border-b border-[var(--abu-clay)] outline-none min-w-0"
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      const val = e.target.value.trim();
                      if (val && val !== conv.title) renameConversation(conv.id, val);
                      setEditingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                ) : (
                  <span className="flex-1 truncate text-[13px]">{conv.title.replace(/\[Attachment:\s*`[^`]*`\]\s*/g, '').trim() || conv.title}</span>
                )}
                <StatusIndicator
                  status={convStatus}
                  onComplete={() => handleClearCompletedStatus(conv.id)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => handleDeleteConversation(e, conv.id)}
                  className="h-5 w-5 opacity-0 group-hover:opacity-100 text-[var(--abu-text-tertiary)] hover:text-red-500 hover:bg-transparent shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              );
            })}
          </div>
        )}
        </div>
        )}
      </ScrollArea>

      {/* Enterprise status badge — shown above user section when in enterprise mode */}
      <EnterpriseStatusBadge />

      {/* User Section */}
      <div className="px-5 py-4 shrink-0">
        <div className="flex items-center gap-2.5">
          {/* User avatar + nickname (clickable to edit) */}
          <button
            onClick={() => setProfileOpen(true)}
            className="w-8 h-8 rounded-full overflow-hidden shrink-0 hover:ring-2 hover:ring-[var(--abu-clay-40)] transition-shadow"
            title={t.sidebar.editProfile}
          >
            {userAvatar ? (
              <img src={userAvatar} alt="Avatar" className="w-full h-full object-cover" />
            ) : (
              <DefaultUserAvatar />
            )}
          </button>
          <button
            onClick={() => setProfileOpen(true)}
            className="flex-1 min-w-0 text-left"
            title={t.sidebar.editProfile}
          >
            <div
              className={cn(
                'text-[13px] font-semibold truncate',
                userNickname
                  ? 'text-[var(--abu-text-primary)]'
                  : 'text-[var(--abu-text-tertiary)]'
              )}
            >
              {userNickname || t.sidebar.defaultNickname}
            </div>
          </button>
          <button
            onClick={handleImport}
            className="btn-ghost p-1.5 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] rounded-md"
            title={t.sidebar.importSession}
          >
            <Upload className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => openSystemSettings(updateInfo ? 'about' : undefined)}
            className={cn(
              'btn-ghost p-1.5 rounded-md relative',
              viewMode === 'settings'
                ? 'text-[var(--abu-clay)] bg-[var(--abu-bg-active)]'
                : 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]'
            )}
          >
            <Settings className="h-3.5 w-3.5" />
            {updateInfo && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />
            )}
          </button>
          <button
            onClick={() => setGuideOpen(true)}
            className="btn-ghost p-1.5 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] rounded-md"
            title={t.sidebar.help}
          >
            <HelpCircle className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-white rounded-lg shadow-lg border border-[var(--abu-border)] py-1 min-w-[140px]"
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
                    className="absolute left-full ml-1 bg-white rounded-lg shadow-lg border border-[var(--abu-border)] py-1 min-w-[140px] overflow-y-auto overscroll-contain z-10"
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
        onClose={() => { setGuideOpen(false); setGuideShown(true); }}
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
