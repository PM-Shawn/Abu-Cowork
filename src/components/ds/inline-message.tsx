import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { StatusIcon, type StatusTone } from './status-icon';

const SURFACE = { success: 'bg-success-soft', warning: 'bg-warning-soft', danger: 'bg-danger-soft', info: 'bg-info-soft' } as const;

// Shown next to the thing it is about and stays until the cause is fixed.
export function InlineMessage({ tone, children, action }: { tone: StatusTone; children: ReactNode; action?: ReactNode }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex items-center gap-2 rounded-control px-3 py-2 text-ui text-label', SURFACE[tone])}>
      <StatusIcon tone={tone} size="sm" />
      <div className="min-w-0 flex-1">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
