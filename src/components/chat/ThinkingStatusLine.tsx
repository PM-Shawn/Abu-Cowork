import type React from 'react';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ds/spinner';
import abuAvatar from '@/assets/abu-avatar.png';

// Single source of truth for the "thinking…" status typography shared by the
// rows that hand off to each other during a turn's lifecycle:
//   1. ChatView's VirtuosoTypingFooter (before the assistant group exists)
//   2. MessageGroup's in-group placeholder (group exists, no content yet)
//   3. MessageGroup's RunStatusDivider (「处理中」 / 「已处理 Ns」), which takes
//      the placeholder's slot once the first thinking/tool step arrives
//   4. TaskBlock's active header, one row below the divider
// Rows 1–3 replace each other in the same visual spot, so they keep the exact
// same size and baseline — any divergence reads as the text hopping lines
// ("错行"). Every row sets its words in text-ui; the spinner rows use the sm
// Spinner, like the TaskBlock header, so their words start in the same column.

/** One status row: the area's Spinner with its words. No vertical padding of
 *  its own — callers that need the mb-2 of the successor rows pass it via
 *  className. */
export function ThinkingStatusLine({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center', className)}>
      <Spinner size="sm" label={label} />
    </div>
  );
}

/** The 28px assistant-row avatar. Shared by MessageGroup's group row and the
 *  typing footer that mimics it — identical markup keeps the label's
 *  horizontal offset (avatar width + gap) and top alignment (mt-0.5) in sync
 *  across the footer → group hand-off. */
export function AssistantRowAvatar({ avatar, name }: { avatar?: React.ReactNode; name?: string } = {}) {
  return (
    <div className="shrink-0 mt-0.5">
      {avatar ? (
        // Team-pinned conversation: the leader answers, so its avatar sits
        // where Abu's would (same 28px slot — the label offset stays in sync).
        <div role="img" aria-label={name} title={name} data-testid="assistant-row-avatar-leader" className="w-7 h-7">
          {avatar}
        </div>
      ) : (
        <div className="w-7 h-7 rounded-full overflow-hidden">
          <img src={abuAvatar} alt="Abu" className="w-full h-full object-cover" />
        </div>
      )}
    </div>
  );
}
