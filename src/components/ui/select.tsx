import * as React from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectOption {
  value: string;
  label: string;
  /** One-line explanation of what picking this option means, rendered under
   *  the label INSIDE the menu. Chosen over a trigger-side ⓘ/tooltip because a
   *  hover affordance is undiscoverable on desktop — the explanation has to be
   *  where the choice is made. The trigger keeps showing the bare label. */
  description?: string;
  /**
   * Listed but not choosable. Use it when a tier exists in the vocabulary and
   * is deliberately WITHDRAWN here: dropping the option silently leaves the
   * user asking why a choice they have seen elsewhere is missing, while
   * offering it live would promise something the gate refuses to honor. The
   * `description` is the place to say why it cannot be picked.
   */
  disabled?: boolean;
}

export interface SelectOptionGroup {
  label: string;
  options: SelectOption[];
}

/** Check if options array contains groups */
function isGrouped(options: SelectOption[] | SelectOptionGroup[]): options is SelectOptionGroup[] {
  return options.length > 0 && 'options' in options[0];
}

/** Flatten grouped options into a flat list for lookup */
function flattenOptions(options: SelectOption[] | SelectOptionGroup[]): SelectOption[] {
  if (isGrouped(options)) {
    return options.flatMap((g) => g.options);
  }
  return options;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[] | SelectOptionGroup[];
  placeholder?: string;
  /** Programmatic field label for screen readers. */
  ariaLabel?: string;
  /** 'default' = full-width form field, 'inline' = compact boxed settings row,
   *  'ghost' = borderless value + small chevron (iOS-style quick-setting row) */
  variant?: 'default' | 'inline' | 'ghost';
  /** Renders the trigger as inert (dimmed, not focusable, cannot open). Use
   *  when a setting exists but is currently overridden by another control —
   *  hiding it would lose the explanation, leaving it live would let the user
   *  change something that does nothing. */
  disabled?: boolean;
  className?: string;
}

/** Gap between the trigger and its menu, in px. */
const MENU_OFFSET = 4;
/** Matches the old `max-h-60`; the menu shrinks below it near a viewport edge. */
const MENU_MAX_HEIGHT = 240;
/** Above `CapabilitySetupDialog` (`z-[10000]`), which is itself above the
 *  settings dialog. A menu that renders under the surface that opened it is
 *  not a menu, and the same rule holds for every dialog in the app — which is
 *  why this lives here once instead of at each call site. */
const MENU_Z_INDEX = 10001;

export function Select({ value, onChange, options, placeholder, ariaLabel, variant = 'default', disabled = false, className }: SelectProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = React.useState<React.CSSProperties>();
  const dropdownId = React.useId();

  const allOptions = flattenOptions(options);
  const selectedOption = allOptions.find((opt) => opt.value === value);
  const hasDescriptions = allOptions.some((opt) => opt.description);
  const isInline = variant === 'inline';
  const isGhost = variant === 'ghost';
  /** Inline and ghost triggers are settings-row sized; their menu is wider
   *  than the trigger and hangs off its right edge. */
  const menuHugsTrigger = !isInline && !isGhost;

  React.useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  /**
   * The menu is rendered into `document.body`, so its position has to be
   * computed from the trigger instead of inherited from it. Anchored to the
   * viewport (`position: fixed`), flipped above the trigger when the space
   * below cannot hold it, and re-measured on scroll/resize while open.
   */
  const positionMenu = React.useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportHeight = window.innerHeight || 0;
    const viewportWidth = window.innerWidth || 0;
    const spaceBelow = viewportHeight - rect.bottom - MENU_OFFSET;
    const spaceAbove = rect.top - MENU_OFFSET;
    // The menu is mounted before this layout effect runs, so it can be
    // measured. `scrollHeight` rather than `offsetHeight` because a later pass
    // (scroll, resize) sees a menu already clamped by `maxHeight`, and the
    // question is always how tall it WANTS to be.
    const menu = menuRef.current;
    const naturalHeight = menu ? Math.max(menu.offsetHeight, menu.scrollHeight) : 0;
    const flip = naturalHeight > spaceBelow && spaceAbove > spaceBelow;
    const available = Math.max(flip ? spaceAbove : spaceBelow, 0);
    const style: React.CSSProperties = {
      position: 'fixed',
      zIndex: MENU_Z_INDEX,
      maxHeight: Math.min(MENU_MAX_HEIGHT, available || MENU_MAX_HEIGHT),
    };
    if (flip) {
      style.bottom = viewportHeight - rect.top + MENU_OFFSET;
    } else {
      style.top = rect.bottom + MENU_OFFSET;
    }
    if (menuHugsTrigger) {
      style.left = rect.left;
      style.width = rect.width;
    } else {
      // Right-aligned to the trigger, as the old `absolute right-0` was.
      style.right = Math.max(viewportWidth - rect.right, 0);
    }
    setMenuStyle(style);
  }, [menuHugsTrigger]);

  React.useLayoutEffect(() => {
    if (!open) {
      setMenuStyle(undefined);
      return;
    }
    positionMenu();
    // Capture phase so a scrolling ANCESTOR (every settings pane is one) is
    // seen too — scroll does not bubble.
    window.addEventListener('resize', positionMenu);
    document.addEventListener('scroll', positionMenu, true);
    return () => {
      window.removeEventListener('resize', positionMenu);
      document.removeEventListener('scroll', positionMenu, true);
    };
  }, [open, positionMenu]);

  React.useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // The menu is no longer a descendant of the container, so "outside" has
      // to mean outside BOTH or every click on an option would close the menu
      // before the option's own handler ran.
      if (containerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    // Capture phase: an ancestor may stopPropagation() on mousedown in the
    // bubble phase (e.g. a modal backdrop that disables click-to-close), which
    // would otherwise silently kill outside-click detection. Capture fires
    // top-down before any such handler runs.
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  /** Focusable options, in visual order. Disabled ones are not among them. */
  const focusableOptions = React.useCallback(
    () => Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [],
    ),
    [],
  );

  /**
   * Keyboard reach. While the menu lived inside the trigger's own DOM, Tab
   * walked straight into it; a portalled menu sits at the end of `body`, so
   * the options have to be reachable another way or the control stops being
   * keyboard-operable. Arrow keys move between options, Escape returns to the
   * trigger (see the Escape handler above), and Tab closes the menu so focus
   * continues from the trigger's place in the page.
   */
  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = focusableOptions();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown'
      ? (current + 1 + items.length) % items.length
      : (current <= 0 ? items.length : current) - 1;
    items[next]?.focus();
  };

  const openMenu = (focusOption: boolean) => {
    setOpen(true);
    if (!focusOption) return;
    // After the menu has mounted and been positioned.
    requestAnimationFrame(() => {
      const items = focusableOptions();
      const selectedIndex = items.findIndex((item) => item.dataset.value === value);
      items[selectedIndex >= 0 ? selectedIndex : 0]?.focus();
    });
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (open) {
      focusableOptions()[0]?.focus();
      return;
    }
    openMenu(true);
  };

  const renderOption = (opt: SelectOption) => (
    <button
      key={opt.value}
      type="button"
      data-value={opt.value}
      disabled={opt.disabled}
      onClick={() => {
        onChange(opt.value);
        setOpen(false);
        triggerRef.current?.focus();
      }}
      className={cn(
        'w-full px-3 py-2 text-body text-left transition-colors',
        opt.disabled
          ? 'cursor-not-allowed opacity-60'
          : 'hover:bg-[var(--abu-bg-muted)]',
        !opt.disabled && opt.value === value
          ? 'text-[var(--abu-clay)] bg-[var(--abu-clay-bg)]'
          : 'text-[var(--abu-text-primary)]'
      )}
    >
      {isInline ? (
        opt.label
      ) : (
        <span className="inline-flex items-center gap-2">
          <span className="w-4 shrink-0">
            {!opt.disabled && opt.value === value && (
              <Check className="h-4 w-4 text-[var(--abu-clay)]" />
            )}
          </span>
          {opt.label}
        </span>
      )}
      {opt.description && (
        <span
          className={cn(
            'mt-0.5 block text-minor leading-relaxed',
            !isInline && 'pl-6',
            !opt.disabled && opt.value === value
              ? 'text-[var(--abu-clay)]'
              : 'text-[var(--abu-text-muted)]',
          )}
        >
          {opt.description}
        </span>
      )}
    </button>
  );

  return (
    <div ref={containerRef} className={cn('relative', menuHugsTrigger && 'w-full', className)}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel ? `${ariaLabel}: ${selectedOption?.label ?? placeholder ?? '...'}` : undefined}
        aria-expanded={open}
        aria-controls={dropdownId}
        disabled={disabled}
        // `detail === 0` means the click came from Enter/Space, not a pointer.
        // A keyboard user used to Tab straight into the menu; now that it is
        // portalled, opening from the keyboard puts focus there instead.
        onClick={(e) => (open ? setOpen(false) : openMenu(e.detail === 0))}
        onKeyDown={handleTriggerKeyDown}
        className={cn(
          'flex items-center text-body text-left transition-all',
          disabled && 'cursor-not-allowed opacity-50',
          isGhost
            ? 'gap-1 text-body focus:outline-none'
            : cn(
                'gap-2 rounded-lg border border-[var(--abu-border)]',
                'focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]',
                'hover:border-[var(--abu-border-hover)]',
                open && 'ring-2 ring-[var(--abu-clay-ring)] border-[var(--abu-clay)]',
                isInline
                  // `w-full` so a width class on the wrapper (settings groups
                  // set one so every control in the group matches) actually
                  // reaches the box the user sees; without it the trigger is
                  // content-sized and two options of different lengths render
                  // two different widths inside identically-sized wrappers.
                  ? 'w-full justify-between px-3 py-1.5 bg-[var(--abu-bg-base)]'
                  : 'w-full h-9 px-3 justify-between bg-[var(--abu-bg-muted)]',
              ),
        )}
      >
        <span className={cn(
          !selectedOption
            ? 'text-[var(--abu-text-placeholder)]'
            : isGhost ? 'text-[var(--abu-text-tertiary)]' : 'text-[var(--abu-text-primary)]'
        )}>
          {selectedOption?.label ?? placeholder ?? '...'}
        </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 text-[var(--abu-text-muted)] transition-transform shrink-0',
            open && 'rotate-180'
          )}
        />
      </button>

      {/*
        Rendered into `document.body`, NOT as an absolutely-positioned child.
        Inside the flow it was clipped by whatever card came next — a menu that
        the following card paints over is unreadable, and raising a z-index at
        the call site cannot fix it, because z-index only orders siblings
        within the same stacking context. Only leaving the context does.

        Width: an inline/ghost menu is shrink-to-fit, so its min-width is what
        actually decides how wide it lands. Options that carry a description
        need more room than any settings-row trigger is ever going to be, so
        they raise that floor.
      */}
      {open && createPortal(
        <div
          ref={menuRef}
          id={dropdownId}
          onKeyDown={handleMenuKeyDown}
          style={menuStyle}
          className={cn(
            'fixed py-1 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-xl shadow-lg overflow-auto',
            !menuHugsTrigger && (hasDescriptions ? 'min-w-[240px]' : 'min-w-[140px]'),
          )}
        >
          {isGrouped(options) ? (
            options.map((group, gi) => (
              <div key={group.label}>
                {gi > 0 && <div className="my-1 border-t border-[var(--abu-border)]" />}
                <div className="px-3 py-1.5 text-minor font-medium text-[var(--abu-text-muted)] select-none">
                  {group.label}
                </div>
                {group.options.map(renderOption)}
              </div>
            ))
          ) : (
            options.map(renderOption)
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
