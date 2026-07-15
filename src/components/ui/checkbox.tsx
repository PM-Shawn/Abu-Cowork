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
      onClick={(e) => {
        // Stop the click from reaching a surrounding clickable row/label.
        // In WKWebView (macOS Tauri) a wrapping <label> re-dispatches its click
        // to this button even when the button was the target, which toggled
        // twice and cancelled out — the box appeared unclickable.
        e.stopPropagation();
        onChange();
      }}
      className={cn(
        'inline-flex items-center justify-center h-4 w-4 rounded border transition-colors shrink-0',
        checked
          ? 'bg-[var(--abu-clay)] border-[var(--abu-clay)] text-white'
          // Solid surface fill (not transparent): --abu-border ≈ --abu-bg-hover,
          // so a transparent box vanishes into a hovered row. A base-bg fill
          // keeps the empty box visible on any surface.
          : 'bg-[var(--abu-bg-base)] border-[var(--abu-border)] hover:border-[var(--abu-clay)]',
        disabled && 'opacity-50 cursor-not-allowed',
        className,
      )}
    >
      {checked && <Check className="h-3 w-3" strokeWidth={3} />}
    </button>
  );
}
