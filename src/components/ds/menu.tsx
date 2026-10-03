import { ContextMenu as ContextMenuPrimitive, DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import type { LucideIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { AppIcons } from './icons';
import { LayerScope } from './layer';
import { useFloatingLevel, useLayer, useLayerContainer, useOpenState } from './layer-context';
import { MenuKindContext, useMenuKind } from './menu-context';
import { EDGE_GAP, FLOAT_MOTION, FLOAT_SURFACE, MENU_ITEM, RADIX_ITEM_DISABLED } from './styles';

// The panel never grows past the room Radix measures between the trigger and the window edge; a longer list scrolls.
const MENU_PANEL = 'max-h-(--radix-dropdown-menu-content-available-height) min-w-40 origin-(--radix-dropdown-menu-content-transform-origin) overflow-y-auto p-1';

// onCloseAutoFocus runs after the layer's own handler once the menu has gone; call
// event.preventDefault() there to keep focus off the trigger (e.g. to focus a field).
export function Menu({ trigger, children, align = 'start', side = 'bottom', open, defaultOpen = false, onOpenChange, onCloseAutoFocus }: {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const container = useLayerContainer();
  const [isOpen, setOpen] = useOpenState(open, defaultOpen, onOpenChange);
  const { id, onCloseAutoFocus: layerCloseAutoFocus } = useLayer('popover', isOpen, setOpen);
  const level = useFloatingLevel();
  return (
    <DropdownMenuPrimitive.Root open={isOpen} onOpenChange={setOpen}>
      <DropdownMenuPrimitive.Trigger asChild>{trigger}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal container={container}>
        <DropdownMenuPrimitive.Content
          align={align}
          side={side}
          sideOffset={4}
          collisionPadding={EDGE_GAP}
          onCloseAutoFocus={(event) => { layerCloseAutoFocus(event); onCloseAutoFocus?.(event); }}
          data-ds-layer
          data-ds-motion
          data-electron-no-drag
          className={cn(level, MENU_PANEL, FLOAT_SURFACE, FLOAT_MOTION)}
        >
          <LayerScope id={id}>
            <MenuKindContext.Provider value="dropdown">{children}</MenuKindContext.Provider>
          </LayerScope>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

// onSelect receives Radix's select event; event.preventDefault() keeps the menu open
// (an item whose result shows in the item itself, like checking for updates).
export function MenuItem({ children, icon, shortcut, tone = 'default', disabled, onSelect, description, title }: {
  children: ReactNode;
  icon?: LucideIcon;
  shortcut?: string;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  onSelect?: (event: Event) => void;
  // A second line under the name. The name alone stays the item's name.
  description?: ReactNode;
  // Native hint for an item whose name does not say what choosing it does (a version's time).
  title?: string;
}) {
  const kind = useMenuKind();
  const descriptionId = useId();
  const className = cn(MENU_ITEM, RADIX_ITEM_DISABLED, tone === 'danger' && 'text-danger', description && 'h-auto items-start py-1');
  // aria-hidden keeps the description out of the name; aria-describedby still reads it.
  const label = description ? (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{children}</span>
      <span id={descriptionId} aria-hidden="true" className="w-64 text-ui-sm text-label-secondary">{description}</span>
    </span>
  ) : <span className="min-w-0 flex-1 truncate">{children}</span>;
  // With a second line the row aligns to the top; the nudge centers the icon and the shortcut on the first line.
  const body = (
    <>
      {icon && <Icon icon={icon} size="sm" className={cn(tone === 'danger' ? 'text-danger' : 'text-label-secondary', description && 'mt-0.5')} />}
      {label}
      {shortcut && <span className={cn('text-ui-sm text-label-tertiary', description && 'mt-0.5')}>{shortcut}</span>}
    </>
  );
  const describedBy = description ? descriptionId : undefined;
  return kind === 'dropdown'
    ? <DropdownMenuPrimitive.Item disabled={disabled} onSelect={(event) => onSelect?.(event)} aria-describedby={describedBy} title={title} className={className}>{body}</DropdownMenuPrimitive.Item>
    : <ContextMenuPrimitive.Item disabled={disabled} onSelect={(event) => onSelect?.(event)} aria-describedby={describedBy} title={title} className={className}>{body}</ContextMenuPrimitive.Item>;
}

// A nested list inside a Menu or ContextMenu. It belongs to the parent menu's layer:
// choosing one of its items closes the whole menu.
export function MenuSub({ label, icon, children }: { label: ReactNode; icon?: LucideIcon; children: ReactNode }) {
  const kind = useMenuKind();
  const container = useLayerContainer();
  const level = useFloatingLevel();
  const triggerBody = (
    <>
      {icon && <Icon icon={icon} size="sm" className="text-label-secondary" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Icon icon={AppIcons.disclose} size="sm" className="text-label-tertiary" />
    </>
  );
  const triggerClass = cn(MENU_ITEM, 'data-[state=open]:bg-fill-selected');
  const contentClass = cn(level, 'min-w-40 p-1', FLOAT_SURFACE, FLOAT_MOTION);
  if (kind === 'dropdown') {
    return (
      <DropdownMenuPrimitive.Sub>
        <DropdownMenuPrimitive.SubTrigger className={triggerClass}>{triggerBody}</DropdownMenuPrimitive.SubTrigger>
        <DropdownMenuPrimitive.Portal container={container}>
          <DropdownMenuPrimitive.SubContent
            sideOffset={4}
            collisionPadding={EDGE_GAP}
            data-ds-motion
            data-electron-no-drag
            className={cn('origin-(--radix-dropdown-menu-content-transform-origin)', contentClass)}
          >
            {children}
          </DropdownMenuPrimitive.SubContent>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Sub>
    );
  }
  return (
    <ContextMenuPrimitive.Sub>
      <ContextMenuPrimitive.SubTrigger className={triggerClass}>{triggerBody}</ContextMenuPrimitive.SubTrigger>
      <ContextMenuPrimitive.Portal container={container}>
        <ContextMenuPrimitive.SubContent
          sideOffset={4}
          collisionPadding={EDGE_GAP}
          data-ds-motion
          data-electron-no-drag
          className={cn('origin-(--radix-context-menu-content-transform-origin)', contentClass)}
        >
          {children}
        </ContextMenuPrimitive.SubContent>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Sub>
  );
}

// A set of choices where exactly one is current (language, appearance, the current app).
// Items read as menuitemradio with aria-checked; the current one shows a check.
export function MenuRadioGroup({ value, onValueChange, children }: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
}) {
  return useMenuKind() === 'dropdown'
    ? <DropdownMenuPrimitive.RadioGroup value={value} onValueChange={onValueChange}>{children}</DropdownMenuPrimitive.RadioGroup>
    : <ContextMenuPrimitive.RadioGroup value={value} onValueChange={onValueChange}>{children}</ContextMenuPrimitive.RadioGroup>;
}

export function MenuRadioItem({ value, children, description, disabled }: {
  value: string;
  children: ReactNode;
  // A second line under the name (what the choice means). The name alone stays the item's name.
  description?: ReactNode;
  disabled?: boolean;
}) {
  const kind = useMenuKind();
  const descriptionId = useId();
  const className = cn(MENU_ITEM, RADIX_ITEM_DISABLED, 'relative pr-6', description && 'h-auto items-start py-1');
  const check = <Icon icon={AppIcons.done} size="sm" />;
  // aria-hidden keeps the description out of the name; aria-describedby still reads it.
  const body = description ? (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{children}</span>
      <span id={descriptionId} aria-hidden="true" className="w-64 text-ui-sm text-label-secondary">{description}</span>
    </span>
  ) : <span className="min-w-0 flex-1 truncate">{children}</span>;
  const describedBy = description ? descriptionId : undefined;
  return kind === 'dropdown'
    ? (
      <DropdownMenuPrimitive.RadioItem value={value} disabled={disabled} aria-describedby={describedBy} className={className}>
        {body}
        <DropdownMenuPrimitive.ItemIndicator className="absolute right-2 inline-flex">{check}</DropdownMenuPrimitive.ItemIndicator>
      </DropdownMenuPrimitive.RadioItem>
    )
    : (
      <ContextMenuPrimitive.RadioItem value={value} disabled={disabled} aria-describedby={describedBy} className={className}>
        {body}
        <ContextMenuPrimitive.ItemIndicator className="absolute right-2 inline-flex">{check}</ContextMenuPrimitive.ItemIndicator>
      </ContextMenuPrimitive.RadioItem>
    );
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
