import { useScheduleStore } from '@/stores/scheduleStore';
import { useI18n } from '@/i18n';
import { Clock, Info } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import ScheduleTaskCard from './ScheduleTaskCard';
import ScheduleTaskDetail from './ScheduleTaskDetail';
import ScheduleEditor from './ScheduleEditor';
import ToolGrid from '@/components/toolbox/ToolGrid';

export default function ScheduleView() {
  const { t } = useI18n();
  const { tasks, selectedTaskId } = useScheduleStore();

  const sortedTasks = Object.values(tasks).sort((a, b) => b.createdAt - a.createdAt);

  // Show detail page if a task is selected
  if (selectedTaskId && tasks[selectedTaskId]) {
    return (
      <div className="flex flex-col h-full bg-[var(--abu-bg-base)]">
        <ScheduleTaskDetail />
        <ScheduleEditor />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[var(--abu-bg-base)]">
      {/* Run-condition hint — the create actions now live in AutomationView's
          shared content-area header. Inset with px-8 + max-w-5xl so it lines
          up with the list below (and with the header's tabs/actions above). */}
      <div className="px-8 pt-4 pb-2">
        <div className="max-w-5xl mx-auto flex items-center gap-1.5 text-[12px] text-[var(--abu-text-tertiary)] min-w-0">
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{t.schedule.onlyRunWhileAwake}</span>
        </div>
      </div>

      {/* Task list or empty state */}
      {sortedTasks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
          <div className="w-16 h-16 rounded-full bg-[var(--abu-bg-active)] flex items-center justify-center mb-4">
            <Clock className="h-7 w-7 text-[var(--abu-text-muted)]" />
          </div>
          <p className="text-[15px] text-[var(--abu-text-primary)] font-medium mb-1.5">
            {t.schedule.noTasks}
          </p>
          <p className="text-[13px] text-[var(--abu-text-tertiary)]">
            {t.schedule.noTasksHint}
          </p>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="px-8 py-4">
            <div className="max-w-5xl mx-auto">
              <ToolGrid>
                {sortedTasks.map((task) => (
                  <ScheduleTaskCard key={task.id} task={task} />
                ))}
              </ToolGrid>
            </div>
          </div>
        </ScrollArea>
      )}

      {/* Editor modal */}
      <ScheduleEditor />
    </div>
  );
}
