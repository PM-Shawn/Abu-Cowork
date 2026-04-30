import { formatDayLabel } from '@/utils/messageTime';

export default function DaySeparator({ timestamp }: { timestamp: number }) {
  const label = formatDayLabel(timestamp);
  return (
    <div
      role="separator"
      aria-label={label}
      className="flex items-center gap-3 my-2 select-none"
    >
      <div className="flex-1 h-px bg-[var(--abu-border-subtle)]" />
      <span className="text-[11px] text-[var(--abu-text-muted)] tracking-wide">
        {label}
      </span>
      <div className="flex-1 h-px bg-[var(--abu-border-subtle)]" />
    </div>
  );
}
