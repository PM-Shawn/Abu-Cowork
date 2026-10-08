import { useLayoutEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useI18n } from '@/i18n';
import ShareExportDialog from '@/components/share/ShareExportDialog';
import { Button, IconButton } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { ContextMenu } from '@/components/ds/context-menu';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem, MenuSeparator } from '@/components/ds/menu';
import { NavItem } from '@/components/ds/nav-item';
import { Spinner } from '@/components/ds/spinner';
import { FOCUS_RING } from '@/components/ds/styles';
import { TextField } from '@/components/ds/text-field';
import ImportedBadge from './ImportedBadge';
import { RowMenus } from './RowMenus';
import { conversationRowProps, useConversationRowFocus } from './conversationRowFocus';
import { useDeleteConversation } from './useDeleteConversation';
import { projectRowProps } from './projectRowFocus';
import { opensOnKey } from './rowKeys';
import { cn } from '@/lib/utils';
import { format } from '@/i18n';
import type { Project } from '@/types/project';
import type { ConversationMeta } from '@/core/session/conversationStorage';

const MAX_VISIBLE_CONVERSATIONS = 5;
// Hover-revealed row actions; they stay reachable from the keyboard.
const REVEAL = 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100';

interface ProjectItemProps {
  project: Project;
  conversations: ConversationMeta[];
  expanded: boolean;
  onNewTask: (projectId: string) => void;
  onOpenSettings: (projectId: string) => void;
  /** Called right before the project is archived or deleted here: its row is about to leave the list. */
  onLeaving?: (projectId: string) => void;
}

export default function ProjectItem({ project, conversations, expanded, onNewTask, onOpenSettings, onLeaving }: ProjectItemProps) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const toggleExpanded = useProjectStore((s) => s.toggleExpanded);
  const togglePin = useProjectStore((s) => s.togglePin);
  const archiveProject = useProjectStore((s) => s.archiveProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const switchConversation = useChatStore((s) => s.switchConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const loadConversation = useChatStore((s) => s.loadConversation);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const loadedConversations = useChatStore((s) => s.conversations);
  const conversationIndex = useChatStore((s) => s.conversationIndex);
  const setViewMode = useSettingsStore((s) => s.setViewMode);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const setShowFileTree = usePreviewStore((s) => s.setFileTreeMode);

  const setConversationProject = useChatStore((s) => s.setConversationProject);

  // Inline rename state — mirrors Sidebar.tsx's editingId pattern so the
  // UX matches Recents exactly.
  const [editingConvId, setEditingConvId] = useState<string | null>(null);
  // Share export dialog target (conversation id)
  const [shareConvId, setShareConvId] = useState<string | null>(null);
  // Whether to show every conversation under this project, or just the first
  // MAX_VISIBLE_CONVERSATIONS. Toggled by the "+N more" / "show less" button.
  const [showAll, setShowAll] = useState(false);
  // Whether the project row's 「更多操作」 menu is open: its button stays visible meanwhile.
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  // After a task is deleted from its row menu the focus goes on to a row, never to the window.
  const rowFocus = useConversationRowFocus();
  // 删除会话 for a task of this project: a task whose record cannot be read is deleted only after
  // a question. No undo is offered here.
  const deletion = useDeleteConversation(rowFocus, false);
  // The project's tasks as of the last render: the delete question unlinks those it has at the answer.
  const latestConversations = useRef(conversations);
  useLayoutEffect(() => { latestConversations.current = conversations; });
  // One archive or delete at a time for this project.
  const leaving = useRef(false);
  // What a menu item starts once its menu has gone: a rename field, a confirmation or
  // a window must not open while the closing menu still holds focus.
  // `holdFocus`: the rename field must not have the menu hand focus back to its trigger or
  // the row, because the field needs it. The confirmations, 项目设置 and 导出会话 are
  // ds dialogs that take focus and give it back themselves.
  const afterMenuClose = useRef<{ run: () => void; holdFocus: boolean } | null>(null);

  // Reopening a menu during its exit animation gives it new content, and the close hook
  // of the content it replaces runs at once. Drop the earlier choice on open, or it would
  // be carried out under the new menu.
  const dropActionOnOpen = (open: boolean) => {
    if (!open) return;
    afterMenuClose.current = null;
    rowFocus.forget();
    deletion.menuOpened();
  };

  // Runs from the menus' close-focus hook, once the menu has gone.
  const runAfterMenuClose = (event: Event) => {
    deletion.menuClosed();
    const pending = afterMenuClose.current;
    if (!pending) {
      // 删除会话 took the row away while the menu was closing: the focus goes on to a row.
      rowFocus.afterMenuClose(event);
      return;
    }
    afterMenuClose.current = null;
    if (pending.holdFocus) event.preventDefault();
    pending.run();
  };

  const handleConvClick = (convId: string) => {
    switchConversation(convId);
    setViewMode('chat');
  };

  // Whether this row's project is still one of the listed projects, as the store holds it now.
  // The answer to a question arrives later than the question: the project may have been
  // archived or deleted from elsewhere meanwhile, and this row may be gone with it.
  const stillListed = () => {
    const current = useProjectStore.getState().projects[project.id];
    return current !== undefined && !current.archived;
  };

  const confirmArchive = async () => {
    const confirmed = await confirm({
      title: t.project.archiveProject,
      message: format(t.project.archiveConfirm, { name: project.name }),
      confirmLabel: t.project.archive,
      tone: 'danger',
    });
    if (!confirmed || leaving.current || !stillListed()) return;
    leaving.current = true;
    try {
      onLeaving?.(project.id);
      archiveProject(project.id);
    } finally {
      leaving.current = false;
    }
  };

  const confirmDelete = async () => {
    const confirmed = await confirm({
      title: t.project.deleteProject,
      // The second line names the project.
      message: `${t.project.deleteConfirm}\n${project.name}`,
      confirmLabel: t.project.delete,
      tone: 'danger',
    });
    if (!confirmed || leaving.current || !stillListed()) return;
    leaving.current = true;
    try {
      // Unlink conversations → they go back to Recents
      for (const conv of latestConversations.current) {
        setConversationProject(conv.id, undefined);
      }
      onLeaving?.(project.id);
      deleteProject(project.id);
    } finally {
      leaving.current = false;
    }
  };

  const projectMenuItems = (
    <>
      <MenuItem icon={project.pinned ? AppIcons.unpin : AppIcons.pin} onSelect={() => togglePin(project.id)}>
        {project.pinned ? t.project.unpin : t.project.pin}
      </MenuItem>
      <MenuItem icon={AppIcons.settings} onSelect={() => { afterMenuClose.current = { run: () => onOpenSettings(project.id), holdFocus: false }; }}>
        {t.project.editSettings}
      </MenuItem>
      <MenuItem
        icon={AppIcons.folderOpen}
        onSelect={() => {
          // Open folder in Finder/Explorer
          import('@tauri-apps/plugin-opener').then(({ revealItemInDir }) => {
            revealItemInDir(project.workspacePath).catch(console.error);
          });
        }}
      >
        {t.project.openInFinder}
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={AppIcons.archive} onSelect={() => { afterMenuClose.current = { run: () => { void confirmArchive(); }, holdFocus: false }; }}>
        {t.project.archive}
      </MenuItem>
      <MenuItem icon={AppIcons.delete} tone="danger" onSelect={() => { afterMenuClose.current = { run: () => { void confirmDelete(); }, holdFocus: false }; }}>
        {t.project.delete}
      </MenuItem>
    </>
  );

  // Aligned with Sidebar.tsx's recents menu (rename / export / move-out / delete) so
  // users get the same verbs whether or not the conversation lives under a project.
  // One list, shown both by right-click and by the "⋯" button.
  const conversationMenuItems = (convId: string) => (
    <>
      <MenuItem icon={AppIcons.rename} onSelect={() => { afterMenuClose.current = { run: () => setEditingConvId(convId), holdFocus: true }; }}>
        {t.sidebar.renameConversation}
      </MenuItem>
      <MenuItem
        icon={AppIcons.download}
        onSelect={() => {
          // Pre-load so the share dialog opens straight into ready state,
          // matching Sidebar.handleExport's behavior.
          afterMenuClose.current = {
            run: () => { void loadConversation(convId).then(() => setShareConvId(convId)); },
            holdFocus: false,
          };
        }}
      >
        {t.sidebar.exportConversation}
      </MenuItem>
      <MenuItem icon={AppIcons.remove} onSelect={() => setConversationProject(convId, undefined)}>
        {t.project.removeFromProject}
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={AppIcons.delete} tone="danger" onSelect={() => deletion.fromMenu(convId)}>
        {t.sidebar.deleteConversation}
      </MenuItem>
    </>
  );

  const hasMore = conversations.length > MAX_VISIBLE_CONVERSATIONS;
  const visibleConvs = showAll ? conversations : conversations.slice(0, MAX_VISIBLE_CONVERSATIONS);

  return (
    <div>
      {/* Project header row */}
      <ContextMenu content={projectMenuItems} onOpenChange={dropActionOnOpen} onCloseAutoFocus={runAfterMenuClose}>
        <div className="group flex items-center gap-1">
          <NavItem
            icon={expanded ? AppIcons.folderOpen : AppIcons.folder}
            label={project.name}
            trailing={project.pinned ? <span className="flex"><Icon icon={AppIcons.pin} size="sm" /></span> : undefined}
            onClick={() => toggleExpanded(project.id)}
            className="min-w-0 flex-1"
            {...projectRowProps(project.id)}
          />
          <IconButton
            icon={AppIcons.fileTree}
            label={t.sidebar.projectFiles}
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              useWorkspaceStore.getState().setWorkspace(project.workspacePath);
              setShowFileTree(true);
              setViewMode('chat');
            }}
            className={REVEAL}
          />
          <IconButton
            icon={AppIcons.add}
            label={t.project.newTask}
            size="sm"
            onClick={(e) => { e.stopPropagation(); onNewTask(project.id); }}
            className={REVEAL}
          />
          {/* The right-click menu's items, for the keyboard and for a screen reader. The row is
              no part of a `RowMenus` list, so this is a menu of its own. */}
          <Menu
            open={projectMenuOpen}
            onOpenChange={(next) => { dropActionOnOpen(next); setProjectMenuOpen(next); }}
            onCloseAutoFocus={runAfterMenuClose}
            trigger={(
              <IconButton
                icon={AppIcons.more}
                label={t.sidebar.moreActions}
                size="sm"
                className={cn(REVEAL, projectMenuOpen && 'opacity-100')}
              />
            )}
          >
            {projectMenuItems}
          </Menu>
        </div>
      </ContextMenu>

      {/* Expanded content */}
      {expanded && (
        <div className="mt-1 space-y-1">
          {/* One right-click menu and one "⋯" menu for all the task rows. */}
          <RowMenus
            items={conversationMenuItems}
            moreLabel={t.sidebar.moreActions}
            onOpenChange={dropActionOnOpen}
            onCloseAutoFocus={runAfterMenuClose}
            className="space-y-1"
          >
            {(menus) => visibleConvs.map((conv) => {
              const selected = conv.id === activeConversationId && viewMode === 'chat';
              const editing = editingConvId === conv.id;
              const menuOpen = menus.isMoreOpen(conv.id);
              const running = (loadedConversations[conv.id]?.status ?? 'idle') === 'running';
              return (
                // Not a NavItem: the row holds its own buttons, and a button cannot contain buttons.
                <div
                  key={conv.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleConvClick(conv.id)}
                  onKeyDown={opensOnKey(() => handleConvClick(conv.id))}
                  onContextMenu={(e) => menus.onRowContextMenu(e, conv.id)}
                  aria-current={selected ? 'true' : undefined}
                  {...conversationRowProps(conv.id)}
                  className={cn(
                    'group flex h-7 w-full cursor-pointer items-center gap-2 rounded-control pl-8 pr-2 text-left text-ui-sm transition-colors duration-fast',
                    FOCUS_RING,
                    selected ? 'bg-fill-selected text-label' : 'text-label-secondary hover:bg-fill-hover hover:text-label'
                  )}
                >
                  {conv.importedFrom && (
                    <ImportedBadge importedAt={conv.importedFrom.importedAt} />
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
                        setEditingConvId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') setEditingConvId(null);
                      }}
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate">
                      {conv.title.replace(/\[Attachment:\s*`[^`]*`\]\s*/g, '').trim() || conv.title}
                    </span>
                  )}
                  {running && (
                    <span className="flex shrink-0">
                      <Spinner size="sm" label={t.task.running} labelHidden />
                    </span>
                  )}
                  {/* Row actions step aside while renaming so the field gets the row's width. */}
                  {!editing && conv.workspacePath && (
                    <IconButton
                      icon={AppIcons.fileTree}
                      label={t.sidebar.projectFiles}
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        switchConversation(conv.id);
                        setViewMode('chat');
                        setShowFileTree(true);
                      }}
                      className={REVEAL}
                    />
                  )}
                  {!editing && (
                    <IconButton
                      icon={AppIcons.more}
                      label={t.sidebar.moreActions}
                      size="sm"
                      {...menus.moreButtonProps(conv.id)}
                      className={cn(REVEAL, menuOpen && 'opacity-100')}
                    />
                  )}
                </div>
              );
            })}
          </RowMenus>

          {hasMore && (
            <div className="pl-6">
              <Button
                variant="plain"
                size="sm"
                onClick={() => setShowAll((v) => !v)}
                className="text-label-tertiary hover:text-label"
              >
                {showAll
                  ? t.project.showLess
                  : format(t.project.showMore, { count: conversations.length - MAX_VISIBLE_CONVERSATIONS })}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Share export preview — mirrors the one Sidebar renders for Recents */}
      {shareConvId && (
        <ShareExportDialog
          key={shareConvId}
          convId={shareConvId}
          defaultFilename={`abu-conversation-${conversationIndex[shareConvId]?.title || shareConvId}.abu.json`}
          onClose={() => setShareConvId(null)}
        />
      )}
    </div>
  );
}
