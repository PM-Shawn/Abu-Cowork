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
import { ArrowLeft, Clock, Zap } from 'lucide-react';
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
    <button
      onClick={handleClick}
      className="shrink-0 flex items-center gap-2 px-6 md:px-10 py-1.5 bg-white/60 border-b border-[var(--abu-border)] text-[13px] w-full text-left hover:bg-[var(--abu-bg-hover)] transition-colors"
    >
      <ArrowLeft className="h-3.5 w-3.5 text-[var(--abu-text-tertiary)]" />
      {isSchedule ? (
        <Clock className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
      ) : (
        <Zap className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
      )}
      <span className="font-medium text-[var(--abu-text-primary)] truncate">{name}</span>
      <span className="text-[var(--abu-text-placeholder)]">·</span>
      <span className="text-[var(--abu-text-tertiary)] shrink-0">
        {isSchedule ? t.chat.fromScheduledTask : t.chat.fromTrigger}
      </span>
    </button>
  );
}
