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
      className="bg-white rounded-xl border border-[#e8e4dd] px-4 py-3 cursor-pointer hover:border-[#d4d0c8] hover:shadow-sm transition-all group"
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
            <span className="text-[14px] font-medium text-[#29261b] truncate">
              {trigger.name}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[12px] text-[#656358] pl-4">
            <span className="flex items-center gap-1">
              <Zap className="h-3 w-3" />
              {getFilterDescription(trigger, t.trigger)}
            </span>
            {trigger.output?.enabled && (
              <span className="flex items-center gap-0.5 text-[#d97757]">
                <Send className="h-3 w-3" />
                {t.trigger.outputEnabled}
              </span>
            )}
            {trigger.lastTriggeredAt && (
              <span>
                {t.trigger.lastTriggered}: {formatTimeAgo(trigger.lastTriggeredAt, t.trigger)}
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
