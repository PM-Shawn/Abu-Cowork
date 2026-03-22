import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '@/i18n';
import { format } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import { useChatStore } from '@/stores/chatStore';
import { X, FolderOpen, Archive } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { Project } from '@/types/project';

interface ProjectSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string | null;
}

export default function ProjectSettingsDialog({ open, onClose, projectId }: ProjectSettingsDialogProps) {
  const { t } = useI18n();
  const projects = useProjectStore((s) => s.projects);
  const updateProject = useProjectStore((s) => s.updateProject);
  const archiveProject = useProjectStore((s) => s.archiveProject);
  const conversations = useChatStore((s) => s.conversations);

  const project: Project | undefined = projectId ? projects[projectId] : undefined;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);

  // Sync form state with project data
  useEffect(() => {
    if (project) {
      setName(project.name);
      setDescription(project.description || '');
      setShowArchiveConfirm(false);
    }
  }, [project]);

  const handleSave = () => {
    if (!projectId || !name.trim()) return;
    updateProject(projectId, {
      name: name.trim(),
      description: description.trim() || undefined,
    });
    onClose();
  };

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, handleKeyDown]);

  if (!open || !project) return null;

  const convCount = Object.values(conversations).filter((c) => c.projectId === projectId).length;

  return (
    <>
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className="bg-white rounded-2xl shadow-xl w-[440px] animate-in zoom-in-95 duration-150">
          {/* Header */}
          <div className="flex items-center justify-between px-6 pt-6 pb-2">
            <h2 className="text-[16px] font-semibold text-[var(--abu-text-primary)]">
              {t.project.settingsTitle}
            </h2>
            <button
              onClick={onClose}
              className="p-1.5 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] rounded-lg"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="px-6 pb-6 space-y-4">
            {/* Name */}
            <div>
              <label className="text-[13px] font-medium text-[var(--abu-text-secondary)] mb-1.5 block">
                {t.project.nameLabel}
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t.project.namePlaceholder}
              />
            </div>

            {/* Description */}
            <div>
              <label className="text-[13px] font-medium text-[var(--abu-text-secondary)] mb-1.5 block">
                {t.project.descLabel}
              </label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t.project.descPlaceholder}
              />
            </div>

            {/* Folder path (read-only) */}
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--abu-bg-subtle)] text-[12px] text-[var(--abu-text-tertiary)]">
              <FolderOpen className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate flex-1">{project.workspacePath}</span>
              <span className="shrink-0">{format(t.project.conversationCount, { count: String(convCount) })}</span>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowArchiveConfirm(true)}
                className="text-red-500 border-red-200 hover:bg-red-50"
              >
                <Archive className="h-3.5 w-3.5 mr-1.5" />
                {t.project.archiveProject}
              </Button>
              <div className="flex items-center gap-3">
                <Button variant="ghost" onClick={onClose}>
                  {t.project.cancel}
                </Button>
                <Button onClick={handleSave} disabled={!name.trim()}>
                  {t.project.save}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Archive confirmation dialog */}
      {showArchiveConfirm && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
          onClick={(e) => { if (e.target === e.currentTarget) setShowArchiveConfirm(false); }}
        >
          <div className="bg-white rounded-2xl shadow-xl w-[380px] p-6 animate-in zoom-in-95 duration-150">
            <h3 className="text-[16px] font-semibold text-[var(--abu-text-primary)] mb-2">
              {t.project.archiveProject}
            </h3>
            <p className="text-[14px] text-[var(--abu-text-tertiary)] leading-relaxed mb-6">
              {format(t.project.archiveConfirm, { name: project.name })}
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setShowArchiveConfirm(false)}
                className="px-4 py-2 rounded-lg text-[13px] font-medium text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
              >
                {t.project.cancel}
              </button>
              <button
                onClick={() => {
                  archiveProject(projectId!);
                  setShowArchiveConfirm(false);
                  onClose();
                }}
                className="px-4 py-2 rounded-lg text-[13px] font-medium text-white bg-red-500 hover:bg-red-600 transition-colors"
              >
                {t.project.archive}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
