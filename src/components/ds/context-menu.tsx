import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';
import { useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { LayerScope } from './layer';
import { useLayer, useLayerContainer, useOpenState } from './layer-context';
import { MenuKindContext } from './menu-context';
import { FLOAT_MOTION, FLOAT_SURFACE } from './styles';

// onCloseAutoFocus runs after the layer's own handler once the menu has gone; call
// event.preventDefault() there to stop Radix restoring focus (e.g. to focus a field).
export function ContextMenu({ children, content, onOpenChange, onCloseAutoFocus }: {
  children: ReactNode;
  content: ReactNode;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const container = useLayerContainer();
  const [isOpen, setOpen] = useOpenState(undefined, false, onOpenChange);
  // Radix has no controlled open state here, so the registry closes the menu by
  // dropping its content until the next right-click opens it again, and reports the
  // close through onOpenChange. The trigger's Radix data-state may stay "open" until
  // that next right-click, so callers style an open menu from onOpenChange.
  const [dismissed, setDismissed] = useState(false);
  const { id, onCloseAutoFocus: layerCloseAutoFocus } = useLayer('popover', isOpen && !dismissed, () => {
    setDismissed(true);
    setOpen(false);
  });
  // Radix keeps the content mounted while it animates out, and a menu opened again in
  // that time stays where it was. Each opening gets its own content, placed at its own
  // pointer; the content it replaces must not take the focus back from it.
  const [opening, setOpening] = useState(0);
  const latestOpening = useRef(0);
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setDismissed(false);
      latestOpening.current += 1;
      setOpening(latestOpening.current);
    }
    setOpen(next);
  };
  return (
    <ContextMenuPrimitive.Root onOpenChange={handleOpenChange}>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal container={container}>
        {!dismissed && (
          <ContextMenuPrimitive.Content
            key={opening}
            data-ds-layer
            data-ds-motion
            data-electron-no-drag
            onCloseAutoFocus={(event) => {
              layerCloseAutoFocus(event);
              if (latestOpening.current !== opening) event.preventDefault();
              onCloseAutoFocus?.(event);
            }}
            // Like Menu: no taller than the room the window leaves; a longer list scrolls.
            className={cn('z-popover max-h-(--radix-context-menu-content-available-height) min-w-40 origin-(--radix-context-menu-content-transform-origin) overflow-y-auto p-1', FLOAT_SURFACE, FLOAT_MOTION)}
          >
            <LayerScope id={id}>
              <MenuKindContext.Provider value="context">{content}</MenuKindContext.Provider>
            </LayerScope>
          </ContextMenuPrimitive.Content>
        )}
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
