import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from './icon';

// "Nothing here" plus the next thing the user can do.
export function EmptyState({ title, description, icon, action }: {
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      {icon && <Icon icon={icon} size="lg" className="text-label-tertiary" />}
      <div className="text-title text-label">{title}</div>
      {description && <p className="max-w-80 text-ui text-label-secondary">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
