import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// Radix wraps the content in a `display: table` box that grows to the widest line;
// making it a block keeps the content at the viewport's width so text can truncate.
export function ScrollArea({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ScrollAreaPrimitive.Root className={cn('relative overflow-hidden', className)}>
      <ScrollAreaPrimitive.Viewport className="h-full w-full [&>div]:!block">{children}</ScrollAreaPrimitive.Viewport>
      {/* The bars share the layer of pinned content (z-sticky) and come later in the tree, so a
          pinned table header never covers them. */}
      <ScrollAreaPrimitive.Scrollbar orientation="vertical" className="z-sticky flex w-2 touch-none select-none">
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-fill-pressed" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Scrollbar orientation="horizontal" className="z-sticky flex h-2 touch-none select-none flex-col">
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-fill-pressed" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}
