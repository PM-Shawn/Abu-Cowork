import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { DataAttributes } from './dialog';
import { StatusIcon, type StatusTone } from './status-icon';

const TONE = {
  neutral: 'bg-fill text-label-secondary',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
} as const;

export function Tag({ tone = 'neutral', title, children, ...data }: { tone?: 'neutral' | StatusTone; title?: string; children: ReactNode } & DataAttributes) {
  return (
    <span title={title} {...data} className={cn('inline-flex h-5 items-center gap-1 rounded-control px-2 text-ui-sm font-medium', TONE[tone])}>
      {tone !== 'neutral' && <StatusIcon tone={tone} size="sm" />}
      {children}
    </span>
  );
}
