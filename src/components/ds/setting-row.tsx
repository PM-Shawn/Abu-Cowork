import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// Title and optional one-line description on the left, the control on the right.
export function SettingRow({ title, description, children, htmlFor }: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className={cn('flex justify-between gap-6 py-3', description ? 'items-start' : 'items-center')}>
      <div className="min-w-0">
        {htmlFor
          ? <label htmlFor={htmlFor} className="text-ui text-label">{title}</label>
          : <div className="text-ui text-label">{title}</div>}
        {description && <p className="mt-1 text-ui-sm text-label-secondary">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// A group of settings: an optional heading, then rows in one bordered box with a line between them.
export function SettingGroup({ title, description, children }: { title?: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <section>
      {title && <h4 className="text-ui font-medium text-label">{title}</h4>}
      {description && <p className="mt-1 text-ui-sm text-label-secondary">{description}</p>}
      <div className={cn('divide-y divide-separator rounded-panel border border-separator px-4', (title || description) && 'mt-2')}>{children}</div>
    </section>
  );
}
