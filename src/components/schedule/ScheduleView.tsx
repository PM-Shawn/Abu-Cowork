import { useListDetailFocus } from '@/components/automation/useListDetailFocus';
import { EmptyState } from '@/components/ds/empty-state';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { ScrollArea } from '@/components/ds/scroll-area';
import ToolGrid from '@/components/toolbox/ToolGrid';
import { useI18n } from '@/i18n';
import { useScheduleStore } from '@/stores/scheduleStore';
import type { ScheduledTask } from '@/types/schedule';
import ScheduleEditor from './ScheduleEditor';
import ScheduleTaskCard from './ScheduleTaskCard';
import ScheduleTaskDetail from './ScheduleTaskDetail';

const newestFirst = (tasks: Record<string, ScheduledTask>) => Object.values(tasks).sort((a, b) => b.createdAt - a.createdAt);
// Where a task sits in the list as the store has it now.
const placeOf = (id: string) => newestFirst(useScheduleStore.getState().tasks).findIndex((task) => task.id === id);

export default function ScheduleView() {
  const { t } = useI18n();
  const tasks = useScheduleStore((s) => s.tasks);
  const selectedTaskId = useScheduleStore((s) => s.selectedTaskId);

  const sortedTasks = newestFirst(tasks);
  // The task whose page is in view; the list is in view when there is none.
  const detailId = selectedTaskId && tasks[selectedTaskId] ? selectedTaskId : null;

  // The list and a task's page replace each other under the keyboard; the focus follows them.
  const { root, afterLayer, editorCloseAutoFocus } = useListDetailFocus(detailId, placeOf);

  return (
    <div ref={root} className="flex h-full flex-col">
      {detailId ? <ScheduleTaskDetail onQuestionClosed={afterLayer} /> : (
        <>
          {/* When tasks run, in the same centered column as the tabs above and the list below. */}
          <div className="px-8 pt-4 pb-2">
            <div className="mx-auto max-w-5xl">
              <InlineMessage tone="info">{t.schedule.onlyRunWhileAwake}</InlineMessage>
            </div>
          </div>

          {sortedTasks.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState icon={AppIcons.clock} title={t.schedule.noTasks} description={t.schedule.noTasksHint} />
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-8 py-4">
                <div className="mx-auto max-w-5xl">
                  <ToolGrid>
                    {sortedTasks.map((task) => (
                      <ScheduleTaskCard key={task.id} task={task} />
                    ))}
                  </ToolGrid>
                </div>
              </div>
            </ScrollArea>
          )}
        </>
      )}

      {/* One editor for the list and for a task's page: it stays mounted while they replace each other. */}
      <ScheduleEditor onCloseAutoFocus={editorCloseAutoFocus} />
    </div>
  );
}
