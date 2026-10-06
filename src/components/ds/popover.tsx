import { Popover as PopoverPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { DataAttributes } from './dialog';
import { LayerScope } from './layer';
import { useFloatingLevel, useLayer, useLayerContainer, useOpenState } from './layer-context';
import { EDGE_GAP, FLOAT_MOTION, FLOAT_SURFACE, FOCUS_RING } from './styles';

// The box never grows past the room Radix measures between the trigger and the window edge; more scrolls inside it.
export function Popover({
  trigger, children, open, defaultOpen = false, onOpenChange, onOpenAutoFocus, onCloseAutoFocus: callerCloseAutoFocus,
  staysOnOutsidePress = false, align = 'center', side = 'bottom', className, contentProps, label,
}: {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  // Runs as the popover opens, before the focus moves to its first control.
  // event.preventDefault() leaves the focus where it is: for a popover that opens by itself
  // while the user is working elsewhere on the page.
  onOpenAutoFocus?: (event: Event) => void;
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
  // data-* attributes for the popover's own box (a test id).
  contentProps?: DataAttributes;
  // The name of the box (its role is dialog), when its content does not say what it is.
  label?: string;
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
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={onEscapeKeyDown}
          onInteractOutside={staysOnOutsidePress ? (event) => event.preventDefault() : undefined}
          aria-label={label}
          {...contentProps}
          data-ds-layer
          // Its role is dialog, as a window's is: this tells it from one (read by ConfirmProvider).
          data-ds-popover
          data-ds-motion
          data-electron-no-drag
          className={cn(level, 'max-h-(--radix-popover-content-available-height) w-72 origin-(--radix-popover-content-transform-origin) overflow-y-auto p-3 text-ui', FLOAT_SURFACE, FOCUS_RING, FLOAT_MOTION, className)}
        >
          <LayerScope id={id}>{children}</LayerScope>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
