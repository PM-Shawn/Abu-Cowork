import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { oncePerPress } from './heldKey';
import { FOCUS_RING } from './styles';

// It is followed once per press: the repeats of a held Enter are dropped (heldKey.ts).
export function Link({ className, onKeyDown, ...props }: ComponentProps<'a'>) {
  return <a className={cn('rounded-control text-link underline-offset-2 hover:underline', FOCUS_RING, className)} {...props} onKeyDown={oncePerPress(onKeyDown)} />;
}
