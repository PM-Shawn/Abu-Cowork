import { useState, useEffect, useMemo } from 'react';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useI18n } from '@/i18n';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Select } from '@/components/ui/select';
import type { ScheduleFrequency, ScheduleConfig } from '@/types/schedule';

const FREQUENCIES: ScheduleFrequency[] = ['hourly', 'daily', 'weekly', 'weekdays', 'manual'];

export default function ScheduleEditor() {
  const { t } = useI18n();
  const { showEditor, editingTaskId, closeEditor, createTask, updateTask, tasks } =
    useScheduleStore();
  const skills = useDiscoveryStore((s) => s.skills);
  const channelsMap = useIMChannelStore((s) => s.channels);
  const imChannels = useMemo(() => Object.values(channelsMap), [channelsMap]);

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
  const [outputChannelId, setOutputChannelId] = useState('');
  const [outputChatIds, setOutputChatIds] = useState('');
  const [outputUserIds, setOutputUserIds] = useState('');

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
      setOutputChannelId(editingTask.outputChannelId ?? '');
      setOutputChatIds(editingTask.outputChatIds ?? '');
      setOutputUserIds(editingTask.outputUserIds ?? '');
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
      setOutputChannelId('');
      setOutputChatIds('');
      setOutputUserIds('');
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

    if (editingTaskId) {
      updateTask(editingTaskId, {
        name: name.trim(),
        description: description.trim() || undefined,
        prompt: prompt.trim(),
        schedule,
        skillName: skillName || undefined,
        workspacePath: workspacePath || undefined,
        outputChannelId: outputChannelId || undefined,
        outputChatIds: outputChannelId && outputChatIds.trim() ? outputChatIds.trim() : undefined,
        outputUserIds: outputChannelId && outputUserIds.trim() ? outputUserIds.trim() : undefined,
      });
    } else {
      createTask({
        name: name.trim(),
        description: description.trim() || undefined,
        prompt: prompt.trim(),
        schedule,
        skillName: skillName || undefined,
        workspacePath: workspacePath || undefined,
        outputChannelId: outputChannelId || undefined,
        outputChatIds: outputChannelId && outputChatIds.trim() ? outputChatIds.trim() : undefined,
        outputUserIds: outputChannelId && outputUserIds.trim() ? outputUserIds.trim() : undefined,
      });
    }

    closeEditor();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={closeEditor}>
      <div className="bg-white rounded-2xl shadow-xl w-[480px] max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100 shrink-0">
          <h2 className="text-[16px] font-semibold text-[#29261b]">
            {editingTaskId ? t.schedule.editTask : t.schedule.newTask}
          </h2>
          <button
            onClick={closeEditor}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form */}
        <div className="px-6 py-4 space-y-4 overflow-auto flex-1">
          {/* Task name */}
          <div>
            <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
              {t.schedule.taskName}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.schedule.taskNamePlaceholder}
              className="w-full h-10 px-3 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]"
            />
          </div>

          {/* Task description */}
          <div>
            <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
              {t.schedule.description}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t.schedule.descriptionPlaceholder}
              rows={2}
              className="w-full px-3 py-2 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] resize-none"
            />
          </div>

          {/* Task prompt */}
          <div>
            <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
              {t.schedule.taskPrompt}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t.schedule.taskPromptPlaceholder}
              rows={4}
              className="w-full px-3 py-2 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] resize-none"
            />
          </div>

          {/* Frequency selector */}
          <div>
            <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
              {t.schedule.frequency}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {FREQUENCIES.map((freq) => (
                <button
                  key={freq}
                  onClick={() => setFrequency(freq)}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors',
                    frequency === freq
                      ? 'bg-[#d97757] text-white'
                      : 'bg-[#f5f3ee] text-[#3d3929] hover:bg-[#e8e5de]'
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
              <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
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
                    <span className="text-[#656358]">:</span>
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
              <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
                {t.schedule.dayOfWeek}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {dayLabels.map((label, idx) => (
                  <button
                    key={idx}
                    onClick={() => setDayOfWeek(idx)}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors',
                      dayOfWeek === idx
                        ? 'bg-[#d97757] text-white'
                        : 'bg-[#f5f3ee] text-[#3d3929] hover:bg-[#e8e5de]'
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
              <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
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

          {/* Workspace path */}
          <div>
            <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
              {t.schedule.workspacePath}
            </label>
            <input
              type="text"
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              placeholder={t.schedule.workspacePathPlaceholder}
              className="w-full h-10 px-3 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]"
            />
          </div>

          {/* Output to IM channel */}
          <div>
            <label className="block text-[13px] font-medium text-[#29261b] mb-1.5">
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
            <p className="text-[11px] text-[#9a9689] mt-1">{t.schedule.outputChannelHint}</p>
            {outputChannelId && (
              <div className="space-y-2 mt-2">
                <div>
                  <label className="block text-[12px] text-[#656358] mb-1">{t.schedule.outputToGroup}</label>
                  <input
                    type="text"
                    value={outputChatIds}
                    onChange={(e) => setOutputChatIds(e.target.value)}
                    placeholder={t.schedule.outputChatIdPlaceholder}
                    className="w-full h-9 px-3 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]"
                  />
                </div>
                <div>
                  <label className="block text-[12px] text-[#656358] mb-1">{t.schedule.outputToDM}</label>
                  <input
                    type="text"
                    value={outputUserIds}
                    onChange={(e) => setOutputUserIds(e.target.value)}
                    placeholder={t.schedule.outputUserIdPlaceholder}
                    className="w-full h-9 px-3 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-neutral-100 shrink-0">
          <button
            onClick={closeEditor}
            className="px-4 py-2 rounded-lg text-[13px] text-[#3d3929] hover:bg-[#f5f3ee] transition-colors"
          >
            {t.common.cancel}
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || !prompt.trim()}
            className={cn(
              'px-4 py-2 rounded-lg text-[13px] font-medium transition-colors',
              name.trim() && prompt.trim()
                ? 'bg-[#d97757] text-white hover:bg-[#c8664a]'
                : 'bg-[#e8e4dd] text-[#656358] cursor-not-allowed'
            )}
          >
            {t.common.save}
          </button>
        </div>
      </div>
    </div>
  );
}
