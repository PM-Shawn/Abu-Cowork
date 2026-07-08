import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Checkbox({
  checked,
  onChange,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'inline-flex items-center justify-center h-4 w-4 rounded border transition-colors shrink-0',
        checked
          ? 'bg-[var(--abu-clay)] border-[var(--abu-clay)] text-white'
          : 'bg-transparent border-[var(--abu-border)] hover:border-[var(--abu-clay)]',
        disabled && 'opacity-50 cursor-not-allowed',
        className,
      )}
    >
      {checked && <Check className="h-3 w-3" strokeWidth={3} />}
    </button>
  );
}
