import { Command } from 'cmdk';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { AppIcons } from './icons';
import { LayerScope } from './layer';
import { useLayer, useLayerContainer } from './layer-context';
import { DISABLED, FLOAT_MOTION, FLOAT_SURFACE, FOCUS_RING, MENU_ITEM } from './styles';

export interface ComboboxOption {
  value: string;
  label: string;
  keywords?: string[];
}

// A select with a search box, for lists too long to scan (models, skills, experts).
export function Combobox({ value, onValueChange, options, label, placeholder, searchPlaceholder, emptyText, disabled }: {
  value: string;
  onValueChange: (value: string) => void;
  options: ComboboxOption[];
  label: string;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  disabled?: boolean;
}) {
  const container = useLayerContainer();
  const [open, setOpen] = useState(false);
  const { id, onCloseAutoFocus } = useLayer('popover', open, setOpen);
  const selected = options.find((option) => option.value === value);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled}
          className={cn('inline-flex h-7 min-w-40 items-center justify-between gap-2 rounded-control border border-control-border bg-field px-2 text-ui', selected ? 'text-label' : 'text-label-placeholder', FOCUS_RING, DISABLED)}
        >
          <span className="truncate">{selected ? selected.label : placeholder}</span>
          <Icon icon={AppIcons.selectorChevrons} size="sm" className="text-label-secondary" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal container={container}>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          onCloseAutoFocus={onCloseAutoFocus}
          data-ds-layer
          data-ds-motion
          className={cn('z-popover w-(--radix-popover-trigger-width) min-w-56 origin-(--radix-popover-content-transform-origin) p-1', FLOAT_SURFACE, FLOAT_MOTION)}
        >
          <LayerScope id={id}>
            {/* cmdk names its search box with aria-labelledby pointing at this label. */}
            <Command label={searchPlaceholder}>
              <div className="flex items-center gap-2 border-b border-separator px-2 pb-1">
                <Icon icon={AppIcons.search} size="sm" className="text-label-tertiary" />
                <Command.Input
                  placeholder={searchPlaceholder}
                  className="h-7 w-full bg-transparent text-ui text-label outline-none placeholder:text-label-placeholder"
                />
              </div>
              <Command.List className="max-h-64 overflow-y-auto pt-1">
                <Command.Empty className="px-2 py-3 text-ui text-label-secondary">{emptyText}</Command.Empty>
                {options.map((option) => (
                  <Command.Item
                    key={option.value}
                    value={option.value}
                    keywords={[option.label, ...(option.keywords ?? [])]}
                    onSelect={() => {
                      onValueChange(option.value);
                      setOpen(false);
                    }}
                    className={cn(MENU_ITEM, 'data-[selected=true]:bg-fill-selected')}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.value === value && <Icon icon={AppIcons.done} size="sm" />}
                  </Command.Item>
                ))}
              </Command.List>
            </Command>
          </LayerScope>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
