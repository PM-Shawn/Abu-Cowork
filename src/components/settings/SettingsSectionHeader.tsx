import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Shared header for settings sections. Renders the plain `<h3>` title style used
 * across every panel so headings look identical. An optional `action` slot puts
 * a control (e.g. an "add" button) on the right of the title row; when present,
 * the row reserves right padding so the button clears the modal's absolute
 * top-right close (X) button.
 */
export default function SettingsSectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-3', action && 'pr-8')}>
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-[var(--abu-text-primary)]">{title}</h3>
        {description && (
          <p className="text-xs text-[var(--abu-text-muted)] mt-1">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
