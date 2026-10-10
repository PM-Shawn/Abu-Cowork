/**
 * SourceInfoBar — Shows a navigation breadcrumb for conversations
 * created by scheduled tasks or triggers.
 *
 * Clicking navigates back to the source task/trigger detail page.
 */

import { useScheduleStore } from '@/stores/scheduleStore';
import { useTriggerStore } from '@/stores/triggerStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import type { Conversation } from '@/types';

interface SourceInfoBarProps {
  conversation: Conversation;
}

export default function SourceInfoBar({ conversation }: SourceInfoBarProps) {
  const { t } = useI18n();
  const openAutomation = useSettingsStore((s) => s.openAutomation);

  const scheduledTaskId = conversation.scheduledTaskId;
  const triggerId = conversation.triggerId;

  const taskName = useScheduleStore((s) =>
    scheduledTaskId ? s.tasks[scheduledTaskId]?.name : undefined
  );
  const triggerName = useTriggerStore((s) =>
    triggerId ? s.triggers[triggerId]?.name : undefined
  );

  // Only show for scheduled task or trigger conversations
  if (!scheduledTaskId && !triggerId) return null;

  const name = taskName ?? triggerName;
  // If the source task/trigger was deleted, don't show the bar
  if (!name) return null;

  const isSchedule = !!scheduledTaskId;

  const handleClick = () => {
    if (isSchedule) {
      useScheduleStore.getState().setSelectedTaskId(scheduledTaskId!);
      openAutomation('schedule');
    } else {
      useTriggerStore.getState().setSelectedTriggerId(triggerId!);
      openAutomation('trigger');
    }
  };

  return (
    <div className="flex shrink-0 items-center border-b border-separator px-6 py-1 md:px-10">
      <Button variant="plain" size="sm" icon={AppIcons.back} onClick={handleClick} className="max-w-full">
        <Icon icon={isSchedule ? AppIcons.clock : AppIcons.trigger} size="sm" className="text-label-secondary" />
        <span className="min-w-0 truncate">{name}</span>
        <span className="text-label-placeholder">·</span>
        <span className="shrink-0 font-normal text-label-tertiary">
          {isSchedule ? t.chat.fromScheduledTask : t.chat.fromTrigger}
        </span>
      </Button>
    </div>
  );
}
