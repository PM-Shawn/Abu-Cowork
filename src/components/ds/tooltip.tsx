import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useLayerContainer } from './layer-context';
import { TOOLTIP_MOTION } from './styles';

// One sentence that starts with a verb ("Copy code"). Opens on hover after a delay and
// immediately on keyboard focus.
export function Tooltip({ content, children, side = 'top' }: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  const container = useLayerContainer();
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal container={container}>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          data-ds-motion
          className={cn('z-tooltip max-w-64 origin-(--radix-tooltip-content-transform-origin) rounded-control bg-material px-2 py-1 text-ui-sm text-label shadow-float backdrop-blur-xl', TOOLTIP_MOTION)}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
