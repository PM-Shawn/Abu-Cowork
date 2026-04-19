import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/i18n';
import { format } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useMCPStore } from '@/stores/mcpStore';
import { X, FolderOpen, Archive, ChevronDown, Check } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { Project } from '@/types/project';

interface ProjectSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string | null;
}

const EMOJI_PALETTE = ['📁', '🚀', '🎯', '💡', '🔧', '📊', '🎨', '📝', '🌐', '⚡', '🏗️', '📦', '🧪', '🤖', '🔬', '📚'];

function ChipMultiSelect({ selected, options, onChange, placeholder }: {
  selected: string[];
  options: { value: string; label: string }[];
  onChange: (values: string[]) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setDropdownStyle({ top: rect.bottom + 4, left: rect.left, width: rect.width });
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center justify-between w-full min-h-[36px] px-3 py-1.5 rounded-lg border text-left text-[13px]',
          'border-[var(--abu-border)] bg-[var(--abu-bg-primary)] hover:border-[var(--abu-border-hover)]',
          'focus:outline-none focus:ring-2 focus:ring-[var(--abu-ring)]',
        )}
      >
        <span className="flex flex-wrap gap-1 flex-1 min-w-0">
          {selected.length === 0 ? (
            <span className="text-[var(--abu-text-muted)]">{placeholder}</span>
          ) : (
            selected.map((v) => {
              const opt = options.find((o) => o.value === v);
              return (
                <span
                  key={v}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--abu-bg-subtle)] text-[12px] text-[var(--abu-text-secondary)]"
                >
                  {opt?.label ?? v}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onChange(selected.filter((s) => s !== v)); }}
                    className="text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })
          )}
        </span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 ml-1 text-[var(--abu-text-muted)] transition-transform', open && 'rotate-180')} />
      </button>

      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[10000]" onClick={() => setOpen(false)} />
          <div className="fixed z-[10001] max-h-[200px] overflow-auto rounded-lg border border-[var(--abu-border)] bg-white shadow-lg" style={dropdownStyle}>
            {options.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-[var(--abu-text-muted)]">-</div>
            ) : (
              options.map((opt) => {
                const isSelected = selected.includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      onChange(isSelected ? selected.filter((s) => s !== opt.value) : [...selected, opt.value]);
                    }}
                    className={cn(
                      'flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-left hover:bg-[var(--abu-bg-hover)]',
                      isSelected && 'text-[var(--abu-accent)]',
                    )}
                  >
                    <span className={cn('h-3.5 w-3.5 shrink-0 flex items-center justify-center', !isSelected && 'opacity-0')}>
                      <Check className="h-3.5 w-3.5" />
                    </span>
                    <span className="truncate">{opt.label}</span>
                  </button>
                );
              })
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

export default function ProjectSettingsDialog({ open, onClose, projectId }: ProjectSettingsDialogProps) {
  const { t } = useI18n();
  const projects = useProjectStore((s) => s.projects);
  const updateProject = useProjectStore((s) => s.updateProject);
  const archiveProject = useProjectStore((s) => s.archiveProject);
  const conversationIndex = useChatStore((s) => s.conversationIndex);
  const providers = useSettingsStore((s) => s.providers);
  const skills = useDiscoveryStore((s) => s.skills);
  const mcpServers = useMCPStore((s) => s.servers);

  const project: Project | undefined = projectId ? projects[projectId] : undefined;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [modelOverride, setModelOverride] = useState('');
  const [defaultSkills, setDefaultSkills] = useState<string[]>([]);
  const [defaultMCPServers, setDefaultMCPServers] = useState<string[]>([]);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  useEffect(() => {
    if (project) {
      setName(project.name);
      setDescription(project.description || '');
      setIcon(project.icon || '');
      setModelOverride(project.modelOverride || '');
      setDefaultSkills(project.defaultSkills || []);
      setDefaultMCPServers(project.defaultMCPServers || []);
      setShowArchiveConfirm(false);
      setShowEmojiPicker(false);
    }
  }, [project]);

  const handleSave = () => {
    if (!projectId || !name.trim()) return;
    updateProject(projectId, {
      name: name.trim(),
      description: description.trim() || undefined,
      icon: icon || undefined,
      modelOverride: modelOverride || undefined,
      defaultSkills: defaultSkills.length > 0 ? defaultSkills : undefined,
      defaultMCPServers: defaultMCPServers.length > 0 ? defaultMCPServers : undefined,
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

  const modelOptions = useMemo(() => {
    const opts = [{ value: '', label: t.project.modelOverrideNone }];
    for (const p of providers) {
      if (!p.enabled) continue;
      for (const m of p.models) {
        opts.push({ value: m.id, label: `${m.label || m.id} (${p.name})` });
      }
    }
    return opts;
  }, [providers, t.project.modelOverrideNone]);

  const skillOptions = useMemo(() =>
    skills.map((s) => ({ value: s.name, label: s.name })),
  [skills]);

  const mcpOptions = useMemo(() =>
    Object.keys(mcpServers).map((name) => ({ value: name, label: name })),
  [mcpServers]);

  if (!open || !project) return null;

  const convCount = Object.values(conversationIndex).filter((c) => c.projectId === projectId).length;

  return (
    <>
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className="bg-white rounded-2xl shadow-xl w-[480px] max-h-[85vh] flex flex-col animate-in zoom-in-95 duration-150">
          {/* Header */}
          <div className="flex items-center justify-between px-6 pt-6 pb-2 shrink-0">
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

          <ScrollArea className="flex-1 min-h-0">
            <div className="px-6 pb-6 space-y-5">

              {/* === Basic Info === */}
              <div className="space-y-3">
                {/* Icon + Name row */}
                <div className="flex items-end gap-3">
                  <div className="relative">
                    <label className="text-[13px] font-medium text-[var(--abu-text-secondary)] mb-1.5 block">
                      {t.project.iconLabel}
                    </label>
                    <button
                      type="button"
                      onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                      className={cn(
                        'flex items-center justify-center w-[36px] h-[36px] rounded-lg border text-[18px]',
                        'border-[var(--abu-border)] hover:border-[var(--abu-border-hover)] bg-[var(--abu-bg-primary)]',
                      )}
                    >
                      {icon || '📁'}
                    </button>
                    {showEmojiPicker && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setShowEmojiPicker(false)} />
                        <div className="absolute z-20 mt-1 left-0 grid grid-cols-8 gap-1 p-2 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-primary)] shadow-lg">
                          {EMOJI_PALETTE.map((emoji) => (
                            <button
                              key={emoji}
                              type="button"
                              onClick={() => { setIcon(emoji); setShowEmojiPicker(false); }}
                              className="flex items-center justify-center w-8 h-8 rounded hover:bg-[var(--abu-bg-hover)] text-[16px]"
                            >
                              {emoji}
                            </button>
                          ))}
                          {icon && (
                            <button
                              type="button"
                              onClick={() => { setIcon(''); setShowEmojiPicker(false); }}
                              className="flex items-center justify-center w-8 h-8 rounded hover:bg-[var(--abu-bg-hover)] text-[11px] text-[var(--abu-text-muted)] col-span-8 border-t border-[var(--abu-border)] mt-1 pt-1"
                            >
                              {t.project.delete}
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="flex-1">
                    <label className="text-[13px] font-medium text-[var(--abu-text-secondary)] mb-1.5 block">
                      {t.project.nameLabel}
                    </label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={t.project.namePlaceholder}
                    />
                  </div>
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
              </div>

              {/* === Defaults (inherited by new conversations) === */}
              <div className="space-y-3">
                <h3 className="text-[12px] font-semibold text-[var(--abu-text-muted)] uppercase tracking-wider">
                  {t.project.defaultsSection}
                </h3>

                {/* Model Override */}
                <div>
                  <label className="text-[13px] font-medium text-[var(--abu-text-secondary)] mb-1.5 block">
                    {t.project.modelOverrideLabel}
                  </label>
                  <Select
                    value={modelOverride}
                    options={modelOptions}
                    onChange={setModelOverride}
                    placeholder={t.project.modelOverrideNone}
                  />
                </div>

                {/* Default Skills */}
                <div>
                  <label className="text-[13px] font-medium text-[var(--abu-text-secondary)] mb-1.5 block">
                    {t.project.defaultSkillsLabel}
                  </label>
                  <ChipMultiSelect
                    selected={defaultSkills}
                    options={skillOptions}
                    onChange={setDefaultSkills}
                    placeholder={t.project.defaultSkillsPlaceholder}
                  />
                </div>

                {/* Default MCP Servers */}
                <div>
                  <label className="text-[13px] font-medium text-[var(--abu-text-secondary)] mb-1.5 block">
                    {t.project.defaultMCPLabel}
                  </label>
                  <ChipMultiSelect
                    selected={defaultMCPServers}
                    options={mcpOptions}
                    onChange={setDefaultMCPServers}
                    placeholder={t.project.defaultMCPPlaceholder}
                  />
                </div>
              </div>

              {/* === Danger Zone === */}
              <div className="space-y-3 pt-1">
                <h3 className="text-[12px] font-semibold text-red-400 uppercase tracking-wider">
                  {t.project.dangerZone}
                </h3>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowArchiveConfirm(true)}
                  className="text-red-500 border-red-200 hover:bg-red-50"
                >
                  <Archive className="h-3.5 w-3.5 mr-1.5" />
                  {t.project.archiveProject}
                </Button>
              </div>

              {/* Save / Cancel */}
              <div className="flex items-center justify-end gap-3 pt-2 border-t border-[var(--abu-border)]">
                <Button variant="ghost" onClick={onClose}>
                  {t.project.cancel}
                </Button>
                <Button onClick={handleSave} disabled={!name.trim()}>
                  {t.project.save}
                </Button>
              </div>
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* Archive confirmation dialog */}
      {showArchiveConfirm && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setShowArchiveConfirm(false); }}
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
