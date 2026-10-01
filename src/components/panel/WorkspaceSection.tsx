import { useWorkspaceStore, getFolderName } from '@/stores/workspaceStore';
import { useChatStore } from '@/stores/chatStore';
import { useProjectStore } from '@/stores/projectStore';
import { usePermissionStore, type PermissionDuration } from '@/stores/permissionStore';
import { useI18n } from '@/i18n';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { exists } from '@tauri-apps/plugin-fs';
import { scanMemoryFiles } from '@/core/memdir/scan';
import { Button, IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '@/components/ds/menu';
import { Pressable } from '@/components/ds/pressable';
import { Tag } from '@/components/ds/tag';
import { useEffect, useState, useRef } from 'react';
import PermissionDialog from '@/components/common/PermissionDialog';
import InstructionsEditModal from '@/components/common/InstructionsEditModal';
import MemoryViewModal from '@/components/common/MemoryViewModal';
import FilesSection from './FilesSection';
import { cn } from '@/lib/utils';
import { joinPath } from '@/utils/pathUtils';

// What the folder menu was asked to do; carried out once the menu has closed.
type FolderMenuAction = { kind: 'recent'; path: string } | { kind: 'browse' };

export default function WorkspaceSection() {
  const currentPath = useWorkspaceStore((s) => s.currentPath);
  const recentPaths = useWorkspaceStore((s) => s.recentPaths);
  const setWorkspaceGlobal = useWorkspaceStore((s) => s.setWorkspace);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const setConversationWorkspace = useChatStore((s) => s.setConversationWorkspace);

  // Wrapper: update both global workspace and active conversation
  const setWorkspace = (path: string | null) => {
    setWorkspaceGlobal(path);
    if (activeConversationId) {
      setConversationWorkspace(activeConversationId, path);
    }
  };

  const grantPermission = usePermissionStore((s) => s.grantPermission);
  const hasPermission = usePermissionStore((s) => s.hasPermission);
  const [hasInstructions, setHasInstructions] = useState(false);
  const [hasMemory, setHasMemory] = useState(false);
  const [pendingFolder, setPendingFolder] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);  // Main section expand/collapse
  const [showInstructionsModal, setShowInstructionsModal] = useState(false);
  const [showMemoryModal, setShowMemoryModal] = useState(false);
  const pendingActionRef = useRef<FolderMenuAction | null>(null);
  const { t } = useI18n();

  // Check for .abu/ABU.md and .abu/MEMORY.md when workspace changes
  useEffect(() => {
    async function checkFiles() {
      if (!currentPath) {
        setHasInstructions(false);
        setHasMemory(false);
        return;
      }
      try {
        const abuMdPath = joinPath(currentPath, '.abu', 'ABU.md');
        setHasInstructions(await exists(abuMdPath));
      } catch {
        setHasInstructions(false);
      }
      try {
        // Check memdir for this workspace
        const headers = await scanMemoryFiles(currentPath);
        setHasMemory(headers.length > 0);
      } catch {
        setHasMemory(false);
      }
    }
    checkFiles();
  }, [currentPath]);

  const handleOpenInFinder = async () => {
    if (!currentPath) return;
    try {
      await revealItemInDir(currentPath);
    } catch (err) {
      console.error('Failed to open folder:', err);
    }
  };

  const handleSelectWorkspace = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: t.panel.selectWorkspace,
      });
      if (selected) {
        const folderPath = selected as string;
        // Check if already has permission
        if (hasPermission(folderPath, 'read')) {
          setWorkspace(folderPath);
        } else {
          setPendingFolder(folderPath);
        }
      }
    } catch (err) {
      console.error('Failed to select workspace:', err);
    }
  };

  const handleFolderMenuOpenChange = (open: boolean) => {
    if (open) pendingActionRef.current = null;
  };

  // The system folder picker and the access dialog take the keyboard, so they open
  // only after the menu has gone, with the focus return to the folder card cancelled.
  // Switching to a folder that already has access opens nothing: the focus goes back
  // to the card as usual.
  const handleFolderMenuCloseAutoFocus = (event: Event) => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    if (!action) return;
    if (action.kind === 'recent' && hasPermission(action.path, 'read')) {
      setWorkspace(action.path);
      return;
    }
    event.preventDefault();
    if (action.kind === 'recent') {
      setPendingFolder(action.path);
    } else {
      handleSelectWorkspace();
    }
  };

  const handleAllowPermission = (duration: PermissionDuration) => {
    if (pendingFolder) {
      grantPermission(pendingFolder, ['read', 'write', 'execute'], duration);
      setWorkspace(pendingFolder);
      setPendingFolder(null);
    }
  };

  const handleDenyPermission = () => {
    setPendingFolder(null);
  };

  const folderName = currentPath ? getFolderName(currentPath) : null;
  const projectsMap = useProjectStore((s) => s.projects);
  const activeProject = currentPath
    ? Object.values(projectsMap).find((p) => p.workspacePath === currentPath)
    : undefined;

  return (
    <>
      {/* Permission Dialog */}
      {pendingFolder && (
        <PermissionDialog
          request={{ type: 'workspace', path: pendingFolder }}
          onAllow={handleAllowPermission}
          onDeny={handleDenyPermission}
        />
      )}

      {/* Instructions Edit Modal */}
      {currentPath && (
        <InstructionsEditModal
          open={showInstructionsModal}
          onClose={() => {
            setShowInstructionsModal(false);
            // Re-check if file was created/modified
            exists(joinPath(currentPath, '.abu', 'ABU.md')).then(setHasInstructions).catch(() => setHasInstructions(false));
          }}
          workspacePath={currentPath}
        />
      )}

      {/* Memory View Modal */}
      {currentPath && (
        <MemoryViewModal
          open={showMemoryModal}
          onClose={async () => {
            setShowMemoryModal(false);
            try {
              const headers = await scanMemoryFiles(currentPath);
              setHasMemory(headers.length > 0);
            } catch {
              setHasMemory(false);
            }
          }}
          scope="project"
          workspacePath={currentPath}
        />
      )}

      <div className="space-y-3">
        {/* Header: the title button expands and collapses; the reveal button stands beside it */}
        <div className="flex items-center gap-1">
          <Pressable
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <Icon icon={AppIcons.folderOpen} className="text-label-secondary" />
            <h3 className="text-ui font-medium text-label">
              {t.panel.workspace}
            </h3>
            {activeProject && (
              <Tag>
                <span className="block max-w-28 truncate">{activeProject.name}</span>
              </Tag>
            )}
            <Icon
              icon={AppIcons.expand}
              size="sm"
              className={cn('ml-auto text-label-tertiary transition-transform duration-fast', !expanded && '-rotate-90')}
            />
          </Pressable>
          {currentPath && (
            <IconButton
              size="sm"
              icon={AppIcons.openIn}
              label={t.panel.openInFinder}
              onClick={handleOpenInFinder}
            />
          )}
        </div>

        {expanded && (
          <>
            {currentPath ? (
              <div className="mt-3 space-y-2">
                {/* Folder card: opens the list of recent folders */}
                <Menu
                  onOpenChange={handleFolderMenuOpenChange}
                  onCloseAutoFocus={handleFolderMenuCloseAutoFocus}
                  trigger={
                    <Pressable className="group flex w-full items-center gap-3 rounded-panel border border-separator px-3 py-2 text-left hover:bg-fill-hover">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-fill text-label-secondary">
                        <Icon icon={AppIcons.folderOpen} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui font-medium text-label">
                          {folderName}
                        </span>
                        <span className="block truncate text-caption text-label-tertiary">
                          {currentPath}
                        </span>
                      </span>
                      <Icon
                        icon={AppIcons.expand}
                        size="sm"
                        className="text-label-tertiary transition-transform duration-fast group-data-[state=open]:rotate-180"
                      />
                    </Pressable>
                  }
                >
                  {recentPaths.length > 0 && (
                    <>
                      <MenuLabel>{t.panel.recentlyUsed}</MenuLabel>
                      <MenuRadioGroup
                        value={currentPath}
                        onValueChange={(path) => { pendingActionRef.current = { kind: 'recent', path }; }}
                      >
                        {recentPaths.map((path) => (
                          <MenuRadioItem key={path} value={path}>{getFolderName(path)}</MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                      <MenuSeparator />
                    </>
                  )}
                  <MenuItem
                    icon={AppIcons.folderOpen}
                    onSelect={() => { pendingActionRef.current = { kind: 'browse' }; }}
                  >
                    {t.panel.selectOtherFolder}
                  </MenuItem>
                </Menu>

                {/* Instructions entry */}
                <Pressable
                  onClick={() => setShowInstructionsModal(true)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-control bg-fill px-2 py-1 text-left text-ui-sm hover:bg-fill-hover',
                    hasInstructions ? 'text-label' : 'text-label-tertiary'
                  )}
                >
                  <Icon icon={AppIcons.file} size="sm" />
                  {hasInstructions ? `${t.panel.instructions} · ABU.md` : t.panel.instructionsAdd}
                </Pressable>

                {/* Memory entry */}
                <Pressable
                  onClick={() => setShowMemoryModal(true)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-control bg-fill px-2 py-1 text-left text-ui-sm hover:bg-fill-hover',
                    hasMemory ? 'text-label' : 'text-label-tertiary'
                  )}
                >
                  <Icon icon={AppIcons.thinking} size="sm" />
                  {hasMemory ? t.panel.memory : t.panel.memoryEmpty}
                </Pressable>
              </div>
            ) : (
              // Empty state - clickable to select workspace
              <div className="mt-3">
                <Button variant="plain" size="sm" onClick={handleSelectWorkspace}>
                  {t.panel.selectWorkspace}
                </Button>
              </div>
            )}

            {/* Operated files - always shown */}
            <FilesSection />
          </>
        )}
      </div>
    </>
  );
}
