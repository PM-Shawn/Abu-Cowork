import { useEffect, useCallback, useState, useRef } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useProjectStore } from '@/stores/projectStore';
import { useNoticeBadgeStore } from '@/stores/noticeBadgeStore';
import { useInboxStore } from '@/stores/inboxStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useI18n } from '@/i18n';
import PluginUpdateBadge from '@/components/common/PluginUpdateBadge';
import { useLabsFlag } from '@/core/labs/resolve';
import { LABS_TODOS_INBOX } from '@/core/labs/registry';
import { Button, IconButton } from '@/components/ds/button';
import { ContextMenu } from '@/components/ds/context-menu';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ds/menu';
import { NavItem } from '@/components/ds/nav-item';
import { ScrollArea } from '@/components/ds/scroll-area';
import { FOCUS_RING } from '@/components/ds/styles';
import { Tag } from '@/components/ds/tag';
import { TextField } from '@/components/ds/text-field';
import { Tooltip } from '@/components/ds/tooltip';
import AppSwitcher from '@/components/sidebar/AppSwitcher';
import AppLogo from '@/components/app/AppLogo';
import { useAppStore, useSelectedApp } from '@/stores/appStore';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import { resolveText } from '@/core/app/appBinding';
import type { AppNavItem } from '@/types/app';
import GuideModal from '@/components/common/GuideModal';
import ProfileEditModal from '@/components/common/ProfileEditModal';
import AccountMenu from '@/components/sidebar/AccountMenu';
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
import { isMacOS, isWindows } from '@/utils/platform';

/** A nav item's label: the package's own title when it gives one, else Abu's name for that entry. */
function navTitle(item: AppNavItem, fallback: string): string {
  return item.title === undefined ? fallback : resolveText(item.title);
}

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
    return <span className="w-2 h-2 rounded-full bg-warning animate-pulse shrink-0" />;
  }
  if (status === 'completed') {
    return <span className="w-2 h-2 rounded-full bg-success shrink-0" />;
  }
  if (status === 'error') {
    return <span className="w-2 h-2 rounded-full bg-danger shrink-0" />;
  }
  return null;
}

function IMPlatformDot({ platform }: { platform: string }) {
  return (
    <Tooltip content={platform}>
      <span className="inline-flex shrink-0">
        <Tag>{getPlatformShortLabel(platform)}</Tag>
      </span>
    </Tooltip>
  );
}

interface SidebarProps {
  windowsWorkspaceHeader?: boolean;
}

export default function Sidebar({ windowsWorkspaceHeader = false }: SidebarProps) {
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
  const openExtensions = useSettingsStore((s) => s.openExtensions);
  const openTeam = useSettingsStore((s) => s.openTeam);
  const openAutomation = useSettingsStore((s) => s.openAutomation);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const setViewMode = useSettingsStore((s) => s.setViewMode);
  const selectedApp = useSelectedApp();
  const activeAppPage = useAppStore((s) => s.activeAppPage);
  const openAppPage = useAppStore((s) => s.openAppPage);
  const navItems = [...(selectedApp.config.nav?.items ?? DEFAULT_APP_CONFIG.nav!.items)].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const clearBadge = useNoticeBadgeStore((s) => s.clear);
  // Badge shows items still requiring user decision (pending), not just unread.
  // Once a user accepts/ignores an item, the count drops even if other items
  // remain unread — matches the "things you still owe a decision on" mental model.
  const pendingInboxCount = useInboxStore((s) => s.getPendingCount());
  const pluginUpdateCount = usePluginStore((s) => s.updateAvailableCount);
  const { t } = useI18n();
  const showTodosInbox = useLabsFlag(LABS_TODOS_INBOX);

  // The row whose "⋯" menu is open; right-click menus track their own state.
  const [menuConvId, setMenuConvId] = useState<string | null>(null);
  const [shareConvId, setShareConvId] = useState<string | null>(null);
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

  // Sort by createdAt to keep positions stable during status updates
  // Filter out conversations belonging to projects, scheduled tasks, or triggers — they appear in their own sections
  // Use conversationIndex (lightweight metadata) instead of full conversations for listing
  const sortedConvs = Object.values(conversationIndex)
    .filter((c) => !c.scheduledTaskId && !c.triggerId && !c.projectId)
    // Hide empty (0-message) conversations from 最近. A first send eagerly
    // persists the index entry (createConversation) BEFORE its message lands,
    // so an interrupted/abandoned send leaves a blank "新任务" row littering the
    // list. Codex encodes the same rule structurally (a partial index
    // `WHERE preview <> ''`); this is the read-side equivalent. Only an
    // EXPLICIT messageCount===0 is hidden (undefined/legacy entries stay
    // visible — never hide a real conversation). Always kept even at 0 messages:
    // the ACTIVE conversation (so a just-created one doesn't flicker out while
    // its first message is in flight) and any IM-channel-bound conversation
    // (imChannelId — a real linked session, created eagerly by sessionMapper
    // with skipActivate before its inbound message is appended; the earlier
    // filter only excludes project/scheduled/trigger, not imChannelId).
    .filter((c) => c.messageCount !== 0 || c.id === activeConversationId || !!c.imChannelId)
    .sort((a, b) => b.createdAt - a.createdAt);

  const handleDeleteConversation = async (convId: string) => {
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
      importConversation(pendingDelete.data, { keepPermissionMode: true });
      clearTimeout(undoTimerRef.current);
      setPendingDelete(null);
    }
  };

  const handleClearCompletedStatus = useCallback((convId: string) => {
    clearCompletedStatus(convId);
  }, [clearCompletedStatus]);

  const handleExport = async (convId: string) => {
    // Ensure the conversation is loaded before the dialog reads from it;
    // the dialog itself will call exportConversationForShare which also
    // guards with loadConversation, but awaiting here means the dialog
    // opens straight into the "ready" state when possible.
    await loadConversation(convId);
    setShareConvId(convId);
  };

  const activeProjects = Object.values(projectsMap).filter((p) => !p.archived);

  // One menu for a row, shown both by right-click and by the "⋯" button.
  const conversationMenuItems = (convId: string) => {
    const convMeta = conversationIndex[convId];
    return (
      <>
        {/* The rename field opens once the menu has let go of focus: a menu
            still closing traps focus and would pull it out of the field. */}
        <MenuItem icon={AppIcons.rename} onSelect={() => { setTimeout(() => setEditingId(convId), 0); }}>
          {t.sidebar.renameConversation}
        </MenuItem>
        <MenuItem icon={AppIcons.download} onSelect={() => { void handleExport(convId); }}>
          {t.sidebar.exportConversation}
        </MenuItem>
        {activeProjects.length > 0 && (
          <>
            <MenuSeparator />
            <MenuLabel>{t.project.moveToProject}</MenuLabel>
            {/* A long project list scrolls inside the menu instead of running off the window. */}
            <div className="max-h-60 overflow-y-auto">
              {activeProjects.map((p) => (
                <MenuItem
                  key={p.id}
                  icon={convMeta?.projectId === p.id ? AppIcons.done : AppIcons.folder}
                  onSelect={() => useChatStore.getState().setConversationProject(convId, p.id)}
                >
                  {p.name}
                </MenuItem>
              ))}
            </div>
            {convMeta?.projectId && (
              <MenuItem
                icon={AppIcons.remove}
                onSelect={() => useChatStore.getState().setConversationProject(convId, undefined)}
              >
                {t.project.removeFromProject}
              </MenuItem>
            )}
          </>
        )}
        <MenuSeparator />
        <MenuItem icon={AppIcons.delete} tone="danger" onSelect={() => { void handleDeleteConversation(convId); }}>
          {t.sidebar.deleteConversation}
        </MenuItem>
      </>
    );
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
    // Paints no background: the shell's desk shows through.
    <div className="flex flex-col h-full w-[260px]">
      {/* Electron Windows aligns this brand row with the raised center/right
          headers: 8px desk gutter + 44px header, without a card edge or
          divider. Other hosts retain their existing platform-specific
          clearance. */}
      {windowsWorkspaceHeader ? (
        // Abu's own name keeps the brand row; the switcher sits beside it and
        // reads 发现应用 until the user is inside an app.
        <div
          data-abu-windows-sidebar-header
          className="flex h-[52px] shrink-0 items-center gap-2 px-4 pt-2 pr-[76px]"
        >
          {/* Abu's name only: the version lives in the account menu, and the
              row's width belongs to the switcher beside it. */}
          <span className="shrink-0 whitespace-nowrap text-ui font-semibold text-label">
            {t.common.appName}
          </span>
          <AppSwitcher className="min-w-0 flex-1" />
        </div>
      ) : (
        <>
          <div
            className={
              isMacOS()
                ? 'h-14 shrink-0'
                : isWindows()
                  ? 'h-2 shrink-0'
                  : 'h-8 shrink-0'
            }
          />
          <div className="px-4 pb-1">
            <AppSwitcher />
          </div>
        </>
      )}
      {/* Top Navigation — the current app's entries (the general shell lists
          Abu's six), rendered from one table of targets. */}
      <nav className="flex flex-col gap-1 px-4 pb-2" aria-label="Main navigation">
        {navItems.map((item) => {
          const target = item.target;
          if (target === 'builtin:chat') {
            return (
              <NavItem
                key={item.id}
                data-sidebar-action="new-task"
                icon={AppIcons.add}
                label={navTitle(item, t.sidebar.newTask)}
                selected={activeConversationId === null && viewMode === 'chat'}
                onClick={() => { startNewConversation(); setViewMode('chat'); setShowFileTree(false); }}
              />
            );
          }
          if (target === 'builtin:todos' || target === 'builtin:inbox') {
            if (!showTodosInbox) return null;
            const mode = target === 'builtin:todos' ? 'todos' : 'inbox';
            return (
              <NavItem
                key={item.id}
                icon={mode === 'todos' ? AppIcons.todos : AppIcons.inbox}
                label={navTitle(item, mode === 'todos' ? t.sidebar.todos : t.sidebar.inbox)}
                selected={viewMode === mode}
                trailing={mode === 'inbox' && pendingInboxCount > 0
                  ? <Tag tone="info">{pendingInboxCount > 99 ? '99+' : pendingInboxCount}</Tag>
                  : undefined}
                onClick={() => setViewMode(mode)}
              />
            );
          }
          if (target === 'builtin:team') {
            return (
              <NavItem
                key={item.id}
                data-testid="sidebar-team"
                icon={AppIcons.team}
                label={navTitle(item, t.sidebar.team)}
                selected={viewMode === 'team'}
                onClick={() => { openTeam(); setShowFileTree(false); }}
              />
            );
          }
          if (target === 'builtin:extensions') {
            return (
              <NavItem
                key={item.id}
                icon={AppIcons.extensions}
                label={navTitle(item, t.sidebar.extensions)}
                selected={viewMode === 'extensions'}
                trailing={pluginUpdateCount > 0
                  ? <Tag tone="info"><PluginUpdateBadge testId="extensions-update-badge" /></Tag>
                  : undefined}
                onClick={() => { openExtensions(); setShowFileTree(false); }}
              />
            );
          }
          if (target === 'builtin:automation') {
            return (
              <NavItem
                key={item.id}
                icon={AppIcons.automation}
                label={navTitle(item, t.sidebar.automation)}
                selected={viewMode === 'automation'}
                onClick={() => { openAutomation(); setShowFileTree(false); }}
              />
            );
          }
          // `url:` — the app's own page, shown in the main area.
          return (
            <NavItem
              key={item.id}
              data-testid={`sidebar-app-page-${item.id}`}
              icon={AppIcons.webPage}
              label={navTitle(item, item.id)}
              selected={viewMode === 'app-page' && activeAppPage?.navItemId === item.id}
              onClick={() => { openAppPage(item.id); setShowFileTree(false); }}
            />
          );
        })}
      </nav>

      {/* File-tree mode swaps the whole conversation list for the active
          conversation's project file tree (TRAE-style). Files open in the
          right PreviewPanel, so the tree (here in the sidebar) stays put. */}
      {showFileTree ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="shrink-0 px-4 py-1">
            <Button
              variant="plain"
              size="sm"
              icon={AppIcons.back}
              onClick={() => setShowFileTree(false)}
              className="text-label-tertiary hover:text-label"
            >
              {t.sidebar.backToConversations}
            </Button>
          </div>
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
        <div className="px-4 pt-2">
          <div className="group flex h-7 items-center justify-between pr-2">
            <Button
              variant="plain"
              size="sm"
              onClick={() => setRecentsCollapsed(!recentsCollapsed)}
              className="text-label-tertiary hover:text-label"
            >
              {t.sidebar.recents}
            </Button>
            {!recentsCollapsed && (
              // Import is a rare action — revealed only on row hover (or keyboard focus) to keep the header clean
              <IconButton
                icon={AppIcons.import}
                label={t.sidebar.importSession}
                size="sm"
                onClick={handleImport}
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              />
            )}
          </div>
        </div>

        {/* Conversation List */}
        {!recentsCollapsed && (
        <div className="px-4">
        {sortedConvs.length === 0 ? (
          <div className="px-4 py-3">
            <p className="text-ui text-label-tertiary">{t.sidebar.noSessionsYet}</p>
          </div>
        ) : (
          <div className="space-y-1">
            {sortedConvs.map((conv) => {
              // Look up runtime status from loaded conversations (ConversationMeta doesn't have status)
              const convStatus = conversations[conv.id]?.status ?? 'idle';
              const selected = conv.id === activeConversationId && viewMode === 'chat';
              const editing = editingId === conv.id;
              const menuOpen = menuConvId === conv.id;
              return (
              <ContextMenu key={conv.id} content={conversationMenuItems(conv.id)}>
              <div
                role="button"
                // Not focusable while renaming, so a closing menu cannot pull
                // focus back to the row and end the rename.
                tabIndex={editing ? undefined : 0}
                onClick={(e) => {
                  // The "⋯" menu renders inside this row in React's tree; its
                  // portaled items must not also open the conversation.
                  if (!e.currentTarget.contains(e.target as Node)) return;
                  switchConversation(conv.id); setViewMode('chat'); clearBadge(conv.id); if (convStatus === 'error') clearCompletedStatus(conv.id);
                }}
                onContextMenu={(e) => {
                  // Same for a right-click inside the open "⋯" menu: it must not
                  // open this row's right-click menu on top of it.
                  if (!e.currentTarget.contains(e.target as Node)) e.preventDefault();
                }}
                aria-current={selected ? 'true' : undefined}
                className={cn(
                  'group flex h-7 w-full cursor-pointer items-center gap-2 rounded-control px-2 text-left text-ui text-label transition-colors duration-fast',
                  FOCUS_RING,
                  selected ? 'bg-fill-selected' : 'hover:bg-fill-hover'
                )}
              >
                {conv.imPlatform && (
                  <IMPlatformDot platform={conv.imPlatform} />
                )}
                {conv.importedFrom && (
                  <ImportedBadge importedAt={conv.importedFrom.importedAt} />
                )}
                {conv.appBinding && (
                  <span title={conv.appBinding.appName} data-testid="conversation-app-icon">
                    <AppLogo name={conv.appBinding.appName} logo={conv.appBinding.appLogo} logoDark={conv.appBinding.appLogoDark} size="sm" className="rounded-control" />
                  </span>
                )}
                {editing ? (
                  <TextField
                    autoFocus
                    aria-label={t.sidebar.renameConversation}
                    defaultValue={conv.title}
                    className="min-w-0 flex-1"
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
                  <span className="min-w-0 flex-1 truncate">{conv.title.replace(/\[Attachment:\s*`[^`]*`\]\s*/g, '').trim() || conv.title}</span>
                )}
                <StatusIndicator
                  status={convStatus}
                  onComplete={() => handleClearCompletedStatus(conv.id)}
                />
                {/* Row actions step aside while renaming; see tabIndex above. */}
                {!editing && conv.workspacePath && (
                  <IconButton
                    icon={AppIcons.fileTree}
                    label={t.sidebar.projectFiles}
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      switchConversation(conv.id);
                      setViewMode('chat');
                      clearBadge(conv.id);
                      setShowFileTree(true);
                    }}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  />
                )}
                {!editing && (
                  <Menu
                    open={menuOpen}
                    onOpenChange={(open) => setMenuConvId(open ? conv.id : null)}
                    trigger={
                      <IconButton
                        icon={AppIcons.more}
                        label={t.sidebar.moreActions}
                        size="sm"
                        onClick={(e) => e.stopPropagation()}
                        className={cn(
                          'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                          menuOpen && 'opacity-100'
                        )}
                      />
                    }
                  >
                    {conversationMenuItems(conv.id)}
                  </Menu>
                )}
              </div>
              </ContextMenu>
              );
            })}
          </div>
        )}
        </div>
        )}
      </ScrollArea>
      )}

      {/* User Section — single avatar trigger opening the account popover */}
      <div className="px-3 py-3 shrink-0">
        <AccountMenu onEditProfile={() => setProfileOpen(true)} />
      </div>

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
        <div
          role="alert"
          aria-live="assertive"
          data-electron-no-drag
          data-ds-motion
          data-state="open"
          className="fixed bottom-6 left-1/2 z-toast flex -translate-x-1/2 items-center gap-3 rounded-panel bg-material px-4 py-2 text-label shadow-float backdrop-blur-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-2 data-[state=open]:duration-base data-[state=open]:ease-enter"
        >
          <span className="text-ui">{t.sidebar.conversationDeleted}</span>
          <Button size="sm" icon={AppIcons.undo} onClick={handleUndoDelete}>
            {t.sidebar.undo}
          </Button>
        </div>
      )}
    </div>
  );
}
