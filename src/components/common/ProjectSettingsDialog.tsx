import { useId, useMemo, useState } from 'react';
import { Button } from '@/components/ds/button';
import { MultiCombobox } from '@/components/ds/combobox';
import { useConfirm } from '@/components/ds/confirm-context';
import { Dialog, DialogClose } from '@/components/ds/dialog';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Popover } from '@/components/ds/popover';
import { Pressable } from '@/components/ds/pressable';
import { Select } from '@/components/ds/select';
import { TextField } from '@/components/ds/text-field';
import { format, useI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useMCPStore } from '@/stores/mcpStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Project } from '@/types/project';

interface ProjectSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string | null;
}

interface ProjectForm {
  name: string;
  description: string;
  icon: string;
  modelOverride: string;
  defaultSkills: string[];
  defaultMCPServers: string[];
}

const EMOJI_PALETTE = ['📁', '🚀', '🎯', '💡', '🔧', '📊', '🎨', '📝', '🌐', '⚡', '🏗️', '📦', '🧪', '🤖', '🔬', '📚'];
// The select's value for "follow the global setting"; the project then holds no model.
const NO_MODEL = '__none__';
const FIELD_LABEL = 'mb-1 block text-ui-sm font-medium text-label-secondary';
const GROUP_TITLE = 'text-ui-sm font-medium';

const formOf = (project: Project): ProjectForm => ({
  name: project.name,
  description: project.description || '',
  icon: project.icon || '',
  modelOverride: project.modelOverride || '',
  defaultSkills: project.defaultSkills || [],
  defaultMCPServers: project.defaultMCPServers || [],
});

const sameForm = (a: ProjectForm, b: ProjectForm) => a.name === b.name && a.description === b.description && a.icon === b.icon
  && a.modelOverride === b.modelOverride
  && a.defaultSkills.join('\u0000') === b.defaultSkills.join('\u0000')
  && a.defaultMCPServers.join('\u0000') === b.defaultMCPServers.join('\u0000');

// The options of a multi-select: what is on offer, then what was chosen and is no longer on
// offer, so it still shows and can be taken away.
const withChosen = (offered: string[], chosen: string[]) => [...offered, ...chosen.filter((value) => !offered.includes(value))]
  .map((value) => ({ value, label: value }));

export default function ProjectSettingsDialog({ open, onClose, projectId }: ProjectSettingsDialogProps) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const projects = useProjectStore((s) => s.projects);
  const updateProject = useProjectStore((s) => s.updateProject);
  const archiveProject = useProjectStore((s) => s.archiveProject);
  const conversationIndex = useChatStore((s) => s.conversationIndex);
  const providers = useSettingsStore((s) => s.providers);
  const skills = useDiscoveryStore((s) => s.skills);
  const mcpServers = useMCPStore((s) => s.servers);

  const project: Project | undefined = projectId ? projects[projectId] : undefined;
  // The window is on screen for a project that exists. Its owner drops the project together
  // with the window, so the last project shown is held while the window fades out.
  const isOpen = open && project !== undefined;
  const [held, setHeld] = useState<Project | null>(null);
  if (isOpen && held !== project) setHeld(project);
  const shown = isOpen ? project : held;

  // The form is filled when the window opens, or moves to another project, from the project as
  // the store holds it then. A later change to the project leaves what was typed alone.
  const [form, setForm] = useState<ProjectForm | null>(null);
  const [filled, setFilled] = useState<ProjectForm | null>(null);
  const [filledFor, setFilledFor] = useState<string | null>(null);
  if (isOpen && filledFor !== project.id) {
    const next = formOf(project);
    setFilledFor(project.id);
    setFilled(next);
    setForm(next);
  } else if (!isOpen && filledFor !== null) {
    setFilledFor(null);
  }
  const change = (part: Partial<ProjectForm>) => setForm((current) => (current ? { ...current, ...part } : current));

  const [iconPanelOpen, setIconPanelOpen] = useState(false);
  const nameId = useId();
  const descriptionId = useId();

  const modelOptions = useMemo(() => {
    const opts = [{ value: NO_MODEL, label: t.project.modelOverrideNone }];
    const listed = new Set<string>();
    for (const p of providers) {
      if (!p.enabled) continue;
      for (const m of p.models) {
        // A model two services offer is listed once, under the first of them.
        if (listed.has(m.id)) continue;
        listed.add(m.id);
        opts.push({ value: m.id, label: `${m.label || m.id} (${p.name})` });
      }
    }
    return opts;
  }, [providers, t.project.modelOverrideNone]);

  const chosenSkills = form?.defaultSkills;
  const skillOptions = useMemo(() => withChosen(skills.map((s) => s.name), chosenSkills ?? []), [skills, chosenSkills]);
  const chosenServers = form?.defaultMCPServers;
  const mcpOptions = useMemo(() => withChosen(Object.keys(mcpServers), chosenServers ?? []), [mcpServers, chosenServers]);

  const handleSave = () => {
    // The window keeps rendering while it fades out: nothing is saved then.
    if (!isOpen || !form || !form.name.trim()) return;
    updateProject(project.id, {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      icon: form.icon || undefined,
      modelOverride: form.modelOverride || undefined,
      defaultSkills: form.defaultSkills.length > 0 ? form.defaultSkills : undefined,
      defaultMCPServers: form.defaultMCPServers.length > 0 ? form.defaultMCPServers : undefined,
    });
    onClose();
  };

  const handleArchive = async () => {
    if (!isOpen) return;
    // The question names the project as the store holds it; it ends with this window.
    const { id, name } = project;
    const confirmed = await confirm({
      title: t.project.archiveProject,
      message: format(t.project.archiveConfirm, { name }),
      confirmLabel: t.project.archive,
      tone: 'danger',
    });
    if (!confirmed || !useProjectStore.getState().projects[id]) return;
    archiveProject(id);
    onClose();
  };

  const pickIcon = (icon: string) => {
    change({ icon });
    setIconPanelOpen(false);
  };

  const convCount = shown ? Object.values(conversationIndex).filter((c) => c.projectId === shown.id).length : 0;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={t.project.settingsTitle}
      size="md"
      closeButton
      dirty={form !== null && filled !== null && !sameForm(form, filled)}
      footer={(
        <>
          <DialogClose asChild><Button variant="plain">{t.project.cancel}</Button></DialogClose>
          <Button variant="primary" disabled={!form?.name.trim()} onClick={handleSave}>{t.project.save}</Button>
        </>
      )}
    >
      {shown && form && (
        <div className="flex flex-col gap-5">
          {/* === Basic Info === */}
          <div className="flex flex-col gap-3">
            <div className="flex items-end gap-3">
              <div>
                <div className={FIELD_LABEL}>{t.project.iconLabel}</div>
                <Popover
                  open={iconPanelOpen}
                  onOpenChange={setIconPanelOpen}
                  align="start"
                  label={t.project.iconLabel}
                  className="w-auto"
                  trigger={(
                    <Pressable
                      aria-label={t.project.iconLabel}
                      className="flex size-7 items-center justify-center rounded-control border border-control-border bg-field text-title hover:bg-fill-hover"
                    >
                      {form.icon || '📁'}
                    </Pressable>
                  )}
                >
                  <div className="grid grid-cols-8 gap-1">
                    {EMOJI_PALETTE.map((emoji) => (
                      <Pressable
                        key={emoji}
                        aria-label={emoji}
                        onClick={() => pickIcon(emoji)}
                        className="flex size-8 items-center justify-center rounded-control text-title hover:bg-fill-hover"
                      >
                        {emoji}
                      </Pressable>
                    ))}
                  </div>
                  {form.icon && (
                    <div className="mt-2 flex justify-center border-t border-separator pt-2">
                      <Button variant="plain" size="sm" onClick={() => pickIcon('')}>{t.project.delete}</Button>
                    </div>
                  )}
                </Popover>
              </div>
              <div className="min-w-0 flex-1">
                <label htmlFor={nameId} className={FIELD_LABEL}>{t.project.nameLabel}</label>
                <TextField
                  id={nameId}
                  className="w-full"
                  value={form.name}
                  onChange={(e) => change({ name: e.target.value })}
                  placeholder={t.project.namePlaceholder}
                />
              </div>
            </div>

            <div>
              <label htmlFor={descriptionId} className={FIELD_LABEL}>{t.project.descLabel}</label>
              <TextField
                id={descriptionId}
                className="w-full"
                value={form.description}
                onChange={(e) => change({ description: e.target.value })}
                placeholder={t.project.descPlaceholder}
              />
            </div>

            {/* Folder path (read-only) */}
            <div className="flex items-center gap-2 rounded-control bg-fill px-3 py-2 text-ui-sm text-label-tertiary">
              <Icon icon={AppIcons.folderOpen} size="sm" />
              <span className="min-w-0 flex-1 truncate">{shown.workspacePath}</span>
              <span className="shrink-0">{format(t.project.conversationCount, { count: String(convCount) })}</span>
            </div>
          </div>

          {/* === Defaults (inherited by new conversations) === */}
          <div className="flex flex-col gap-3">
            <h3 className={`${GROUP_TITLE} text-label-tertiary`}>{t.project.defaultsSection}</h3>

            <div>
              <div className={FIELD_LABEL}>{t.project.modelOverrideLabel}</div>
              <Select
                fullWidth
                label={t.project.modelOverrideLabel}
                value={form.modelOverride || NO_MODEL}
                options={modelOptions}
                onValueChange={(value) => change({ modelOverride: value === NO_MODEL ? '' : value })}
                placeholder={t.project.modelOverrideNone}
              />
            </div>

            {/* A column stretches the multi-select to the width of the fields above it. */}
            <div className="flex flex-col">
              <div className={FIELD_LABEL}>{t.project.defaultSkillsLabel}</div>
              <MultiCombobox
                label={t.project.defaultSkillsLabel}
                values={form.defaultSkills}
                onValuesChange={(defaultSkills) => change({ defaultSkills })}
                options={skillOptions}
                placeholder={t.project.defaultSkillsPlaceholder}
                searchPlaceholder={t.toolbox.searchPlaceholder}
                emptyText={t.toolbox.agentSkillsEmpty}
              />
            </div>

            <div className="flex flex-col">
              <div className={FIELD_LABEL}>{t.project.defaultMCPLabel}</div>
              <MultiCombobox
                label={t.project.defaultMCPLabel}
                values={form.defaultMCPServers}
                onValuesChange={(defaultMCPServers) => change({ defaultMCPServers })}
                options={mcpOptions}
                placeholder={t.project.defaultMCPPlaceholder}
                searchPlaceholder={t.toolbox.searchPlaceholder}
                emptyText={t.sidebar.searchNoResults}
              />
            </div>
          </div>

          {/* === Danger Zone === */}
          <div className="flex flex-col items-start gap-3">
            <h3 className={`${GROUP_TITLE} text-danger`}>{t.project.dangerZone}</h3>
            <Button variant="danger" size="sm" icon={AppIcons.archive} onClick={handleArchive}>
              {t.project.archiveProject}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
