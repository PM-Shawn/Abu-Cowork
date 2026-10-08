import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { DISABLED, FIELD_BOX, FOCUS_RING } from './styles';

// `bare` is the editing area of a card that draws the box itself (the composer): no border, no
// fill, no focus ring, no padding, no minimum height and no disabled look of its own. Its caller
// gives it every one of those it needs.
const BARE = 'w-full resize-none bg-transparent outline-none';

export function TextArea({ className, invalid = false, bare = false, rows = 3, ...props }: ComponentProps<'textarea'> & { invalid?: boolean; bare?: boolean }) {
  return (
    <textarea
      rows={rows}
      aria-invalid={invalid || undefined}
      className={bare ? cn(BARE, className) : cn('min-h-16 resize-none py-2', FIELD_BOX, FOCUS_RING, DISABLED, className)}
      {...props}
    />
  );
}
