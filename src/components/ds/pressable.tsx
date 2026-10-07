import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { oncePerPress } from './heldKey';
import { DISABLED, FOCUS_RING } from './styles';

// A button whose look is its content (image thumbnails, prompt cards, chapter ticks,
// citation badges). It brings only the focus ring and the disabled look; callers give
// layout and token colors. Use Button, IconButton or NavItem whenever one of them fits.
// Like them it acts once per press of Enter or Space (heldKey.ts).
export function Pressable({ className, type = 'button', onKeyDown, ...props }: ComponentProps<'button'>) {
  return <button type={type} className={cn(FOCUS_RING, DISABLED, className)} {...props} onKeyDown={oncePerPress(onKeyDown)} />;
}
