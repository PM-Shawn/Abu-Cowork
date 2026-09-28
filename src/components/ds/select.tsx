import { Select as SelectPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { AppIcons } from './icons';
import { LayerScope } from './layer';
import { useLayer, useLayerContainer, useOpenState } from './layer-context';
import { DISABLED, FLOAT_MOTION, FLOAT_SURFACE, FOCUS_RING, MENU_ITEM, RADIX_ITEM_DISABLED } from './styles';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function Select({ value, onValueChange, options, label, placeholder, disabled, open, defaultOpen = false, onOpenChange }: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  label: string;
  placeholder?: string;
  disabled?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const container = useLayerContainer();
  const [isOpen, setOpen] = useOpenState(open, defaultOpen, onOpenChange);
  const { id, onCloseAutoFocus } = useLayer('popover', isOpen, setOpen);
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} open={isOpen} onOpenChange={setOpen} disabled={disabled}>
      <SelectPrimitive.Trigger
        aria-label={label}
        className={cn('inline-flex h-7 min-w-32 items-center justify-between gap-2 rounded-control border border-control-border bg-field px-2 text-ui text-label data-[placeholder]:text-label-placeholder', FOCUS_RING, DISABLED)}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className="inline-flex text-label-secondary">
          <Icon icon={AppIcons.selectorChevrons} size="sm" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal container={container}>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          onCloseAutoFocus={onCloseAutoFocus}
          data-ds-layer
          data-ds-motion
          data-electron-no-drag
          className={cn('z-popover max-h-72 min-w-(--radix-select-trigger-width) origin-(--radix-select-content-transform-origin) overflow-hidden p-1', FLOAT_SURFACE, FLOAT_MOTION)}
        >
          <SelectPrimitive.Viewport>
            <LayerScope id={id}>
              {options.map((option) => (
                <SelectPrimitive.Item key={option.value} value={option.value} disabled={option.disabled} className={cn(MENU_ITEM, RADIX_ITEM_DISABLED, 'relative pr-6')}>
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex">
                    <Icon icon={AppIcons.done} size="sm" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </LayerScope>
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
