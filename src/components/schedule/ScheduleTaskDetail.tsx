import { useState } from 'react';
import { Button, IconButton } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { ScrollArea } from '@/components/ds/scroll-area';
import { Tag } from '@/components/ds/tag';
import { schedulerEngine } from '@/core/scheduler/scheduler';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ScheduleFrequency } from '@/types/schedule';
import ScheduleRunHistory from './ScheduleRunHistory';

function getFrequencyLabel(
  freq: ScheduleFrequency,
  t: ReturnType<typeof useI18n>['t']
): string {
  const map: Record<ScheduleFrequency, string> = {
    hourly: t.schedule.frequencyHourly,
    daily: t.schedule.frequencyDaily,
    weekly: t.schedule.frequencyWeekly,
    weekdays: t.schedule.frequencyWeekdays,
    manual: t.schedule.frequencyManual,
  };
  return map[freq];
}

// A flat box for one group of facts about the task.
const SECTION = 'rounded-panel border border-separator p-4';
const SECTION_TITLE = 'text-ui-sm text-label-tertiary';

export default function ScheduleTaskDetail() {
  const { t } = useI18n();
  const confirm = useConfirm();
  const {
    tasks,
    selectedTaskId,
    setSelectedTaskId,
    pauseTask,
    resumeTask,
    openEditor,
  } = useScheduleStore();

  const openSystemSettings = useSettingsStore((s) => s.openSystemSettings);

  const [isRunning, setIsRunning] = useState(false);

  const task = selectedTaskId ? tasks[selectedTaskId] : null;

  if (!task) return null;

  const isPaused = task.status === 'paused';

  const handleRunNow = async () => {
    setIsRunning(true);
    try {
      await schedulerEngine.runNow(task.id);
    } finally {
      setIsRunning(false);
    }
  };

  // Deleting cannot be taken back, so it is asked first, naming the task. The answer acts on
  // the store as it is at that moment: nothing is deleted once the task has left it.
  const handleDelete = async () => {
    const id = task.id;
    const confirmed = await confirm({
      title: t.schedule.delete,
      message: `${t.schedule.deleteConfirm}\n${task.name}`,
      confirmLabel: t.common.confirm,
      tone: 'danger',
    });
    if (!confirmed) return;
    const store = useScheduleStore.getState();
    if (!store.tasks[id]) return;
    store.deleteTask(id);
  };

  const handleEdit = () => {
    openEditor(task.id);
  };

  const handleBack = () => {
    setSelectedTaskId(null);
  };

  // Build schedule description
  const freq = getFrequencyLabel(task.schedule.frequency, t);
  const time = task.schedule.time;
  let scheduleDesc = freq;
  if (time) {
    if (task.schedule.frequency === 'hourly') {
      scheduleDesc = `${freq} :${time.minute.toString().padStart(2, '0')}`;
    } else {
      const timeStr = `${time.hour.toString().padStart(2, '0')}:${time.minute.toString().padStart(2, '0')}`;
      if (task.schedule.frequency === 'weekly') {
        const days = [
          t.schedule.sunday, t.schedule.monday, t.schedule.tuesday,
          t.schedule.wednesday, t.schedule.thursday, t.schedule.friday,
          t.schedule.saturday,
        ];
        const day = days[task.schedule.dayOfWeek ?? 1];
        scheduleDesc = `${freq} ${day} ${timeStr}`;
      } else {
        scheduleDesc = `${freq} ${timeStr}`;
      }
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: the way back, the task's name, edit. */}
      <div className="flex items-center gap-3 border-b border-separator px-6 py-4">
        <IconButton icon={AppIcons.back} label={t.schedule.backToList} data-automation-back onClick={handleBack} />
        <h1 className="min-w-0 flex-1 truncate text-title text-label">
          {task.name}
        </h1>
        <Button variant="secondary" size="sm" icon={AppIcons.rename} onClick={handleEdit}>
          {t.schedule.edit}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 px-6 py-5">
          <div data-schedule-section className={cn(SECTION, 'space-y-3')}>
            <div className="flex items-center justify-between">
              <span className={SECTION_TITLE}>{t.schedule.status}</span>
              {isPaused
                ? <Tag>{t.schedule.statusPaused}</Tag>
                : <Tag tone="success">{t.schedule.statusActive}</Tag>}
            </div>

            <div className="flex items-center justify-between">
              <span className={SECTION_TITLE}>{t.schedule.schedule}</span>
              <span className="flex items-center gap-2 text-ui text-label">
                <Icon icon={AppIcons.clock} size="sm" className="text-label-tertiary" />
                {scheduleDesc}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className={SECTION_TITLE}>{t.schedule.runHistory}</span>
              <span className="text-ui text-label">
                {format(t.schedule.totalRuns, { count: task.totalRuns })}
              </span>
            </div>
          </div>

          {/* Browser authorization (U5 authorization visibility).
              A scheduled task runs unattended, so the browser gate lets it act
              only on the sites the user granted — a standing authorization
              that was, until now, visible nowhere near the task acting under
              it. Shown here with the entry point to change it; the verdicts
              themselves stay owned by Settings (one place to revoke, not two
              that can disagree). */}
          <div data-schedule-section className={SECTION}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className={SECTION_TITLE}>
                  {t.schedule.browserAuthTitle}
                </div>
                <p className="mt-1 text-ui-sm text-label-secondary">
                  {t.settings.browserPermissionsSharedDesc}
                </p>
              </div>
              <Button variant="secondary" size="sm" icon={AppIcons.capability} onClick={() => openSystemSettings('capabilities')}>
                {t.schedule.browserAuthManage}
              </Button>
            </div>
          </div>

          {task.description && (
            <div data-schedule-section className={SECTION}>
              <div className={cn(SECTION_TITLE, 'mb-2')}>{t.schedule.description}</div>
              <p className="whitespace-pre-wrap text-ui text-label">
                {task.description}
              </p>
            </div>
          )}

          <div data-schedule-section className={SECTION}>
            <div className={cn(SECTION_TITLE, 'mb-2')}>{t.schedule.prompt}</div>
            <p className="rounded-control bg-code p-3 font-code text-ui-sm text-label whitespace-pre-wrap break-words">
              {task.prompt}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* Busy while the run it started goes on: the words say so and the focus stays here. */}
            <Button variant="primary" icon={AppIcons.continue} busy={isRunning} onClick={() => { void handleRunNow(); }}>
              {isRunning ? t.schedule.running : t.schedule.runNow}
            </Button>

            <Button
              variant="secondary"
              icon={isPaused ? AppIcons.continue : AppIcons.pause}
              onClick={() => (isPaused ? resumeTask(task.id) : pauseTask(task.id))}
            >
              {isPaused ? t.schedule.resume : t.schedule.pause}
            </Button>

            <div className="flex-1" />

            <Button variant="danger" icon={AppIcons.delete} onClick={() => { void handleDelete(); }}>
              {t.schedule.delete}
            </Button>
          </div>

          <div data-schedule-section className="overflow-hidden rounded-panel border border-separator">
            <div className="border-b border-separator px-4 py-3">
              <h3 className="text-ui font-medium text-label">
                {t.schedule.runHistory}
              </h3>
            </div>
            <ScheduleRunHistory runs={task.runs} />
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
