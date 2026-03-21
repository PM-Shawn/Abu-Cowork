import * as React from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectOption {
  value: string;
  label: string;
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
  /** 'default' = full-width form field, 'inline' = compact for settings rows */
  variant?: 'default' | 'inline';
  className?: string;
}

export function Select({ value, onChange, options, placeholder, variant = 'default', className }: SelectProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const allOptions = flattenOptions(options);
  const selectedOption = allOptions.find((opt) => opt.value === value);
  const isInline = variant === 'inline';

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
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
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
        'w-full px-3 py-2 text-sm text-left transition-colors',
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
    </button>
  );

  return (
    <div ref={containerRef} className={cn('relative', !isInline && 'w-full', className)}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-2 rounded-lg border border-[var(--abu-border)] text-sm text-left transition-all',
          'focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)]',
          'hover:border-[var(--abu-border-hover)]',
          open && 'ring-2 ring-[var(--abu-clay-ring)] border-[var(--abu-clay)]',
          isInline
            ? 'px-3 py-1.5 bg-[var(--abu-bg-base)]'
            : 'w-full h-9 px-3 justify-between bg-[var(--abu-bg-muted)]',
        )}
      >
        <span className={cn(!selectedOption ? 'text-[var(--abu-text-placeholder)]' : 'text-[var(--abu-text-primary)]')}>
          {selectedOption?.label ?? placeholder ?? '...'}
        </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 text-[var(--abu-text-muted)] transition-transform shrink-0',
            open && 'rotate-180'
          )}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div className={cn(
          'absolute z-50 top-full mt-1 py-1 bg-white border border-[var(--abu-border)] rounded-xl shadow-lg max-h-60 overflow-auto',
          isInline ? 'right-0 min-w-[140px]' : 'left-0 right-0',
        )}>
          {isGrouped(options) ? (
            options.map((group, gi) => (
              <div key={group.label}>
                {gi > 0 && <div className="my-1 border-t border-[var(--abu-border)]" />}
                <div className="px-3 py-1.5 text-xs font-medium text-[var(--abu-text-muted)] select-none">
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
