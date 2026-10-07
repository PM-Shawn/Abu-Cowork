import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { DISABLED, FIELD_BOX, FOCUS_RING } from './styles';

export function TextField({ className, invalid = false, type = 'text', ...props }: ComponentProps<'input'> & { invalid?: boolean }) {
  return (
    <input
      type={type}
      aria-invalid={invalid || undefined}
      className={cn('h-7', FIELD_BOX, FOCUS_RING, DISABLED, className)}
      {...props}
    />
  );
}
