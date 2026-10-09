import { memo } from 'react';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Switch } from '@/components/ds/switch';
import { Tag } from '@/components/ds/tag';
import ToolCard, { type ToolItem } from '@/components/toolbox/ToolCard';
import { cardProps } from '@/components/toolbox/cardFocus';
import { useI18n } from '@/i18n';
import { useTriggerStore } from '@/stores/triggerStore';
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

/**
 * One event listener in the list: the shared card with what the listener matches, whether it
 * pushes its result on, when it last fired, and the switch that pauses or resumes it. The card
 * opens the listener's page.
 */
const TriggerCard = memo(function TriggerCard({ trigger }: Props) {
  const { t } = useI18n();
  const isPaused = trigger.status === 'paused';

  const item: ToolItem = {
    id: trigger.id,
    name: trigger.name,
    avatar: <Icon icon={AppIcons.trigger} size="lg" className="text-label-tertiary" />,
    // Two lines at most, inside the card's fixed height: a card with a second line is as tall
    // as one without.
    description: (
      <>
        <span className="block truncate">{getFilterDescription(trigger, t.trigger)}</span>
        {(trigger.output?.enabled || trigger.lastTriggeredAt) && (
          <span className="flex min-w-0 items-center gap-2">
            {trigger.output?.enabled && (
              <span className="flex shrink-0">
                <Tag><Icon icon={AppIcons.deliver} size="sm" />{t.trigger.outputEnabled}</Tag>
              </span>
            )}
            {trigger.lastTriggeredAt && (
              <span className="min-w-0 truncate">
                {t.trigger.lastTriggered}: {formatTimeAgo(trigger.lastTriggeredAt, t.trigger)}
              </span>
            )}
          </span>
        )}
      </>
    ),
    toggle: (
      // A press on the switch pauses or resumes; it does not also open the listener.
      <span onClick={(event) => event.stopPropagation()}>
        <Switch
          checked={!isPaused}
          onCheckedChange={() => useTriggerStore.getState().setTriggerStatus(trigger.id, isPaused ? 'active' : 'paused')}
          aria-label={trigger.name}
        />
      </span>
    ),
    testId: `trigger-card-${trigger.id}`,
  };

  return (
    // The wrapper is how the list finds this card again when the listener's page is left.
    <div {...cardProps('automation', trigger.id)}>
      <ToolCard item={item} onClick={() => useTriggerStore.getState().setSelectedTriggerId(trigger.id)} />
    </div>
  );
});

export default TriggerCard;
