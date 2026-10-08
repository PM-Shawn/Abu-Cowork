import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { dropsHeldEnter } from './heldKey';
import { DISABLED, FIELD_BOX, FOCUS_RING } from './styles';

// A repeating Enter is dropped before the caller's key handler: a held Enter submits once.
// Every other key repeats, Space included (heldKey.ts).
export function TextField({ className, invalid = false, type = 'text', onKeyDown, ...props }: ComponentProps<'input'> & { invalid?: boolean }) {
  return (
    <input
      type={type}
      aria-invalid={invalid || undefined}
      className={cn('h-7', FIELD_BOX, FOCUS_RING, DISABLED, className)}
      {...props}
      onKeyDown={(event) => {
        if (dropsHeldEnter(event)) return;
        onKeyDown?.(event);
      }}
    />
  );
}
