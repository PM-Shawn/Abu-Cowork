import * as React from 'react';
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

export function Select({ value, onChange, options, placeholder, ariaLabel, variant = 'default', disabled = false, className }: SelectProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const dropdownId = React.useId();

  const allOptions = flattenOptions(options);
  const selectedOption = allOptions.find((opt) => opt.value === value);
  const hasDescriptions = allOptions.some((opt) => opt.description);
  const isInline = variant === 'inline';
  const isGhost = variant === 'ghost';

  React.useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  React.useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
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

  const renderOption = (opt: SelectOption) => (
    <button
      key={opt.value}
      type="button"
      onClick={() => {
        onChange(opt.value);
        setOpen(false);
      }}
      className={cn(
        'w-full px-3 py-2 text-body text-left transition-colors',
        'hover:bg-[var(--abu-bg-muted)]',
        opt.value === value
          ? 'text-[var(--abu-clay)] bg-[var(--abu-clay-bg)]'
          : 'text-[var(--abu-text-primary)]'
      )}
    >
      {isInline ? (
        opt.label
      ) : (
        <span className="inline-flex items-center gap-2">
          <span className="w-4 shrink-0">
            {opt.value === value && <Check className="h-4 w-4 text-[var(--abu-clay)]" />}
          </span>
          {opt.label}
        </span>
      )}
      {opt.description && (
        <span
          className={cn(
            'mt-0.5 block text-minor leading-relaxed',
            !isInline && 'pl-6',
            opt.value === value
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
    <div ref={containerRef} className={cn('relative', !isInline && !isGhost && 'w-full', className)}>
      {/* Trigger */}
      <button
        type="button"
        aria-label={ariaLabel ? `${ariaLabel}: ${selectedOption?.label ?? placeholder ?? '...'}` : undefined}
        aria-expanded={open}
        aria-controls={dropdownId}
        disabled={disabled}
        onClick={() => setOpen(!open)}
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

      {/* Dropdown.
          Width: an inline/ghost menu is shrink-to-fit inside the trigger's own
          positioning box, so its min-width is what actually decides how wide it
          lands. Options that carry a description need more room than any
          settings-row trigger is ever going to be, so they raise that floor. */}
      {open && (
        <div id={dropdownId} className={cn(
          'absolute z-50 top-full mt-1 py-1 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-xl shadow-lg max-h-60 overflow-auto',
          (isInline || isGhost)
            ? cn('right-0', hasDescriptions ? 'min-w-[240px]' : 'min-w-[140px]')
            : 'left-0 right-0',
        )}>
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
        </div>
      )}
    </div>
  );
}
