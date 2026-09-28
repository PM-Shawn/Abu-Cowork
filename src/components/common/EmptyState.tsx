import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * The empty shelf every 「我的」 shows before the user has anything: an icon, a
 * line saying what is missing, a line saying what the thing is for, and the
 * one button that creates it. Shared so 专家 / 专家团 / 技能 / 连接器 all read
 * the same when they are empty.
 */
export default function EmptyState({ icon: Icon, title, hint, action }: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div data-testid="empty-state" className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <Icon className="h-8 w-8 text-[var(--abu-text-tertiary)]" strokeWidth={1.5} />
      <div className="text-body font-medium text-[var(--abu-text-secondary)]">{title}</div>
      {hint && <div className="max-w-sm text-caption text-[var(--abu-text-tertiary)]">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
