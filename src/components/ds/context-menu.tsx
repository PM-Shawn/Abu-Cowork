import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { LayerScope } from './layer';
import { useLayer, useLayerContainer, useOpenState } from './layer-context';
import { MenuKindContext } from './menu-context';
import { FLOAT_MOTION, FLOAT_SURFACE } from './styles';

export function ContextMenu({ children, content, onOpenChange }: {
  children: ReactNode;
  content: ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const container = useLayerContainer();
  const [isOpen, setOpen] = useOpenState(undefined, false, onOpenChange);
  // Radix has no controlled open state here, so the registry closes the menu by
  // dropping its content until the next right-click opens it again.
  const [dismissed, setDismissed] = useState(false);
  const id = useLayer('popover', isOpen && !dismissed, () => setDismissed(true));
  const handleOpenChange = (next: boolean) => {
    if (next) setDismissed(false);
    setOpen(next);
  };
  return (
    <ContextMenuPrimitive.Root onOpenChange={handleOpenChange}>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal container={container}>
        {!dismissed && (
          <ContextMenuPrimitive.Content
            data-ds-layer
            data-ds-motion
            className={cn('z-popover min-w-40 origin-(--radix-context-menu-content-transform-origin) p-1', FLOAT_SURFACE, FLOAT_MOTION)}
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
