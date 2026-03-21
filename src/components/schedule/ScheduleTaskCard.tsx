import { useScheduleStore } from '@/stores/scheduleStore';
import { useI18n } from '@/i18n';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
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

export default function ScheduleTaskCard({ task }: Props) {
  const { t } = useI18n();
  const { pauseTask, resumeTask, setSelectedTaskId } = useScheduleStore();

  const isPaused = task.status === 'paused';
  const scheduleDesc = getScheduleDescription(task, t);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isPaused) {
      resumeTask(task.id);
    } else {
      pauseTask(task.id);
    }
  };

  const handleCardClick = () => {
    setSelectedTaskId(task.id);
  };

  return (
    <div
      onClick={handleCardClick}
      className="bg-[var(--abu-bg-muted)] rounded-xl border border-[var(--abu-border)] px-4 py-3 cursor-pointer hover:border-[var(--abu-border-hover)] transition-all group"
    >
      <div className="flex items-center gap-3">
        {/* Left: status dot + info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={cn(
                'w-2 h-2 rounded-full shrink-0',
                isPaused ? 'bg-neutral-300' : 'bg-green-500'
              )}
            />
            <span className="text-[14px] font-medium text-[var(--abu-text-primary)] truncate">
              {task.name}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[12px] text-[var(--abu-text-tertiary)] pl-4">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {scheduleDesc}
            </span>
            {task.lastRunAt && (
              <span>
                {t.schedule.lastRun}: {formatTimeAgo(task.lastRunAt, t.schedule.ago)}
              </span>
            )}
          </div>
        </div>

        {/* Right: toggle switch */}
        <button
          onClick={handleToggle}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
            isPaused ? 'bg-neutral-200' : 'bg-green-500'
          )}
        >
          <span
            className={cn(
              'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
              isPaused ? 'translate-x-[3px]' : 'translate-x-[19px]'
            )}
          />
        </button>
      </div>
    </div>
  );
}
