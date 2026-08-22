import { useState, useEffect, useMemo } from 'react';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useProjectStore } from '@/stores/projectStore';
import { useI18n } from '@/i18n';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Select } from '@/components/ui/select';
import type {
  ScheduleFrequency,
  ScheduleConfig,
} from '@/types/schedule';
import type { PermissionMode } from '@/core/permissions/permissionMode';

const FREQUENCIES: ScheduleFrequency[] = ['hourly', 'daily', 'weekly', 'weekdays', 'manual'];

/** Same three tiers chat already uses — reuse its wording rather than a
 *  scheduler-only vocabulary. Offered alongside "follow settings" (the
 *  `undefined` sentinel), which is the default. */
const PERMISSION_MODES: PermissionMode[] = ['standard', 'smart', 'autonomous'];

/** Select component values are strings; '' is the sentinel for "follow
 *  settings" (permissionMode === undefined). */
const FOLLOW_SETTINGS_VALUE = '';

export default function ScheduleEditor() {
  const { t } = useI18n();
  const { showEditor, editingTaskId, closeEditor, createTask, updateTask, tasks } =
    useScheduleStore();
  const skills = useDiscoveryStore((s) => s.skills);
  const channelsMap = useIMChannelStore((s) => s.channels);
  const imChannels = useMemo(() => Object.values(channelsMap), [channelsMap]);
  const projectsMap = useProjectStore((s) => s.projects);
  const activeProjects = useMemo(() =>
    Object.values(projectsMap).filter((p) => !p.archived).sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    [projectsMap]
  );

  const editingTask = editingTaskId ? tasks[editingTaskId] : null;

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [frequency, setFrequency] = useState<ScheduleFrequency>('daily');
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [skillName, setSkillName] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [projectId, setProjectId] = useState('');
  const [outputChannelId, setOutputChannelId] = useState('');
  const [outputChatIds, setOutputChatIds] = useState('');
  const [outputUserIds, setOutputUserIds] = useState('');
  // undefined = follow the global settings permission mode (the default).
  const [permissionMode, setPermissionMode] = useState<PermissionMode | undefined>(undefined);

  // Initialize form when editing task changes
  useEffect(() => {
    if (editingTask) {
      setName(editingTask.name);
      setDescription(editingTask.description ?? '');
      setPrompt(editingTask.prompt);
      setFrequency(editingTask.schedule.frequency);
      setHour(editingTask.schedule.time?.hour ?? 9);
      setMinute(editingTask.schedule.time?.minute ?? 0);
      setDayOfWeek(editingTask.schedule.dayOfWeek ?? 1);
      setSkillName(editingTask.skillName ?? '');
      setWorkspacePath(editingTask.workspacePath ?? '');
      setProjectId(editingTask.projectId ?? '');
      setOutputChannelId(editingTask.outputChannelId ?? '');
      setOutputChatIds(editingTask.outputChatIds ?? '');
      setOutputUserIds(editingTask.outputUserIds ?? '');
      setPermissionMode(editingTask.permissionMode);
    } else {
      setName('');
      setDescription('');
      setPrompt('');
      setFrequency('daily');
      setHour(9);
      setMinute(0);
      setDayOfWeek(1);
      setSkillName('');
      setWorkspacePath('');
      setProjectId('');
      setOutputChannelId('');
      setOutputChatIds('');
      setOutputUserIds('');
      setPermissionMode(undefined);
    }
  }, [editingTask, showEditor]);

  // Close on Escape key
  useEffect(() => {
    if (!showEditor) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeEditor();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showEditor, closeEditor]);

  if (!showEditor) return null;

  const frequencyLabels: Record<ScheduleFrequency, string> = {
    hourly: t.schedule.frequencyHourly,
    daily: t.schedule.frequencyDaily,
    weekly: t.schedule.frequencyWeekly,
    weekdays: t.schedule.frequencyWeekdays,
    manual: t.schedule.frequencyManual,
  };

  const dayLabels = [
    t.schedule.sunday,
    t.schedule.monday,
    t.schedule.tuesday,
    t.schedule.wednesday,
    t.schedule.thursday,
    t.schedule.friday,
    t.schedule.saturday,
  ];

  // Same wording chat's PermissionModeChip uses — one vocabulary, not a
  // schedule-specific translation of it.
  const permissionModeInfo: Record<PermissionMode, { label: string; description: string }> = {
    standard: { label: t.settings.permissionModeStandard, description: t.settings.permissionModeStandardDesc },
    smart: { label: t.settings.permissionModeSmart, description: t.settings.permissionModeSmartDesc },
    autonomous: { label: t.settings.permissionModeAutonomous, description: t.settings.permissionModeAutonomousDesc },
  };

  const showTimeSelector = frequency !== 'manual';
  const showHourSelector = frequency !== 'hourly';
  const showDaySelector = frequency === 'weekly';

  const handleSave = () => {
    if (!name.trim() || !prompt.trim()) return;

    const schedule: ScheduleConfig = {
      frequency,
      time: frequency !== 'manual' ? { hour, minute } : undefined,
      dayOfWeek: frequency === 'weekly' ? dayOfWeek : undefined,
    };

    // Resolve effective workspace: project's path takes priority
    const effectiveWorkspace = projectId
      ? useProjectStore.getState().projects[projectId]?.workspacePath || workspacePath
      : workspacePath;

    if (editingTaskId) {
      updateTask(editingTaskId, {
        name: name.trim(),
        description: description.trim() || undefined,
        prompt: prompt.trim(),
        schedule,
        skillName: skillName || undefined,
        workspacePath: effectiveWorkspace || undefined,
        projectId: projectId || undefined,
        outputChannelId: outputChannelId || undefined,
        outputChatIds: outputChannelId && outputChatIds.trim() ? outputChatIds.trim() : undefined,
        outputUserIds: outputChannelId && outputUserIds.trim() ? outputUserIds.trim() : undefined,
        permissionMode,
      });
    } else {
      createTask({
        name: name.trim(),
        description: description.trim() || undefined,
        prompt: prompt.trim(),
        schedule,
        skillName: skillName || undefined,
        workspacePath: effectiveWorkspace || undefined,
        projectId: projectId || undefined,
        outputChannelId: outputChannelId || undefined,
        outputChatIds: outputChannelId && outputChatIds.trim() ? outputChatIds.trim() : undefined,
        outputUserIds: outputChannelId && outputUserIds.trim() ? outputUserIds.trim() : undefined,
        permissionMode,
      });
    }

    closeEditor();
  };

  return (
    <div data-electron-no-drag className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) closeEditor(); }}>
      <div className="bg-[var(--abu-bg-base)] rounded-2xl shadow-xl w-[480px] max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--abu-bg-active)] shrink-0">
          <h2 className="text-h-sm font-semibold text-[var(--abu-text-primary)]">
            {editingTaskId ? t.schedule.editTask : t.schedule.newTask}
          </h2>
          <button
            onClick={closeEditor}
            className="p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-active)] transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form */}
        <div className="px-6 py-4 space-y-4 overflow-auto flex-1">
          {/* Task name */}
          <div>
            <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
              {t.schedule.taskName}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.schedule.taskNamePlaceholder}
              className="w-full h-10 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]"
            />
          </div>

          {/* Task description */}
          <div>
            <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
              {t.schedule.description}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t.schedule.descriptionPlaceholder}
              rows={2}
              className="w-full px-3 py-2 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] resize-none"
            />
          </div>

          {/* Task prompt */}
          <div>
            <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
              {t.schedule.taskPrompt}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t.schedule.taskPromptPlaceholder}
              rows={4}
              className="w-full px-3 py-2 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] resize-none"
            />
          </div>

          {/* Frequency selector */}
          <div>
            <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
              {t.schedule.frequency}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {FREQUENCIES.map((freq) => (
                <button
                  key={freq}
                  onClick={() => setFrequency(freq)}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-minor font-medium transition-colors',
                    frequency === freq
                      ? 'bg-[var(--abu-clay)] text-white'
                      : 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
                  )}
                >
                  {frequencyLabels[freq]}
                </button>
              ))}
            </div>
          </div>

          {/* Time selector */}
          {showTimeSelector && (
            <div>
              <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
                {frequency === 'hourly' ? t.schedule.minuteOfHour : t.schedule.executionTime}
              </label>
              <div className="flex items-center gap-2">
                {showHourSelector && (
                  <>
                    <Select
                      value={String(hour)}
                      onChange={(v) => setHour(Number(v))}
                      options={Array.from({ length: 24 }, (_, i) => ({
                        value: String(i),
                        label: i.toString().padStart(2, '0'),
                      }))}
                      className="w-20"
                    />
                    <span className="text-[var(--abu-text-tertiary)]">:</span>
                  </>
                )}
                <Select
                  value={String(minute)}
                  onChange={(v) => setMinute(Number(v))}
                  options={Array.from({ length: 60 }, (_, i) => ({
                    value: String(i),
                    label: i.toString().padStart(2, '0'),
                  }))}
                  className="w-20"
                />
              </div>
            </div>
          )}

          {/* Day of week selector */}
          {showDaySelector && (
            <div>
              <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
                {t.schedule.dayOfWeek}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {dayLabels.map((label, idx) => (
                  <button
                    key={idx}
                    onClick={() => setDayOfWeek(idx)}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-minor font-medium transition-colors',
                      dayOfWeek === idx
                        ? 'bg-[var(--abu-clay)] text-white'
                        : 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Skill binding */}
          {skills.length > 0 && (
            <div>
              <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
                {t.schedule.bindSkill}
              </label>
              <Select
                value={skillName}
                onChange={setSkillName}
                placeholder={t.schedule.bindSkillNone}
                options={[
                  { value: '', label: t.schedule.bindSkillNone },
                  ...skills
                    .filter((s) => s.userInvocable)
                    .map((s) => ({ value: s.name, label: s.name })),
                ]}
              />
            </div>
          )}

          {/* Project selector */}
          {activeProjects.length > 0 && (
            <div>
              <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
                {t.project.projectLabel}
              </label>
              <Select
                value={projectId}
                onChange={(val) => {
                  setProjectId(val);
                  // Auto-fill workspace from project
                  if (val) {
                    const proj = useProjectStore.getState().projects[val];
                    if (proj) setWorkspacePath(proj.workspacePath);
                  }
                }}
                options={[
                  { value: '', label: t.project.projectNone },
                  ...activeProjects.map((p) => ({
                    value: p.id,
                    label: p.name,
                  })),
                ]}
              />
            </div>
          )}

          {/* Workspace path */}
          <div>
            <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
              {t.schedule.workspacePath}
            </label>
            <input
              type="text"
              value={projectId ? (useProjectStore.getState().projects[projectId]?.workspacePath || workspacePath) : workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              placeholder={t.schedule.workspacePathPlaceholder}
              disabled={!!projectId}
              className={cn(
                'w-full h-10 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]',
                projectId && 'opacity-60 cursor-not-allowed'
              )}
            />
          </div>

          {/* Autonomy tier — the ceiling for this unattended run. Reuses
              chat's own standard/smart/autonomous wording (plus a
              schedule-only "follow settings" option) rather than a fourth
              vocabulary. */}
          <div>
            <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
              {t.schedule.permissionMode}
            </label>
            <Select
              value={permissionMode ?? FOLLOW_SETTINGS_VALUE}
              onChange={(v) =>
                setPermissionMode(v === FOLLOW_SETTINGS_VALUE ? undefined : (v as PermissionMode))
              }
              options={[
                { value: FOLLOW_SETTINGS_VALUE, label: t.schedule.permissionModeFollowSettings },
                ...PERMISSION_MODES.map((mode) => ({
                  value: mode,
                  label: `${permissionModeInfo[mode].label} — ${permissionModeInfo[mode].description}`,
                })),
              ]}
            />
            <p className="text-caption text-[var(--abu-text-muted)] mt-1">
              {t.schedule.permissionModeHint}
            </p>
          </div>

          {/* Output to IM channel */}
          <div>
            <label className="block text-body font-medium text-[var(--abu-text-primary)] mb-1.5">
              {t.schedule.outputChannel}
            </label>
            <Select
              value={outputChannelId}
              onChange={setOutputChannelId}
              placeholder={t.schedule.outputChannelNone}
              options={[
                { value: '', label: t.schedule.outputChannelNone },
                ...imChannels.map((c) => ({
                  value: c.id,
                  label: `${c.name} (${c.platform})`,
                })),
              ]}
            />
            <p className="text-caption text-[var(--abu-text-muted)] mt-1">{t.schedule.outputChannelHint}</p>
            {outputChannelId && (
              <div className="space-y-2 mt-2">
                <div>
                  <label className="block text-minor text-[var(--abu-text-tertiary)] mb-1">{t.schedule.outputToGroup}</label>
                  <input
                    type="text"
                    value={outputChatIds}
                    onChange={(e) => setOutputChatIds(e.target.value)}
                    placeholder={t.schedule.outputChatIdPlaceholder}
                    className="w-full h-9 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]"
                  />
                </div>
                <div>
                  <label className="block text-minor text-[var(--abu-text-tertiary)] mb-1">{t.schedule.outputToDM}</label>
                  <input
                    type="text"
                    value={outputUserIds}
                    onChange={(e) => setOutputUserIds(e.target.value)}
                    placeholder={t.schedule.outputUserIdPlaceholder}
                    className="w-full h-9 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-[var(--abu-bg-active)] shrink-0">
          <button
            onClick={closeEditor}
            className="px-4 py-2 rounded-lg text-body text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
          >
            {t.common.cancel}
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || !prompt.trim()}
            className={cn(
              'px-4 py-2 rounded-lg text-body font-medium transition-colors',
              name.trim() && prompt.trim()
                ? 'bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)]'
                : 'bg-[var(--abu-border)] text-[var(--abu-text-tertiary)] cursor-not-allowed'
            )}
          >
            {t.common.save}
          </button>
        </div>
      </div>
    </div>
  );
}
