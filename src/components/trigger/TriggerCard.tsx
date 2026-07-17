import { useTriggerStore } from '@/stores/triggerStore';
import { useI18n } from '@/i18n';
import { Zap, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Trigger } from '@/types/trigger';
import type { TranslationDict } from '@/i18n/types';

function formatTimeAgo(timestamp: number, t: TranslationDict['trigger']): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return t.timeJustNow;
  if (minutes < 60) return t.timeMinutes.replace('{n}', String(minutes));
  if (hours < 24) return t.timeHours.replace('{n}', String(hours));
  return t.timeDays.replace('{n}', String(days));
}

function getFilterDescription(trigger: Trigger, t: TranslationDict['trigger']): string {
  switch (trigger.filter.type) {
    case 'keyword':
      return `${t.filterKeyword}: ${(trigger.filter.keywords ?? []).join(', ')}`;
    case 'regex':
      return `${t.filterRegex}: ${trigger.filter.pattern ?? ''}`;
    case 'always':
    default:
      return t.filterAlways;
  }
}

interface Props {
  trigger: Trigger;
}

export default function TriggerCard({ trigger }: Props) {
  const { t } = useI18n();
  const { setTriggerStatus, setSelectedTriggerId } = useTriggerStore();

  const isPaused = trigger.status === 'paused';

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setTriggerStatus(trigger.id, isPaused ? 'active' : 'paused');
  };

  const handleCardClick = () => {
    setSelectedTriggerId(trigger.id);
  };

  return (
    <div
      onClick={handleCardClick}
      className={cn(
        'group flex flex-col gap-2 w-full h-[120px] overflow-hidden rounded-xl p-4 cursor-pointer',
        'bg-[var(--abu-bg-subtle)] border border-[var(--abu-border)]',
        'hover:border-[var(--abu-clay)] hover:shadow-sm transition-all duration-150'
      )}
    >
      {/* Row 1: event avatar + name + on/off toggle (mirrors the toolbox card shell) */}
      <div className="flex items-center gap-3 w-full shrink-0">
        <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-[var(--abu-bg-active)] shrink-0">
          <Zap className="h-5 w-5 text-[var(--abu-text-muted)]" />
        </div>
        <span className="flex-1 min-w-0 text-sm font-semibold leading-snug truncate text-[var(--abu-text-primary)]">
          {trigger.name}
        </span>
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

      {/* Row 2: filter + output + last-triggered meta */}
      <div className="flex-1 min-h-0 flex flex-col gap-0.5 text-[12px] text-[var(--abu-text-tertiary)]">
        <span className="truncate">{getFilterDescription(trigger, t.trigger)}</span>
        <div className="flex items-center gap-3 min-w-0">
          {trigger.output?.enabled && (
            <span className="flex items-center gap-0.5 text-[var(--abu-clay)] shrink-0">
              <Send className="h-3 w-3" />
              {t.trigger.outputEnabled}
            </span>
          )}
          {trigger.lastTriggeredAt && (
            <span className="truncate">
              {t.trigger.lastTriggered}: {formatTimeAgo(trigger.lastTriggeredAt, t.trigger)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
