import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Shared header for settings sections. Renders the plain `<h3>` title style used
 * across every panel so headings look identical. An optional `action` slot puts
 * a control (e.g. an "add" button) on the right of the title row; when present,
 * the row reserves right padding so the button clears the settings window's
 * top-right close button.
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
        <h3 className="text-title text-label">{title}</h3>
        {description && (
          <p className="mt-1 text-ui-sm text-label-secondary">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
