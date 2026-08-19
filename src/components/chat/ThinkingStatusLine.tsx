import { cn } from '@/lib/utils';
import abuAvatar from '@/assets/abu-avatar.png';

// Single source of truth for the "thinking…" status typography shared by the
// three rows that hand off to each other during a turn's lifecycle:
//   1. ChatView's VirtuosoTypingFooter (before the assistant group exists)
//   2. MessageGroup's in-group placeholder (group exists, no content yet)
//   3. TaskBlock's active header (first thinking/tool step has arrived)
// Because each state swap REPLACES the previous row in the same visual spot,
// the label must keep the exact same size and baseline across all three — any
// divergence reads as the text hopping lines ("错行"). Keeping the markup here
// means a typography tweak propagates to every call site automatically.

/** The three bouncing dots. `md` is the standalone status-line size; `sm` is
 *  the compact inline variant the TaskBlock active header appends to its
 *  summary text. */
export function TypingDots({
  size = 'md',
  className,
}: {
  size?: 'md' | 'sm';
  className?: string;
}) {
  const dot =
    size === 'md'
      ? 'typing-dot w-1.5 h-1.5 rounded-full bg-[var(--abu-clay-60)]'
      : 'typing-dot w-[3px] h-[3px] rounded-full bg-[var(--abu-clay)]';
  return (
    <span
      className={cn(
        'inline-flex items-center',
        size === 'md' ? 'gap-1.5' : 'gap-[3px]',
        className,
      )}
    >
      <span className={dot} />
      <span className={dot} />
      <span className={dot} />
    </span>
  );
}

/** One status row: tertiary text-body label + bouncing dots. text-body (not
 *  text-minor) and no vertical padding of its own — successors (TaskBlock
 *  active header, "已处理 Xs" fold header) are text-body buttons with mb-2,
 *  so callers that need the mb-2 pass it via className. */
export function ThinkingStatusLine({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <span className="text-body text-[var(--abu-text-tertiary)]">{label}</span>
      <TypingDots />
    </div>
  );
}

/** The 28px assistant-row avatar. Shared by MessageGroup's group row and the
 *  typing footer that mimics it — identical markup keeps the label's
 *  horizontal offset (avatar width + gap) and top alignment (mt-0.5) in sync
 *  across the footer → group hand-off. */
export function AssistantRowAvatar() {
  return (
    <div className="shrink-0 mt-0.5">
      <div className="w-7 h-7 rounded-full overflow-hidden">
        <img src={abuAvatar} alt="Abu" className="w-full h-full object-cover" />
      </div>
    </div>
  );
}
