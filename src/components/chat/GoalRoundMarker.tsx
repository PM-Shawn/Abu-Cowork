import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import type { Message } from '@/types';

/**
 * Passive divider for the opening message of an automatic goal round.
 *
 * That message is an internal (`isSystem`) user row — the round prompt the
 * driver sent, not something the user typed — so it renders as a marker
 * instead of a user bubble, the same way CompactDivider stands in for a
 * compact boundary.
 *
 * The user bubble it replaces is where a stopped or failed run is normally
 * shown, so the marker carries that state itself: a round the user paused
 * mid-way would otherwise leave a bare marker with nothing under it.
 */
export default function GoalRoundMarker({ message }: { message: Message }) {
  const { t, locale } = useI18n();
  if (!message.goalRound) return null;
  const time = new Date(message.timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const outcome = message.runState === 'interrupted'
    ? { text: t.chat.goal.roundInterrupted, tone: 'text-label-tertiary' }
    : message.runState === 'failed' || message.runState === 'connection-failed'
      ? { text: t.chat.goal.roundFailed, tone: 'text-danger' }
      : null;

  return (
    <div className="my-3 flex items-center gap-2 px-2 text-label-tertiary" data-testid="goal-round-marker">
      <div className="h-px flex-1 bg-separator" />
      <Icon icon={AppIcons.goal} size="sm" />
      <span className="select-none text-ui-sm">{t.chat.goal.roundMarker}</span>
      <span className="select-none text-ui-sm tabular-nums">{time}</span>
      {outcome && (
        <span className={cn('select-none text-ui-sm', outcome.tone)} data-testid="goal-round-outcome">
          · {outcome.text}
        </span>
      )}
      <div className="h-px flex-1 bg-separator" />
    </div>
  );
}
