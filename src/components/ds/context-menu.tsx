import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { LayerScope } from './layer';
import { useLayer, useLayerContainer, useOpenState } from './layer-context';
import { MenuKindContext } from './menu-context';
import { FLOAT_MOTION, FLOAT_SURFACE } from './styles';

// Radix keeps a context menu's open state to itself, so the registry cannot close it.
// It does not need to: the menu is modal, and any pointer or key input outside it
// dismisses it before another layer can open. Registering still closes other popovers.
const leaveToRadix = () => undefined;

export function ContextMenu({ children, content, onOpenChange }: {
  children: ReactNode;
  content: ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const container = useLayerContainer();
  const [isOpen, setOpen] = useOpenState(undefined, false, onOpenChange);
  const id = useLayer('popover', isOpen, leaveToRadix);
  return (
    <ContextMenuPrimitive.Root onOpenChange={setOpen}>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal container={container}>
        <ContextMenuPrimitive.Content data-ds-layer data-ds-motion className={cn('z-popover min-w-40 p-1', FLOAT_SURFACE, FLOAT_MOTION)}>
          <LayerScope id={id}>
            <MenuKindContext.Provider value="context">{content}</MenuKindContext.Provider>
          </LayerScope>
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
