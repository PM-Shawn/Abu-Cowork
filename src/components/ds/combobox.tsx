import { Command } from 'cmdk';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { memo, useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { dropsHeldRepeat, useHeldKeys } from './heldKey';
import { Icon } from './icon';
import { AppIcons } from './icons';
import { LayerScope } from './layer';
import { useFloatingLevel, useLayer, useLayerContainer, type LayerHandle } from './layer-context';
import { DISABLED, EDGE_GAP, FLOAT_MOTION, FLOAT_SURFACE, FOCUS_RING, MENU_ITEM } from './styles';

export interface ComboboxOption {
  value: string;
  label: string;
  keywords?: string[];
  disabled?: boolean;
  // A second line under the name. The name alone stays the option's name.
  description?: ReactNode;
  // Shown before the name (an avatar). It adds nothing to the option's name.
  icon?: ReactNode;
}

const TRIGGER = 'inline-flex h-7 min-w-40 items-center justify-between gap-2 rounded-control border border-control-border bg-field px-2 text-ui';

function ComboboxTrigger({ ref, label, open, disabled, text, placeholder }: {
  ref: RefObject<HTMLButtonElement | null>;
  label: string;
  open: boolean;
  disabled?: boolean;
  // What is chosen; empty when nothing is.
  text: string;
  placeholder: string;
}) {
  return (
    <PopoverPrimitive.Trigger asChild>
      <button
        ref={ref}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        // The repeat of a held Enter or Space opens nothing (heldKey.ts).
        onKeyDown={dropsHeldRepeat}
        className={cn(TRIGGER, text ? 'text-label' : 'text-label-placeholder', FOCUS_RING, DISABLED)}
      >
        <span className="truncate">{text || placeholder}</span>
        <Icon icon={AppIcons.selectorChevrons} size="sm" className="text-label-secondary" />
      </button>
    </PopoverPrimitive.Trigger>
  );
}

// memo: with many options, choosing one renders that row alone. Rows are compared by the
// identity of their option, and description and icon are React nodes, so callers pass the
// same option objects between renders (a module constant or useMemo).
const ComboboxRow = memo(function ComboboxRow({ option, selected, multiple, onPick }: {
  option: ComboboxOption;
  selected: boolean;
  multiple: boolean;
  onPick: (value: string) => void;
}) {
  const descriptionId = useId();
  const check = <Icon icon={AppIcons.done} size="sm" />;
  return (
    <Command.Item
      value={option.value}
      keywords={[option.label, ...(option.keywords ?? [])]}
      disabled={option.disabled}
      onSelect={() => onPick(option.value)}
      aria-describedby={option.description ? descriptionId : undefined}
      // cmdk's aria-selected follows the highlight, so the list is not marked multiselectable; the choice itself is aria-checked.
      aria-checked={multiple ? selected : undefined}
      className={cn(MENU_ITEM, 'data-[disabled=true]:opacity-40 data-[selected=true]:bg-fill-selected', option.description && 'h-auto py-1')}
    >
      {/* A slot as wide as the check, so every name starts at the same place. */}
      {multiple && <span className="flex size-3.5 shrink-0 items-center">{selected && check}</span>}
      {option.icon && <span aria-hidden="true" className="flex shrink-0 items-center">{option.icon}</span>}
      {/* aria-hidden keeps the description out of the name; aria-describedby still reads it. */}
      {option.description ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{option.label}</span>
          <span id={descriptionId} aria-hidden="true" className="truncate text-ui-sm text-label-secondary">{option.description}</span>
        </span>
      ) : <span className="min-w-0 flex-1 truncate">{option.label}</span>}
      {!multiple && selected && check}
    </Command.Item>
  );
});

// The floating list both comboboxes share: a search box over the options.
function ComboboxPanel({ layer, open, triggerRef, onLeave, options, isSelected, onPick, label, searchPlaceholder, emptyText, multiple = false }: {
  layer: LayerHandle;
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  // Closes the list when Tab is pressed in it.
  onLeave: () => void;
  options: ComboboxOption[];
  isSelected: (value: string) => boolean;
  onPick: (value: string) => void;
  label: string;
  searchPlaceholder: string;
  emptyText: string;
  multiple?: boolean;
}) {
  const container = useLayerContainer();
  const level = useFloatingLevel();
  // The list picks on the key-down of Enter: the Enter that opened it picks nothing while it stays
  // down, and one press picks once (a multiple choice is not turned on and off by a held Enter).
  // Space types into the search box and repeats.
  const heldKeys = useHeldKeys(open, 'enter');
  return (
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Content
        {...heldKeys.handlers}
        align="start"
        sideOffset={4}
        collisionPadding={EDGE_GAP}
        onCloseAutoFocus={layer.onCloseAutoFocus}
        onEscapeKeyDown={layer.onEscapeKeyDown}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          // Tab and Shift+Tab end like Escape: the list closes and the focus is on the trigger.
          // The key stops here, so the next Tab moves on from the trigger under the page's or
          // the dialog's own rules.
          event.preventDefault();
          triggerRef.current?.focus();
          onLeave();
        }}
        data-ds-layer
        // Its role is dialog, as a window's is: this tells it from one (read by ConfirmProvider).
        data-ds-popover
        data-ds-motion
        data-electron-no-drag
        className={cn(level, 'w-(--radix-popover-trigger-width) min-w-56 origin-(--radix-popover-content-transform-origin) p-1', FLOAT_SURFACE, FLOAT_MOTION)}
      >
        <LayerScope id={layer.id}>
          {/* cmdk names its search box with aria-labelledby pointing at this label. */}
          <Command label={searchPlaceholder}>
            <div className="flex items-center gap-2 border-b border-separator px-2 pb-1">
              <Icon icon={AppIcons.search} size="sm" className="text-label-tertiary" />
              <Command.Input
                placeholder={searchPlaceholder}
                className="h-7 w-full bg-transparent text-ui text-label outline-none placeholder:text-label-placeholder"
              />
            </div>
            <Command.List label={label} className="max-h-64 overflow-y-auto pt-1">
              <Command.Empty className="px-2 py-3 text-ui text-label-secondary">{emptyText}</Command.Empty>
              {options.map((option) => (
                <ComboboxRow key={option.value} option={option} selected={isSelected(option.value)} multiple={multiple} onPick={onPick} />
              ))}
            </Command.List>
          </Command>
        </LayerScope>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
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
  const [open, setOpen] = useState(false);
  const layer = useLayer('popover', open, setOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = options.find((option) => option.value === value);
  // One callback for the life of the list, so a row renders only when its own choice changes.
  const latest = useRef(onValueChange);
  useLayoutEffect(() => { latest.current = onValueChange; });
  const pick = useCallback((picked: string) => {
    latest.current(picked);
    setOpen(false);
  }, []);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <ComboboxTrigger ref={triggerRef} label={label} open={open} disabled={disabled} text={selected ? selected.label : ''} placeholder={placeholder} />
      <ComboboxPanel
        layer={layer}
        open={open}
        triggerRef={triggerRef}
        onLeave={() => setOpen(false)}
        options={options}
        isSelected={(candidate) => candidate === value}
        onPick={pick}
        label={label}
        searchPlaceholder={searchPlaceholder}
        emptyText={emptyText}
      />
    </PopoverPrimitive.Root>
  );
}

// A Combobox that holds several choices (the members of a team). Enter or a click turns
// the highlighted option on or off and the list stays open; Escape or Tab closes it and
// leaves the focus on the trigger.
export function MultiCombobox({ values, onValuesChange, options, label, placeholder, searchPlaceholder, emptyText, disabled }: {
  values: string[];
  onValuesChange: (values: string[]) => void;
  options: ComboboxOption[];
  label: string;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const layer = useLayer('popover', open, setOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // One callback for the life of the list, so a row renders only when its own choice changes.
  const latest = useRef({ values, onValuesChange });
  useLayoutEffect(() => { latest.current = { values, onValuesChange }; });
  const toggle = useCallback((picked: string) => {
    const current = latest.current;
    current.onValuesChange(current.values.includes(picked)
      ? current.values.filter((value) => value !== picked)
      : [...current.values, picked]);
  }, []);
  // The names in the order they were chosen. The whole text stays in the page; only its look is cut off.
  const selectedLabels = values.flatMap((value) => {
    const option = options.find((candidate) => candidate.value === value);
    return option ? [option.label] : [];
  });
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <ComboboxTrigger ref={triggerRef} label={label} open={open} disabled={disabled} text={selectedLabels.join('、')} placeholder={placeholder} />
      <ComboboxPanel
        layer={layer}
        open={open}
        triggerRef={triggerRef}
        onLeave={() => setOpen(false)}
        options={options}
        isSelected={(candidate) => values.includes(candidate)}
        onPick={toggle}
        label={label}
        searchPlaceholder={searchPlaceholder}
        emptyText={emptyText}
        multiple
      />
    </PopoverPrimitive.Root>
  );
}
