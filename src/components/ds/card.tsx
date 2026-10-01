import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// Content always sits on an opaque card; only the desk behind it is translucent.
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-panel bg-surface p-4 text-label shadow-panel', className)}>{children}</div>;
}
