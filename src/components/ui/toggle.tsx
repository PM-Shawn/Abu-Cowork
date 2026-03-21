import { cn } from '@/lib/utils';

interface ToggleProps {
  checked: boolean;
  onChange: () => void;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  className?: string;
}

const sizeConfig = {
  sm:  { track: 'h-4 w-7',  thumb: 'h-3 w-3',     on: 'translate-x-3.5', off: 'translate-x-0.5' },
  md:  { track: 'h-5 w-9',  thumb: 'h-3.5 w-3.5', on: 'translate-x-4.5', off: 'translate-x-0.5' },
  lg:  { track: 'h-6 w-10', thumb: 'h-5 w-5',     on: 'translate-x-4',   off: 'translate-x-0.5' },
};

export function Toggle({ checked, onChange, size = 'sm', disabled, className }: ToggleProps) {
  const s = sizeConfig[size];

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      className={cn(
        'relative inline-flex items-center rounded-full transition-colors shrink-0',
        s.track,
        checked ? 'bg-[var(--abu-clay)]' : 'bg-[var(--abu-bg-pressed)]',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 inline-block rounded-full bg-white shadow-sm transition-transform',
          s.thumb,
          checked ? s.on : s.off
        )}
      />
    </button>
  );
}
