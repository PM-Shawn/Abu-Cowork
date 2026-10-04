import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function ScrollArea({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ScrollAreaPrimitive.Root className={cn('relative overflow-hidden', className)}>
      <ScrollAreaPrimitive.Viewport className="h-full w-full">{children}</ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar orientation="vertical" className="flex w-2 touch-none select-none">
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-fill-pressed" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Scrollbar orientation="horizontal" className="flex h-2 touch-none select-none flex-col">
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-fill-pressed" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}
