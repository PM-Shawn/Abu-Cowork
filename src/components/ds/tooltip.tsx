import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { useEffect, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { cn } from '@/lib/utils';
import { lastInputWasPointer } from './input-modality';
import { useLayerContainer } from './layer-context';
import { EDGE_GAP, TOOLTIP_MOTION } from './styles';

// One sentence that starts with a verb ("Copy code"). Opens on hover after a delay and
// immediately on keyboard focus after a key press.
export function Tooltip({ content, children, side = 'top' }: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  const container = useLayerContainer();
  const [open, setOpen] = useState(false);
  // Escape took the tooltip off the page at once, without its fade.
  const [dropped, setDropped] = useState(false);
  // A tooltip is not a layer the user opened. Radix treats its content as the top dismissable
  // layer, which would use up the Escape. Window listeners run before Radix's document ones, so
  // the tooltip is gone by the time Radix asks which layer is on top: the press hides the
  // tooltip and still acts on the dialog, menu or popover underneath.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      flushSync(() => { setDropped(true); setOpen(false); });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);
  return (
    // Set on the root: the app's legacy TooltipProvider (200 ms) is the nearest provider.
    <TooltipPrimitive.Root delayDuration={500} open={open} onOpenChange={(next) => { if (next) setDropped(false); setOpen(next); }}>
      {/* After a pointer press, focus that arrives by code (a menu or window handing it back,
          a window's first control) shows no tooltip, like it shows no ring. */}
      <TooltipPrimitive.Trigger asChild onFocus={(event) => { if (lastInputWasPointer()) event.preventDefault(); }}>
        {children}
      </TooltipPrimitive.Trigger>
      {!dropped && (
        <TooltipPrimitive.Portal container={container}>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            collisionPadding={EDGE_GAP}
            data-ds-motion
            data-electron-no-drag
            className={cn('z-tooltip max-w-64 origin-(--radix-tooltip-content-transform-origin) rounded-control bg-raised px-2 py-1 text-ui-sm text-label shadow-float', TOOLTIP_MOTION)}
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      )}
    </TooltipPrimitive.Root>
  );
}
