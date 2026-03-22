import { useWorkspaceStore, getFolderName } from '@/stores/workspaceStore';
import { useChatStore } from '@/stores/chatStore';
import { useProjectStore } from '@/stores/projectStore';
import { usePermissionStore, type PermissionDuration } from '@/stores/permissionStore';
import { useI18n } from '@/i18n';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { exists } from '@tauri-apps/plugin-fs';
import {
  FolderOpen,
  ExternalLink,
  FileText,
  ChevronDown,
  Check,
  Folder,
  Brain,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useEffect, useState, useRef } from 'react';
import PermissionDialog from '@/components/common/PermissionDialog';
import InstructionsEditModal from '@/components/common/InstructionsEditModal';
import MemoryViewModal from '@/components/common/MemoryViewModal';
import FilesSection from './FilesSection';
import { cn } from '@/lib/utils';
import { joinPath } from '@/utils/pathUtils';

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
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [expanded, setExpanded] = useState(true);  // Main section expand/collapse
  const [showInstructionsModal, setShowInstructionsModal] = useState(false);
  const [showMemoryModal, setShowMemoryModal] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    }
    if (isDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isDropdownOpen]);

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
        const memoryPath = joinPath(currentPath, '.abu', 'MEMORY.md');
        setHasMemory(await exists(memoryPath));
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
    setIsDropdownOpen(false);
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

  const handleSelectRecent = (folderPath: string) => {
    setIsDropdownOpen(false);
    if (hasPermission(folderPath, 'read')) {
      setWorkspace(folderPath);
    } else {
      setPendingFolder(folderPath);
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
          onClose={() => {
            setShowMemoryModal(false);
            exists(joinPath(currentPath, '.abu', 'MEMORY.md')).then(setHasMemory).catch(() => setHasMemory(false));
          }}
          scope="project"
          workspacePath={currentPath}
        />
      )}

      <div className="space-y-3">
        {/* Header - clickable to expand/collapse */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => setExpanded(!expanded)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded); } }}
          className="flex items-center justify-between w-full text-left group cursor-pointer"
        >
          <div className="flex items-center gap-2 min-w-0">
            <FolderOpen className="h-4 w-4 text-[var(--abu-text-tertiary)] shrink-0" />
            <h3 className="text-[13px] font-medium text-[var(--abu-text-primary)]">
              {t.panel.workspace}
            </h3>
            {activeProject && (
              <span className="text-[11px] text-[var(--abu-clay)] bg-[var(--abu-clay-bg-15)] px-1.5 py-0.5 rounded truncate max-w-[120px]">
                {activeProject.name}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {currentPath && (
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]"
                onClick={(e) => {
                  e.stopPropagation();
                  handleOpenInFinder();
                }}
                title={t.panel.openInFinder}
              >
                <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
              </Button>
            )}
            <ChevronDown
              className={cn(
                'h-4 w-4 text-[var(--abu-text-muted)] transition-transform',
                !expanded && '-rotate-90'
              )}
            />
          </div>
        </div>

        {expanded && (
          <>
            {currentPath ? (
          <div className="space-y-2 mt-3">
            {/* Folder card with dropdown */}
            <div ref={dropdownRef} className="relative">
              <button
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                className="w-full flex items-center gap-2.5 p-2.5 rounded-lg bg-[var(--abu-bg-base)] hover:bg-[var(--abu-bg-muted)] transition-colors text-left group"
              >
                <div className="w-8 h-8 rounded-md bg-[var(--abu-clay-bg)] flex items-center justify-center shrink-0">
                  <FolderOpen className="w-4 h-4 text-[var(--abu-clay)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] font-medium text-[var(--abu-text-primary)] truncate block">
                    {folderName}
                  </span>
                  <div className="text-[10px] text-[var(--abu-text-muted)] truncate">
                    {currentPath}
                  </div>
                </div>
                <ChevronDown className={`w-3.5 h-3.5 text-[var(--abu-text-muted)] transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} />
              </button>

              {/* Dropdown menu */}
              {isDropdownOpen && (
                <div className="absolute top-full left-0 right-0 mt-1.5 bg-white rounded-lg border border-[var(--abu-bg-hover)] shadow-lg z-50 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
                  {/* Recent folders */}
                  {recentPaths.length > 0 && (
                    <>
                      <div className="px-3 py-2 text-[10px] font-medium text-[var(--abu-text-muted)] uppercase tracking-wider border-b border-[var(--abu-bg-active)]">
                        {t.panel.recentlyUsed}
                      </div>
                      <div className="py-1 max-h-[200px] overflow-y-auto">
                        {recentPaths.map((path) => (
                          <button
                            key={path}
                            onClick={() => handleSelectRecent(path)}
                            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--abu-bg-muted)] transition-colors"
                          >
                            <div className="w-4 h-4 flex items-center justify-center shrink-0">
                              {path === currentPath && (
                                <Check className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
                              )}
                            </div>
                            <Folder className={`h-3.5 w-3.5 shrink-0 ${path === currentPath ? 'text-[var(--abu-clay)]' : 'text-[var(--abu-text-muted)]'}`} />
                            <span className={`text-[12px] truncate ${path === currentPath ? 'text-[var(--abu-text-primary)] font-medium' : 'text-[var(--abu-text-secondary)]'}`}>
                              {getFolderName(path)}
                            </span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {/* Separator */}
                  {recentPaths.length > 0 && <div className="border-t border-[var(--abu-bg-active)]" />}

                  {/* Choose different folder */}
                  <div className="py-1">
                    <button
                      onClick={handleSelectWorkspace}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--abu-bg-muted)] transition-colors"
                    >
                      <div className="w-4 h-4" />
                      <Folder className="h-3.5 w-3.5 text-[var(--abu-text-tertiary)] shrink-0" />
                      <span className="text-[12px] text-[var(--abu-text-tertiary)]">
                        {t.panel.selectOtherFolder}
                      </span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Instructions entry */}
            <button
              onClick={() => setShowInstructionsModal(true)}
              className={cn(
                'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md transition-colors text-left',
                hasInstructions
                  ? 'bg-[var(--abu-clay-bg)] hover:bg-[var(--abu-clay-bg-15)]'
                  : 'bg-[var(--abu-bg-muted)] hover:bg-[var(--abu-bg-hover)]'
              )}
            >
              <FileText className={cn('w-3.5 h-3.5', hasInstructions ? 'text-[var(--abu-clay)]' : 'text-[var(--abu-text-placeholder)]')} />
              <span className={cn('text-[11px] font-medium', hasInstructions ? 'text-[var(--abu-text-secondary)]' : 'text-[var(--abu-text-muted)]')}>
                {hasInstructions ? `${t.panel.instructions} · ABU.md` : t.panel.instructionsAdd}
              </span>
            </button>

            {/* Memory entry */}
            <button
              onClick={() => setShowMemoryModal(true)}
              className={cn(
                'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md transition-colors text-left',
                hasMemory
                  ? 'bg-[#8b7ec8]/[0.08] hover:bg-[#8b7ec8]/[0.15]'
                  : 'bg-[var(--abu-bg-muted)] hover:bg-[var(--abu-bg-hover)]'
              )}
            >
              <Brain className={cn('w-3.5 h-3.5', hasMemory ? 'text-[#8b7ec8]' : 'text-[var(--abu-text-placeholder)]')} />
              <span className={cn('text-[11px] font-medium', hasMemory ? 'text-[var(--abu-text-secondary)]' : 'text-[var(--abu-text-muted)]')}>
                {hasMemory ? t.panel.memory : t.panel.memoryEmpty}
              </span>
            </button>
          </div>
        ) : (
          // Empty state - clickable to select workspace
          <button
            onClick={handleSelectWorkspace}
            className="text-[12px] text-[var(--abu-text-muted)] hover:text-[var(--abu-clay)] py-2 mt-3 cursor-pointer transition-colors text-left"
          >
            {t.panel.selectWorkspace}
          </button>
        )}

            {/* Operated files - always shown */}
            <FilesSection />
          </>
        )}
      </div>
    </>
  );
}

