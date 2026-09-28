import type { ReactNode } from 'react';

// Title and optional one-line description on the left, the control on the right.
export function SettingRow({ title, description, children, htmlFor }: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3">
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
