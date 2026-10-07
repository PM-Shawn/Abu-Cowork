import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { DISABLED, FIELD_BOX, FOCUS_RING } from './styles';

export function TextArea({ className, invalid = false, rows = 3, ...props }: ComponentProps<'textarea'> & { invalid?: boolean }) {
  return (
    <textarea
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn('min-h-16 resize-none py-2', FIELD_BOX, FOCUS_RING, DISABLED, className)}
      {...props}
    />
  );
}
