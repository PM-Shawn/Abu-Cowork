import { Target } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
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
    ? { text: t.chat.goal.roundInterrupted, tone: 'text-[var(--abu-text-muted)]' }
    : message.runState === 'failed' || message.runState === 'connection-failed'
      ? { text: t.chat.goal.roundFailed, tone: 'text-[var(--abu-danger)]' }
      : null;

  return (
    <div className="flex items-center gap-2 my-3 px-2 text-[var(--abu-text-tertiary)]" data-testid="goal-round-marker">
      <div className="flex-1 h-px bg-[var(--abu-border)]" />
      <Target className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="text-minor select-none">{t.chat.goal.roundMarker}</span>
      <span className="text-minor select-none text-[var(--abu-text-muted)]">{time}</span>
      {outcome && (
        <span className={cn('text-minor select-none', outcome.tone)} data-testid="goal-round-outcome">
          · {outcome.text}
        </span>
      )}
      <div className="flex-1 h-px bg-[var(--abu-border)]" />
    </div>
  );
}
