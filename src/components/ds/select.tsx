import { Select as SelectPrimitive } from 'radix-ui';
import type { LucideIcon } from 'lucide-react';
import { useId } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { AppIcons } from './icons';
import { LayerScope } from './layer';
import { useFloatingLevel, useLayer, useLayerContainer, useOpenState } from './layer-context';
import { StatusIcon, type StatusTone } from './status-icon';
import { DISABLED, EDGE_GAP, FLOAT_MOTION, FLOAT_SURFACE, FOCUS_RING, MENU_ITEM, RADIX_ITEM_DISABLED } from './styles';

export interface SelectOption {
  value: string;
  label: string;
  // A second line under the name, shown only in the open list (what the choice means).
  description?: string;
  // Shown before the name, in the list and in the closed select. A status wins over a plain icon.
  icon?: LucideIcon;
  tone?: StatusTone;
  disabled?: boolean;
}

// Arrow keys on a closed select only open the list; inside the list they only move the
// highlight. A value changes on Enter, Space or a click.
export function Select({ value, onValueChange, options, label, placeholder, disabled, open, defaultOpen = false, onOpenChange, fullWidth = false }: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  label: string;
  placeholder?: string;
  disabled?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  // Fills the width of its container, so a group of selects lines up (wrap them in a sized div).
  fullWidth?: boolean;
}) {
  const container = useLayerContainer();
  const [isOpen, setOpen] = useOpenState(open, defaultOpen, onOpenChange);
  const { id, onCloseAutoFocus } = useLayer('popover', isOpen, setOpen);
  const level = useFloatingLevel();
  const descriptionBase = useId();
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} open={isOpen} onOpenChange={setOpen} disabled={disabled}>
      <SelectPrimitive.Trigger
        aria-label={label}
        // A closed select never changes its value from a key press. Radix would otherwise pick the
        // option that starts with the typed character.
        onKeyDown={(event) => {
          if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.altKey && !event.metaKey) event.preventDefault();
        }}
        className={cn(fullWidth ? 'flex w-full' : 'inline-flex min-w-32', 'h-7 items-center justify-between gap-2 rounded-control border border-control-border bg-field px-2 text-ui text-label data-[placeholder]:text-label-placeholder', FOCUS_RING, DISABLED)}
      >
        <span className="min-w-0 truncate">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon className="inline-flex text-label-secondary">
          <Icon icon={AppIcons.selectorChevrons} size="sm" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal container={container}>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          collisionPadding={EDGE_GAP}
          onCloseAutoFocus={onCloseAutoFocus}
          data-ds-layer
          data-ds-motion
          data-electron-no-drag
          className={cn(level, 'max-h-72 min-w-(--radix-select-trigger-width) origin-(--radix-select-content-transform-origin) overflow-hidden p-1', FLOAT_SURFACE, FLOAT_MOTION)}
        >
          <SelectPrimitive.Viewport>
            <LayerScope id={id}>
              {options.map((option, index) => {
                // With a second line the row aligns to the top; the nudge centers the check mark on the name line.
                const indicator = (
                  <SelectPrimitive.ItemIndicator className={cn('absolute right-2 inline-flex', option.description && 'mt-0.5')}>
                    <Icon icon={AppIcons.done} size="sm" />
                  </SelectPrimitive.ItemIndicator>
                );
                if (!option.description && !option.icon && !option.tone) {
                  return (
                    <SelectPrimitive.Item key={option.value} value={option.value} disabled={option.disabled} className={cn(MENU_ITEM, RADIX_ITEM_DISABLED, 'relative pr-6')}>
                      <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                      {indicator}
                    </SelectPrimitive.Item>
                  );
                }
                const descriptionId = `${descriptionBase}-${index}`;
                return (
                  <SelectPrimitive.Item
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    // Typing in the open list matches the name, never the description.
                    textValue={option.label}
                    aria-describedby={option.description ? descriptionId : undefined}
                    className={cn(MENU_ITEM, RADIX_ITEM_DISABLED, 'relative pr-6', option.description && 'h-auto items-start py-1')}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      {/* Radix copies the chosen option's ItemText into the closed select: icon and name, no description. */}
                      <SelectPrimitive.ItemText>
                        <span className="inline-flex items-center gap-2">
                          {option.tone ? <StatusIcon tone={option.tone} size="sm" /> : option.icon && <Icon icon={option.icon} size="sm" className="text-label-secondary" />}
                          {option.label}
                        </span>
                      </SelectPrimitive.ItemText>
                      {/* aria-hidden keeps the description out of the name; aria-describedby still reads it.
                          Beside an icon it starts under the name: 22px is the 14px icon plus the 8px gap. */}
                      {option.description && (
                        <span id={descriptionId} aria-hidden="true" className={cn('w-64 whitespace-normal text-ui-sm text-label-secondary', (option.tone || option.icon) && 'pl-5.5')}>{option.description}</span>
                      )}
                    </span>
                    {indicator}
                  </SelectPrimitive.Item>
                );
              })}
            </LayerScope>
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
