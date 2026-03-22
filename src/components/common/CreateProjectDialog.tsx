import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import { useChatStore } from '@/stores/chatStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { exists, mkdir } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { FolderPlus, FolderOpen, X, ArrowLeft } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { getBaseName, joinPath } from '@/utils/pathUtils';

type CreateMode = 'scratch' | 'existing-folder';

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function CreateProjectDialog({ open, onClose }: CreateProjectDialogProps) {
  const { t } = useI18n();
  const createProject = useProjectStore((s) => s.createProject);
  const getProjectByWorkspace = useProjectStore((s) => s.getProjectByWorkspace);
  const setConversationProject = useChatStore((s) => s.setConversationProject);
  const conversations = useChatStore((s) => s.conversations);

  // Which step: pick mode, or fill form
  const [mode, setMode] = useState<CreateMode | null>(null);

  // Form fields
  const [projectName, setProjectName] = useState('');
  const [projectDesc, setProjectDesc] = useState('');
  const [instructions, setInstructions] = useState('');
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [defaultProjectsDir, setDefaultProjectsDir] = useState('');
  const [hasAbuConfig, setHasAbuConfig] = useState(false);
  const [conflictProject, setConflictProject] = useState<string | null>(null);

  // Get default projects directory
  useEffect(() => {
    homeDir().then((home) => {
      setDefaultProjectsDir(joinPath(home, 'Documents', 'Abu', 'Projects'));
    }).catch(() => {});
  }, []);

  // Reset on open
  useEffect(() => {
    if (!open) return;
    setMode(null);
    setProjectName('');
    setProjectDesc('');
    setInstructions('');
    setSelectedFolder(null);
    setHasAbuConfig(false);
    setConflictProject(null);
  }, [open]);

  // Check folder for config and conflicts
  useEffect(() => {
    if (!selectedFolder) {
      setHasAbuConfig(false);
      setConflictProject(null);
      return;
    }
    const existing = getProjectByWorkspace(selectedFolder);
    setConflictProject(existing?.name ?? null);
    const abuPath = joinPath(selectedFolder, '.abu', 'ABU.md');
    exists(abuPath).then(setHasAbuConfig).catch(() => setHasAbuConfig(false));
  }, [selectedFolder, getProjectByWorkspace]);

  // Handle folder selection for "existing-folder" mode
  const handleSelectFolder = useCallback(async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: t.project.selectFolder,
      });
      if (selected) {
        const folderPath = selected as string;
        setSelectedFolder(folderPath);
        if (!projectName) setProjectName(getBaseName(folderPath));
      }
    } catch (err) {
      console.error('Failed to open folder dialog:', err);
    }
  }, [t.project.selectFolder, projectName]);

  // Create project
  const handleCreate = async () => {
    if (!projectName.trim()) return;

    let finalFolder = selectedFolder;

    // For "scratch" mode: create new folder
    if (mode === 'scratch') {
      const dir = defaultProjectsDir;
      finalFolder = joinPath(dir, projectName.trim());
      try {
        await mkdir(finalFolder, { recursive: true });
        // Create .abu/ dir with instructions if provided
        if (instructions.trim()) {
          const abuDir = joinPath(finalFolder, '.abu');
          await mkdir(abuDir, { recursive: true });
          const { writeTextFile } = await import('@tauri-apps/plugin-fs');
          await writeTextFile(joinPath(abuDir, 'ABU.md'), instructions.trim());
        }
      } catch (err) {
        console.error('Failed to create project folder:', err);
        return;
      }
    }

    if (!finalFolder) return;

    const projectId = createProject({
      name: projectName.trim(),
      description: projectDesc.trim() || undefined,
      workspacePath: finalFolder,
    });

    // Auto-assign existing conversations with the same workspace
    const matchingConvs = Object.values(conversations).filter(
      (c) => c.workspacePath === finalFolder && !c.projectId
    );
    for (const conv of matchingConvs) {
      setConversationProject(conv.id, projectId);
    }

    // Switch to new project context: clear active conversation → welcome screen with workspace set
    useChatStore.getState().startNewConversation();
    useWorkspaceStore.getState().setWorkspace(finalFolder);
    useSettingsStore.getState().setViewMode('chat');
    onClose();
  };

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  // Whether form is valid for creation
  const canCreate = mode === 'scratch'
    ? !!projectName.trim()
    : !!projectName.trim() && !!selectedFolder && !conflictProject;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-[480px] max-h-[80vh] overflow-y-auto animate-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 pt-6 pb-2">
          {mode !== null && (
            <button
              onClick={() => setMode(null)}
              className="p-1 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] rounded-lg"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div className="flex-1">
            <h2 className="text-[18px] font-semibold text-[var(--abu-text-primary)]">
              {t.project.createTitle}
            </h2>
            {mode === null && (
              <p className="text-[13px] text-[var(--abu-text-tertiary)] mt-0.5">
                {t.project.createDesc}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] rounded-lg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 pb-6">
          {/* ========== Mode Selection ========== */}
          {mode === null && (
            <div className="space-y-2 mt-4">
              <button
                onClick={() => setMode('scratch')}
                className="w-full flex items-center gap-3 p-4 rounded-xl border border-[var(--abu-border)] hover:border-[var(--abu-clay)] hover:bg-[var(--abu-clay-bg)] transition-colors text-left"
              >
                <FolderPlus className="h-5 w-5 text-[var(--abu-text-tertiary)] shrink-0" />
                <div>
                  <div className="text-[14px] font-medium text-[var(--abu-text-primary)]">{t.project.modeFromScratch}</div>
                  <div className="text-[12px] text-[var(--abu-text-tertiary)] mt-0.5">{t.project.modeFromScratchDesc}</div>
                </div>
              </button>
              <button
                onClick={() => { setMode('existing-folder'); handleSelectFolder(); }}
                className="w-full flex items-center gap-3 p-4 rounded-xl border border-[var(--abu-border)] hover:border-[var(--abu-clay)] hover:bg-[var(--abu-clay-bg)] transition-colors text-left"
              >
                <FolderOpen className="h-5 w-5 text-[var(--abu-text-tertiary)] shrink-0" />
                <div>
                  <div className="text-[14px] font-medium text-[var(--abu-text-primary)]">{t.project.modeExistingFolder}</div>
                  <div className="text-[12px] text-[var(--abu-text-tertiary)] mt-0.5">{t.project.modeExistingFolderDesc}</div>
                </div>
              </button>
            </div>
          )}

          {/* ========== Mode: From Scratch ========== */}
          {mode === 'scratch' && (
            <div className="space-y-4 mt-4">
              {/* Name */}
              <div>
                <label className="text-[13px] font-medium text-[var(--abu-text-secondary)] mb-1.5 block">
                  {t.project.nameLabel} *
                </label>
                <Input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder={t.project.namePlaceholder}
                  autoFocus
                />
              </div>

              {/* Instructions */}
              <div>
                <label className="text-[13px] font-medium text-[var(--abu-text-secondary)] mb-1.5 block">
                  Instructions
                </label>
                <Textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="Tell Abu how to work in this project (optional)"
                  className="min-h-[80px] resize-none"
                />
              </div>


              {/* Project location (read-only) */}
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--abu-bg-subtle)] text-[12px] text-[var(--abu-text-tertiary)]">
                <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {projectName.trim()
                    ? joinPath(defaultProjectsDir, projectName.trim())
                    : defaultProjectsDir}
                </span>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <Button variant="ghost" onClick={onClose}>{t.project.cancel}</Button>
                <Button onClick={handleCreate} disabled={!canCreate}>{t.project.create}</Button>
              </div>
            </div>
          )}

          {/* ========== Mode: Existing Folder ========== */}
          {mode === 'existing-folder' && (
            <div className="space-y-4 mt-4">
              {/* Folder picker */}
              <div>
                <label className="text-[13px] font-medium text-[var(--abu-text-secondary)] mb-1.5 block">
                  {t.project.selectFolder}
                </label>
                <button
                  onClick={handleSelectFolder}
                  className="w-full flex items-center gap-2 p-3 rounded-lg border border-[var(--abu-border)] hover:border-[var(--abu-clay)] transition-colors text-left"
                >
                  <FolderOpen className="h-4 w-4 text-[var(--abu-clay)] shrink-0" />
                  <span className="text-[13px] text-[var(--abu-text-primary)] truncate flex-1">
                    {selectedFolder || t.project.selectFolder}
                  </span>
                </button>
              </div>

              {/* Status */}
              {selectedFolder && (
                <div className="space-y-2">
                  {hasAbuConfig && (
                    <div className="px-3 py-2 rounded-lg bg-[var(--abu-clay-bg)] text-[13px] text-[var(--abu-clay)]">
                      ✓ {t.project.detectedConfig}
                    </div>
                  )}
                  {conflictProject && (
                    <div className="px-3 py-2 rounded-lg bg-red-50 text-[13px] text-red-600">
                      ✗ {t.project.folderConflict.replace('{name}', conflictProject)}
                    </div>
                  )}
                </div>
              )}

              {/* Name */}
              <div>
                <label className="text-[13px] font-medium text-[var(--abu-text-secondary)] mb-1.5 block">
                  {t.project.nameLabel} *
                </label>
                <Input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder={t.project.namePlaceholder}
                />
              </div>


              {/* Actions */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <Button variant="ghost" onClick={onClose}>{t.project.cancel}</Button>
                <Button onClick={handleCreate} disabled={!canCreate}>{t.project.create}</Button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
