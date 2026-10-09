import { memo } from 'react';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Switch } from '@/components/ds/switch';
import ToolCard, { type ToolItem } from '@/components/toolbox/ToolCard';
import { cardProps } from '@/components/toolbox/cardFocus';
import { useI18n } from '@/i18n';
import { useScheduleStore } from '@/stores/scheduleStore';
import type { ScheduledTask, ScheduleFrequency } from '@/types/schedule';

function formatTimeAgo(timestamp: number, agoTemplate: string): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  let time: string;
  if (minutes < 1) time = '<1m';
  else if (minutes < 60) time = `${minutes}m`;
  else if (hours < 24) time = `${hours}h`;
  else time = `${days}d`;

  return agoTemplate.replace('{time}', time);
}

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

function getScheduleDescription(task: ScheduledTask, t: ReturnType<typeof useI18n>['t']): string {
  const freq = getFrequencyLabel(task.schedule.frequency, t);
  const time = task.schedule.time;
  if (!time) return freq;

  if (task.schedule.frequency === 'hourly') {
    return `${freq} :${time.minute.toString().padStart(2, '0')}`;
  }

  const timeStr = `${time.hour.toString().padStart(2, '0')}:${time.minute.toString().padStart(2, '0')}`;

  if (task.schedule.frequency === 'weekly') {
    const days = [
      t.schedule.sunday, t.schedule.monday, t.schedule.tuesday,
      t.schedule.wednesday, t.schedule.thursday, t.schedule.friday,
      t.schedule.saturday,
    ];
    const day = days[task.schedule.dayOfWeek ?? 1];
    return `${freq} ${day} ${timeStr}`;
  }

  return `${freq} ${timeStr}`;
}

interface Props {
  task: ScheduledTask;
}

/**
 * One scheduled task in the list: the shared card with a clock, when the task runs, when it last
 * ran, and the switch that pauses or resumes it. The card opens the task's page.
 */
const ScheduleTaskCard = memo(function ScheduleTaskCard({ task }: Props) {
  const { t } = useI18n();
  const isPaused = task.status === 'paused';

  const item: ToolItem = {
    id: task.id,
    name: task.name,
    avatar: <Icon icon={AppIcons.clock} size="lg" className="text-label-tertiary" />,
    // Two lines at most, inside the card's fixed height: a card that has run is as tall as one
    // that has not.
    description: (
      <>
        <span className="block truncate">{getScheduleDescription(task, t)}</span>
        {task.lastRunAt && (
          <span className="block truncate">
            {t.schedule.lastRun}: {formatTimeAgo(task.lastRunAt, t.schedule.ago)}
          </span>
        )}
      </>
    ),
    toggle: (
      // A press on the switch pauses or resumes; it does not also open the task.
      <span onClick={(event) => event.stopPropagation()}>
        <Switch
          checked={!isPaused}
          onCheckedChange={() => {
            const { pauseTask, resumeTask } = useScheduleStore.getState();
            if (isPaused) resumeTask(task.id);
            else pauseTask(task.id);
          }}
          aria-label={task.name}
        />
      </span>
    ),
    testId: `schedule-card-${task.id}`,
  };

  return (
    // The wrapper is how the list finds this card again when the task's page is left.
    <div {...cardProps('automation', task.id)}>
      <ToolCard item={item} onClick={() => useScheduleStore.getState().setSelectedTaskId(task.id)} />
    </div>
  );
});

export default ScheduleTaskCard;
