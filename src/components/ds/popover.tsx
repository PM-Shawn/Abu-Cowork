import { Popover as PopoverPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { LayerScope } from './layer';
import { useFloatingLevel, useLayer, useLayerContainer, useOpenState } from './layer-context';
import { EDGE_GAP, FLOAT_MOTION, FLOAT_SURFACE, FOCUS_RING } from './styles';

export function Popover({ trigger, children, open, defaultOpen = false, onOpenChange, onCloseAutoFocus: callerCloseAutoFocus, staysOnOutsidePress = false, align = 'center', side = 'bottom', className }: {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  // Runs once the popover has gone, just before the focus returns to the trigger.
  // event.preventDefault() keeps the focus where the caller has put it. When
  // event.defaultPrevented is already true, the registry closed the popover for another layer.
  onCloseAutoFocus?: (event: Event) => void;
  // The popover holds something the user still has to answer while working elsewhere on the
  // page (a held voice transcript): a press or a focus outside leaves it open. Its own buttons,
  // Escape and another layer opening still close it.
  staysOnOutsidePress?: boolean;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
}) {
  const container = useLayerContainer();
  const [isOpen, setOpen] = useOpenState(open, defaultOpen, onOpenChange);
  const { id, onCloseAutoFocus: layerCloseAutoFocus, onEscapeKeyDown } = useLayer('popover', isOpen, setOpen);
  const onCloseAutoFocus = (event: Event) => {
    layerCloseAutoFocus(event);
    callerCloseAutoFocus?.(event);
  };
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
          onInteractOutside={staysOnOutsidePress ? (event) => event.preventDefault() : undefined}
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
