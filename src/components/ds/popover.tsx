import { Popover as PopoverPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { LayerScope } from './layer';
import { useFloatingLevel, useLayer, useLayerContainer, useOpenState } from './layer-context';
import { EDGE_GAP, FLOAT_MOTION, FLOAT_SURFACE, FOCUS_RING } from './styles';

export function Popover({ trigger, children, open, defaultOpen = false, onOpenChange, align = 'center', side = 'bottom', className }: {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
}) {
  const container = useLayerContainer();
  const [isOpen, setOpen] = useOpenState(open, defaultOpen, onOpenChange);
  const { id, onCloseAutoFocus, onEscapeKeyDown } = useLayer('popover', isOpen, setOpen);
  const level = useFloatingLevel();
  return (
    <PopoverPrimitive.Root open={isOpen} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal container={container}>
        <PopoverPrimitive.Content
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={EDGE_GAP}
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={onEscapeKeyDown}
          data-ds-layer
          data-ds-motion
          data-electron-no-drag
          className={cn(level, 'w-72 origin-(--radix-popover-content-transform-origin) p-3 text-ui', FLOAT_SURFACE, FOCUS_RING, FLOAT_MOTION, className)}
        >
          <LayerScope id={id}>{children}</LayerScope>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
