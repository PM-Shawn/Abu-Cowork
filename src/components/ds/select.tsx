import { Select as SelectPrimitive } from 'radix-ui';
import type { LucideIcon } from 'lucide-react';
import { useId, useRef, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { dropsHeldEscape, dropsHeldRepeat, useHeldKeys } from './heldKey';
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

// What an option shows in the list and, once chosen, in the closed select: its mark and its
// name, never its description.
function markAndName(option: SelectOption) {
  if (!option.tone && !option.icon) return option.label;
  return (
    <span className="inline-flex items-center gap-2">
      {option.tone ? <StatusIcon tone={option.tone} size="sm" /> : option.icon && <Icon icon={option.icon} size="sm" className="text-label-secondary" />}
      {option.label}
    </span>
  );
}

// Arrow keys on a closed select only open the list; inside the list they only move the
// highlight. A value changes on Enter, Space or a click.
export function Select({ value, onValueChange, onReselect, options, label, placeholder, disabled, open, defaultOpen = false, onOpenChange, onCloseAutoFocus: callerCloseAutoFocus, fullWidth = false }: {
  value: string;
  onValueChange: (value: string) => void;
  // The user picked the option that is already chosen. For an option that opens something
  // (a "Custom…" window), where picking it again means "open it again".
  onReselect?: (value: string) => void;
  options: SelectOption[];
  label: string;
  placeholder?: string;
  disabled?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  // Runs once the list has gone, just before the focus returns to the select. Open a dialog
  // that a choice leads to from here, so the dialog gives the focus back to the select;
  // event.preventDefault() keeps the focus from returning. When event.defaultPrevented is
  // already true, the registry closed the list for another layer: leave the focus alone.
  onCloseAutoFocus?: (event: Event) => void;
  // Fills the width of its container, so a group of selects lines up (wrap them in a sized div).
  fullWidth?: boolean;
}) {
  const container = useLayerContainer();
  const [isOpen, setOpen] = useOpenState(open, defaultOpen, onOpenChange);
  const { id, onCloseAutoFocus } = useLayer('popover', isOpen, setOpen);
  // The key that opened the list picks nothing in it while it stays down, and one press of Enter
  // or Space picks once.
  const heldKeys = useHeldKeys(isOpen, 'enter-space');
  const level = useFloatingLevel();
  const descriptionBase = useId();
  const chosen = options.find((option) => option.value === value);
  // The option under the pointer or key event that is being handled right now. Radix closes the
  // list inside that event when it picks the option, and says nothing more when the value is the same.
  const picking = useRef<string | null>(null);
  const notePick = (optionValue: string) => {
    const note = () => { picking.current = optionValue; };
    // A key that repeats because it is held down picks nothing a second time.
    return { onPointerUp: note, onClick: note, onKeyDown: (event: KeyboardEvent) => { if (!event.repeat) note(); } };
  };
  // The event passed the option without closing the list: it was not a pick.
  const endPick = () => { picking.current = null; };
  const changeOpen = (next: boolean) => {
    const picked = picking.current;
    picking.current = null;
    setOpen(next);
    if (!next && picked !== null && picked === value) onReselect?.(picked);
  };
  return (
    // A value that no option has (a stored choice that is no longer on offer) is shown as no
    // choice: the placeholder, and no option marked. The owner keeps the value it holds.
    <SelectPrimitive.Root value={chosen ? value : ''} onValueChange={onValueChange} open={isOpen} onOpenChange={changeOpen} disabled={disabled}>
      <SelectPrimitive.Trigger
        aria-label={label}
        // A closed select never changes its value from a key press. Radix would otherwise pick the
        // option that starts with the typed character.
        onKeyDown={(event) => {
          // The repeat of a held key opens nothing (Enter, Space, and the two arrows that open the
          // list): a prevented key-down is one Radix leaves alone. Tab still repeats past it.
          if (dropsHeldRepeat(event)) return;
          if (event.repeat && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) event.preventDefault();
          if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.altKey && !event.metaKey) event.preventDefault();
        }}
        className={cn(fullWidth ? 'flex w-full' : 'inline-flex min-w-32', 'h-7 items-center justify-between gap-2 rounded-control border border-control-border bg-field px-2 text-ui text-label data-[placeholder]:text-label-placeholder', FOCUS_RING, DISABLED)}
      >
        <span className="min-w-0 truncate">
          {/* The closed select draws the chosen option itself, so no list exists until it opens. */}
          <SelectPrimitive.Value placeholder={placeholder}>{chosen && markAndName(chosen)}</SelectPrimitive.Value>
        </span>
        <SelectPrimitive.Icon className="inline-flex text-label-secondary">
          <Icon icon={AppIcons.selectorChevrons} size="sm" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      {/* Mounted only while open. A closed Radix list would keep every option, and a React portal
          with its full set of event listeners, alive for each select on the page. */}
      {isOpen && <SelectPrimitive.Portal container={container}>
        <SelectPrimitive.Content
          {...heldKeys.handlers}
          position="popper"
          sideOffset={4}
          collisionPadding={EDGE_GAP}
          // One press of Escape closes one thing: an Escape that was down when the list opened
          // leaves it open, as in every other layer (heldKey.ts).
          onEscapeKeyDown={(event) => { dropsHeldEscape(event); }}
          onCloseAutoFocus={(event) => {
            // The layer's handler first: it prevents the default when the registry closed this list.
            onCloseAutoFocus(event);
            callerCloseAutoFocus?.(event);
          }}
          data-ds-layer
          data-ds-motion
          data-electron-no-drag
          className={cn(level, 'max-h-72 min-w-(--radix-select-trigger-width) origin-(--radix-select-content-transform-origin) overflow-hidden p-1', FLOAT_SURFACE, FLOAT_MOTION)}
        >
          <SelectPrimitive.Viewport onPointerUp={endPick} onClick={endPick} onKeyDown={endPick}>
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
                    <SelectPrimitive.Item key={option.value} value={option.value} disabled={option.disabled} {...notePick(option.value)} className={cn(MENU_ITEM, RADIX_ITEM_DISABLED, 'relative pr-6')}>
                      <SelectPrimitive.ItemText>{markAndName(option)}</SelectPrimitive.ItemText>
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
                    {...notePick(option.value)}
                    className={cn(MENU_ITEM, RADIX_ITEM_DISABLED, 'relative pr-6', option.description && 'h-auto items-start py-1')}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <SelectPrimitive.ItemText>{markAndName(option)}</SelectPrimitive.ItemText>
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
      </SelectPrimitive.Portal>}
    </SelectPrimitive.Root>
  );
}
