import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { FOCUS_RING, SEGMENT_SELECTED, SEGMENT_TRACK } from './styles';

export interface SegmentOption {
  value: string;
  label: ReactNode;
  icon?: LucideIcon;
}

// A mutually exclusive choice that is always set (e.g. System / Light / Dark).
export function SegmentedControl({ value, onValueChange, options, label, fullWidth = false }: {
  value: string;
  onValueChange: (value: string) => void;
  options: SegmentOption[];
  label: string;
  // Fills the width it is given and shares it equally among the options, each on one line:
  // for a row of four in a narrow window, where the usual side padding would not fit.
  fullWidth?: boolean;
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      onValueChange={(next) => { if (next) onValueChange(next); }}
      aria-label={label}
      className={cn('h-7 items-center gap-1 rounded-control p-1', SEGMENT_TRACK, fullWidth ? 'flex w-full' : 'inline-flex')}
    >
      {options.map((option) => (
        <ToggleGroupPrimitive.Item
          key={option.value}
          value={option.value}
          className={cn('inline-flex h-5 items-center gap-1 rounded-control px-3 text-ui text-label-secondary transition-colors duration-fast hover:text-label data-[state=on]:text-label', SEGMENT_SELECTED, fullWidth && 'min-w-0 flex-1 justify-center whitespace-nowrap px-1', FOCUS_RING)}
        >
          {option.icon && <Icon icon={option.icon} size="sm" />}
          {option.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
}
