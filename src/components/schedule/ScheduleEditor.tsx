import { useState, useEffect, useId, useMemo } from 'react';
import { Button } from '@/components/ds/button';
import { Combobox, type ComboboxOption } from '@/components/ds/combobox';
import { Dialog, DialogClose } from '@/components/ds/dialog';
import { SegmentedControl } from '@/components/ds/segmented-control';
import { Select } from '@/components/ds/select';
import { TextArea } from '@/components/ds/text-area';
import { TextField } from '@/components/ds/text-field';
import TeamAvatar from '@/components/team/TeamAvatar';
import { useVisibleTeams } from '@/core/team/useVisibleTeams';
import { useI18n } from '@/i18n';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useProjectStore } from '@/stores/projectStore';
import { useScheduleStore } from '@/stores/scheduleStore';
import type {
  ScheduleFrequency,
  ScheduleConfig,
  ScheduledTask,
} from '@/types/schedule';
import type { PermissionMode } from '@/core/permissions/permissionMode';

const FREQUENCIES: ScheduleFrequency[] = ['hourly', 'daily', 'weekly', 'weekdays', 'manual'];

/** Same three tiers chat already uses — reuse its wording rather than a
 *  scheduler-only vocabulary. Offered alongside "follow settings" (the
 *  `undefined` sentinel), which is the default. */
const PERMISSION_MODES: PermissionMode[] = ['standard', 'smart', 'autonomous'];

/** What a list shows as chosen while the field holds nothing: no expert team, no skill, no
 *  project, no channel, "follow settings". A list option cannot have an empty value. */
const NONE = '__none__';

const twoDigits = (count: number) => Array.from({ length: count }, (_, i) => ({
  value: String(i),
  label: i.toString().padStart(2, '0'),
}));
const HOUR_OPTIONS = twoDigits(24);
const MINUTE_OPTIONS = twoDigits(60);

/** What the form holds. The window asks before closing once a field differs from what it opened with. */
interface Fields {
  name: string;
  description: string;
  prompt: string;
  frequency: ScheduleFrequency;
  hour: number;
  minute: number;
  dayOfWeek: number;
  skillName: string;
  teamId: string;
  workspacePath: string;
  projectId: string;
  outputChannelId: string;
  outputChatIds: string;
  outputUserIds: string;
  // undefined = follow the global settings permission mode (the default).
  permissionMode: PermissionMode | undefined;
}

function fieldsOf(task: ScheduledTask | null): Fields {
  return {
    name: task?.name ?? '',
    description: task?.description ?? '',
    prompt: task?.prompt ?? '',
    frequency: task?.schedule.frequency ?? 'daily',
    hour: task?.schedule.time?.hour ?? 9,
    minute: task?.schedule.time?.minute ?? 0,
    dayOfWeek: task?.schedule.dayOfWeek ?? 1,
    skillName: task?.skillName ?? '',
    teamId: task?.teamId ?? '',
    workspacePath: task?.workspacePath ?? '',
    projectId: task?.projectId ?? '',
    outputChannelId: task?.outputChannelId ?? '',
    outputChatIds: task?.outputChatIds ?? '',
    outputUserIds: task?.outputUserIds ?? '',
    permissionMode: task?.permissionMode,
  };
}

const FIELD_LABEL = 'mb-1 block text-ui-sm font-medium text-label-secondary';
const HINT = 'mt-1 text-caption text-label-tertiary';

/**
 * The window that creates a scheduled task or edits one. It stays mounted and is closed, not
 * removed, so it fades out showing what it showed; a save pressed in the fading window does
 * nothing. It asks before it discards what was typed.
 */
export default function ScheduleEditor({ onCloseAutoFocus }: {
  // Runs once the window has gone, before the focus returns to what opened it (ds `Dialog`).
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const { showEditor, editingTaskId, closeEditor, createTask, updateTask } =
    useScheduleStore();
  const skills = useDiscoveryStore((s) => s.skills);
  const channelsMap = useIMChannelStore((s) => s.channels);
  const imChannels = useMemo(() => Object.values(channelsMap), [channelsMap]);
  const projectsMap = useProjectStore((s) => s.projects);
  const activeProjects = useMemo(() =>
    Object.values(projectsMap).filter((p) => !p.archived).sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    [projectsMap]
  );

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [frequency, setFrequency] = useState<ScheduleFrequency>('daily');
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [skillName, setSkillName] = useState('');
  // Team executor (labs-gated): when set, the prompt is handed to this team
  // as a task goal instead of running a plain conversation.
  const [teamId, setTeamId] = useState('');
  const visibleTeams = useVisibleTeams();
  const teams = useMemo(() => visibleTeams.filter(team => !team.managed || team.managed.ready), [visibleTeams]);
  const [workspacePath, setWorkspacePath] = useState('');
  const [projectId, setProjectId] = useState('');
  const [outputChannelId, setOutputChannelId] = useState('');
  const [outputChatIds, setOutputChatIds] = useState('');
  const [outputUserIds, setOutputUserIds] = useState('');
  // undefined = follow the global settings permission mode (the default).
  const [permissionMode, setPermissionMode] = useState<PermissionMode | undefined>(undefined);
  // What the fields held when the window opened, and whether it opened on an existing task.
  // Both stay as they are while the window fades out, like the fields.
  const [opened, setOpened] = useState<Fields | null>(null);
  const [editing, setEditing] = useState(false);

  // Initialize the form when the window opens, or moves to another task. A run of the task that
  // starts or ends while the window is open leaves the form alone: the task is read from the
  // store here, not subscribed to.
  useEffect(() => {
    if (!showEditor) return;
    const editingTask = editingTaskId
      ? useScheduleStore.getState().tasks[editingTaskId] ?? null
      : null;
    const fields = fieldsOf(editingTask);
    setName(fields.name);
    setDescription(fields.description);
    setPrompt(fields.prompt);
    setFrequency(fields.frequency);
    setHour(fields.hour);
    setMinute(fields.minute);
    setDayOfWeek(fields.dayOfWeek);
    setSkillName(fields.skillName);
    setTeamId(fields.teamId);
    setWorkspacePath(fields.workspacePath);
    setProjectId(fields.projectId);
    setOutputChannelId(fields.outputChannelId);
    setOutputChatIds(fields.outputChatIds);
    setOutputUserIds(fields.outputUserIds);
    setPermissionMode(fields.permissionMode);
    setOpened(fields);
    setEditing(editingTask !== null);
  }, [editingTaskId, showEditor]);

  // Stable option objects: the list rows are compared by them.
  const teamOptions = useMemo<ComboboxOption[]>(() => [
    { value: NONE, label: t.schedule.teamExecutorNone },
    ...teams.map((team) => ({ value: team.id, label: team.name, icon: <TeamAvatar avatar={team.avatar} size="sm" /> })),
  ], [teams, t]);

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

  const current: Fields = {
    name, description, prompt, frequency, hour, minute, dayOfWeek, skillName, teamId, workspacePath,
    projectId, outputChannelId, outputChatIds, outputUserIds, permissionMode,
  };
  const dirty = showEditor && opened !== null && (Object.keys(opened) as (keyof Fields)[]).some((key) => current[key] !== opened[key]);

  const handleSave = () => {
    // The window stays on the page while it fades out; a key press there saves nothing.
    if (!showEditor) return;
    if (!name.trim()) return;
    if (!prompt.trim()) return;

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
      // The form holds every field, so an empty optional field is removed (null).
      updateTask(editingTaskId, {
        name: name.trim(),
        description: description.trim() || null,
        prompt: prompt.trim(),
        teamId: teamId || null,
        schedule,
        skillName: skillName || null,
        workspacePath: effectiveWorkspace || null,
        projectId: projectId || null,
        outputChannelId: outputChannelId || null,
        outputChatIds: outputChannelId && outputChatIds.trim() ? outputChatIds.trim() : null,
        outputUserIds: outputChannelId && outputUserIds.trim() ? outputUserIds.trim() : null,
        permissionMode,
      });
    } else {
      createTask({
        name: name.trim(),
        description: description.trim() || undefined,
        prompt: prompt.trim(),
        teamId: teamId || undefined,
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
    <Dialog
      open={showEditor}
      onOpenChange={(next) => { if (!next) closeEditor(); }}
      title={editing ? t.schedule.editTask : t.schedule.newTask}
      // Wide enough for the seven weekdays in one row, in English as well.
      size="lg"
      closeButton
      dirty={dirty}
      onCloseAutoFocus={onCloseAutoFocus}
      footer={(
        <>
          <DialogClose asChild><Button variant="plain">{t.common.cancel}</Button></DialogClose>
          <Button variant="primary" disabled={!name.trim() || !prompt.trim()} onClick={handleSave}>
            {t.common.save}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div>
          <label htmlFor={`${id}-name`} className={FIELD_LABEL}>{t.schedule.taskName}</label>
          <TextField
            id={`${id}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.schedule.taskNamePlaceholder}
          />
        </div>

        <div>
          <label htmlFor={`${id}-description`} className={FIELD_LABEL}>{t.schedule.description}</label>
          <TextArea
            id={`${id}-description`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t.schedule.descriptionPlaceholder}
            rows={2}
          />
        </div>

        {/* Team executor: the run becomes a scheduled conversation pinned to the team */}
        {teams.length > 0 && (
          <div>
            <div className={FIELD_LABEL}>{t.schedule.teamExecutor}</div>
            {/* A column stretches the combobox to the width of the form. */}
            <div className="flex flex-col" data-testid="schedule-team-select">
              <Combobox
                label={t.schedule.teamExecutor}
                value={teamId || NONE}
                // Picking the team that is already chosen takes it off again.
                onValueChange={(picked) => setTeamId(picked === NONE || picked === teamId ? '' : picked)}
                options={teamOptions}
                placeholder={t.schedule.teamExecutorNone}
                searchPlaceholder={t.schedule.teamExecutorSearch}
                emptyText={t.schedule.teamExecutorEmpty}
              />
            </div>
            <p className={HINT}>{t.schedule.teamExecutorHint}</p>
          </div>
        )}

        <div>
          <label htmlFor={`${id}-prompt`} className={FIELD_LABEL}>{t.schedule.taskPrompt}</label>
          <TextArea
            id={`${id}-prompt`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t.schedule.taskPromptPlaceholder}
            rows={4}
          />
        </div>

        <div>
          <div className={FIELD_LABEL}>{t.schedule.frequency}</div>
          <SegmentedControl
            label={t.schedule.frequency}
            value={frequency}
            onValueChange={(next) => setFrequency(next as ScheduleFrequency)}
            options={FREQUENCIES.map((freq) => ({ value: freq, label: frequencyLabels[freq] }))}
          />
        </div>

        {showTimeSelector && (
          <div>
            <div className={FIELD_LABEL}>
              {frequency === 'hourly' ? t.schedule.minuteOfHour : t.schedule.executionTime}
            </div>
            <div className="flex items-center gap-2">
              {showHourSelector && (
                <>
                  <div className="w-20">
                    <Select
                      fullWidth
                      label={t.schedule.executionTime}
                      value={String(hour)}
                      onValueChange={(v) => setHour(Number(v))}
                      options={HOUR_OPTIONS}
                    />
                  </div>
                  <span className="text-label-tertiary">:</span>
                </>
              )}
              <div className="w-20">
                <Select
                  fullWidth
                  label={t.schedule.minuteOfHour}
                  value={String(minute)}
                  onValueChange={(v) => setMinute(Number(v))}
                  options={MINUTE_OPTIONS}
                />
              </div>
            </div>
          </div>
        )}

        {showDaySelector && (
          <div>
            <div className={FIELD_LABEL}>{t.schedule.dayOfWeek}</div>
            <SegmentedControl
              label={t.schedule.dayOfWeek}
              value={String(dayOfWeek)}
              onValueChange={(next) => setDayOfWeek(Number(next))}
              options={dayLabels.map((label, idx) => ({ value: String(idx), label }))}
            />
          </div>
        )}

        {skills.length > 0 && (
          <div>
            <div className={FIELD_LABEL}>{t.schedule.bindSkill}</div>
            <Select
              fullWidth
              label={t.schedule.bindSkill}
              value={skillName || NONE}
              onValueChange={(next) => setSkillName(next === NONE ? '' : next)}
              options={[
                { value: NONE, label: t.schedule.bindSkillNone },
                ...skills
                  .filter((s) => s.userInvocable)
                  .map((s) => ({ value: s.name, label: s.name })),
              ]}
            />
          </div>
        )}

        {activeProjects.length > 0 && (
          <div>
            <div className={FIELD_LABEL}>{t.project.projectLabel}</div>
            <Select
              fullWidth
              label={t.project.projectLabel}
              value={projectId || NONE}
              onValueChange={(next) => {
                const val = next === NONE ? '' : next;
                setProjectId(val);
                // Auto-fill workspace from project
                if (val) {
                  const proj = useProjectStore.getState().projects[val];
                  if (proj) setWorkspacePath(proj.workspacePath);
                }
              }}
              options={[
                { value: NONE, label: t.project.projectNone },
                ...activeProjects.map((p) => ({
                  value: p.id,
                  label: p.name,
                })),
              ]}
            />
          </div>
        )}

        <div>
          <label htmlFor={`${id}-workspace`} className={FIELD_LABEL}>{t.schedule.workspacePath}</label>
          <TextField
            id={`${id}-workspace`}
            value={projectId ? (useProjectStore.getState().projects[projectId]?.workspacePath || workspacePath) : workspacePath}
            onChange={(e) => setWorkspacePath(e.target.value)}
            placeholder={t.schedule.workspacePathPlaceholder}
            disabled={!!projectId}
          />
        </div>

        {/* Autonomy tier — the ceiling for this unattended run. Reuses
            chat's own standard/smart/autonomous wording (plus a
            schedule-only "follow settings" option) rather than a fourth
            vocabulary. */}
        <div>
          <div className={FIELD_LABEL}>{t.schedule.permissionMode}</div>
          <Select
            fullWidth
            label={t.schedule.permissionMode}
            value={permissionMode ?? NONE}
            onValueChange={(next) => setPermissionMode(next === NONE ? undefined : (next as PermissionMode))}
            options={[
              { value: NONE, label: t.schedule.permissionModeFollowSettings },
              ...PERMISSION_MODES.map((mode) => ({
                value: mode,
                label: permissionModeInfo[mode].label,
                description: permissionModeInfo[mode].description,
              })),
            ]}
          />
          <p className={HINT}>{t.schedule.permissionModeHint}</p>
        </div>

        {/* Output to IM channel */}
        <div>
          <div className={FIELD_LABEL}>{t.schedule.outputChannel}</div>
          <Select
            fullWidth
            label={t.schedule.outputChannel}
            value={outputChannelId || NONE}
            onValueChange={(next) => setOutputChannelId(next === NONE ? '' : next)}
            options={[
              { value: NONE, label: t.schedule.outputChannelNone },
              ...imChannels.map((c) => ({
                value: c.id,
                label: `${c.name} (${c.platform})`,
              })),
            ]}
          />
          <p className={HINT}>{t.schedule.outputChannelHint}</p>
          {outputChannelId && (
            <div className="mt-2 space-y-2">
              <div>
                <label htmlFor={`${id}-chats`} className={FIELD_LABEL}>{t.schedule.outputToGroup}</label>
                <TextField
                  id={`${id}-chats`}
                  value={outputChatIds}
                  onChange={(e) => setOutputChatIds(e.target.value)}
                  placeholder={t.schedule.outputChatIdPlaceholder}
                />
              </div>
              <div>
                <label htmlFor={`${id}-users`} className={FIELD_LABEL}>{t.schedule.outputToDM}</label>
                <TextField
                  id={`${id}-users`}
                  value={outputUserIds}
                  onChange={(e) => setOutputUserIds(e.target.value)}
                  placeholder={t.schedule.outputUserIdPlaceholder}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
