import { useLayoutEffect, useRef } from 'react';
import { EmptyState } from '@/components/ds/empty-state';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { lastInputWasPointer } from '@/components/ds/input-modality';
import { ScrollArea } from '@/components/ds/scroll-area';
import ToolGrid from '@/components/toolbox/ToolGrid';
import { cardOrNeighbour, focusByTestId, focusIsOnWindow, type CardPlace } from '@/components/toolbox/cardFocus';
import { useI18n } from '@/i18n';
import { useScheduleStore } from '@/stores/scheduleStore';
import type { ScheduledTask } from '@/types/schedule';
import ScheduleEditor from './ScheduleEditor';
import ScheduleTaskCard from './ScheduleTaskCard';
import ScheduleTaskDetail from './ScheduleTaskDetail';

const newestFirst = (tasks: Record<string, ScheduledTask>) => Object.values(tasks).sort((a, b) => b.createdAt - a.createdAt);

export default function ScheduleView() {
  const { t } = useI18n();
  const tasks = useScheduleStore((s) => s.tasks);
  const selectedTaskId = useScheduleStore((s) => s.selectedTaskId);

  const sortedTasks = newestFirst(tasks);
  // The task whose page is in view; the list is in view when there is none.
  const detailId = selectedTaskId && tasks[selectedTaskId] ? selectedTaskId : null;

  // The list and a task's page replace each other under the keyboard. When the control that had
  // the focus went away with its page, the focus goes to the new page's way back (on the way in),
  // or to the card of the task just left (on the way back): once that task is deleted, to the
  // card that took its place, else the one before it, else the page's create button. Focus that
  // sits elsewhere stays.
  const root = useRef<HTMLDivElement>(null);
  // The task whose page was in view at the last render, with its place in the list; `undefined`
  // until the first render, which moves no focus.
  const shown = useRef<CardPlace | null | undefined>(undefined);
  useLayoutEffect(() => {
    const left = shown.current;
    shown.current = detailId
      ? { id: detailId, index: newestFirst(useScheduleStore.getState().tasks).findIndex((task) => task.id === detailId) }
      : null;
    if (left === undefined || (left?.id ?? null) === detailId || !root.current || !focusIsOnWindow()) return;
    const options = lastInputWasPointer() ? { focusVisible: false } : undefined;
    if (detailId) {
      root.current.querySelector<HTMLElement>('[data-automation-back]')?.focus(options);
      return;
    }
    const card = left ? cardOrNeighbour(root.current, 'automation', left.id, left.index) : null;
    if (card) card.focus(options);
    else focusByTestId('automation-create');
  }, [detailId]);

  return (
    <div ref={root} className="flex h-full flex-col">
      {detailId ? <ScheduleTaskDetail /> : (
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
      <ScheduleEditor />
    </div>
  );
}
