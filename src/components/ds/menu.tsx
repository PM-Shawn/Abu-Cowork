import { ContextMenu as ContextMenuPrimitive, DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { LayerScope } from './layer';
import { useLayer, useLayerContainer, useOpenState } from './layer-context';
import { MenuKindContext, useMenuKind } from './menu-context';
import { FLOAT_MOTION, FLOAT_SURFACE, MENU_ITEM, RADIX_ITEM_DISABLED } from './styles';

const MENU_PANEL = 'z-popover min-w-40 origin-(--radix-dropdown-menu-content-transform-origin) p-1';

export function Menu({ trigger, children, align = 'start', side = 'bottom', open, defaultOpen = false, onOpenChange }: {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const container = useLayerContainer();
  const [isOpen, setOpen] = useOpenState(open, defaultOpen, onOpenChange);
  const { id, onCloseAutoFocus } = useLayer('popover', isOpen, setOpen);
  return (
    <DropdownMenuPrimitive.Root open={isOpen} onOpenChange={setOpen}>
      <DropdownMenuPrimitive.Trigger asChild>{trigger}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal container={container}>
        <DropdownMenuPrimitive.Content
          align={align}
          side={side}
          sideOffset={4}
          onCloseAutoFocus={onCloseAutoFocus}
          data-ds-layer
          data-ds-motion
          data-electron-no-drag
          className={cn(MENU_PANEL, FLOAT_SURFACE, FLOAT_MOTION)}
        >
          <LayerScope id={id}>
            <MenuKindContext.Provider value="dropdown">{children}</MenuKindContext.Provider>
          </LayerScope>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export function MenuItem({ children, icon, shortcut, tone = 'default', disabled, onSelect }: {
  children: ReactNode;
  icon?: LucideIcon;
  shortcut?: string;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  onSelect?: () => void;
}) {
  const kind = useMenuKind();
  const className = cn(MENU_ITEM, RADIX_ITEM_DISABLED, tone === 'danger' && 'text-danger');
  const body = (
    <>
      {icon && <Icon icon={icon} size="sm" className={tone === 'danger' ? 'text-danger' : 'text-label-secondary'} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <span className="text-ui-sm text-label-tertiary">{shortcut}</span>}
    </>
  );
  return kind === 'dropdown'
    ? <DropdownMenuPrimitive.Item disabled={disabled} onSelect={() => onSelect?.()} className={className}>{body}</DropdownMenuPrimitive.Item>
    : <ContextMenuPrimitive.Item disabled={disabled} onSelect={() => onSelect?.()} className={className}>{body}</ContextMenuPrimitive.Item>;
}

export function MenuSeparator() {
  const className = 'my-1 h-px bg-separator';
  return useMenuKind() === 'dropdown'
    ? <DropdownMenuPrimitive.Separator className={className} />
    : <ContextMenuPrimitive.Separator className={className} />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  const className = 'px-2 py-1 text-ui-sm text-label-tertiary';
  return useMenuKind() === 'dropdown'
    ? <DropdownMenuPrimitive.Label className={className}>{children}</DropdownMenuPrimitive.Label>
    : <ContextMenuPrimitive.Label className={className}>{children}</ContextMenuPrimitive.Label>;
}
