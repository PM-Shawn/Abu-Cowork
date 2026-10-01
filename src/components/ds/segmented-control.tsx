import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { FOCUS_RING } from './styles';

export interface SegmentOption {
  value: string;
  label: ReactNode;
  icon?: LucideIcon;
}

// A mutually exclusive choice that is always set (e.g. System / Light / Dark).
export function SegmentedControl({ value, onValueChange, options, label }: {
  value: string;
  onValueChange: (value: string) => void;
  options: SegmentOption[];
  label: string;
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      onValueChange={(next) => { if (next) onValueChange(next); }}
      aria-label={label}
      className="inline-flex h-7 items-center gap-1 rounded-control bg-fill p-1"
    >
      {options.map((option) => (
        <ToggleGroupPrimitive.Item
          key={option.value}
          value={option.value}
          className={cn('inline-flex h-5 items-center gap-1 rounded-control px-3 text-ui text-label-secondary transition-colors duration-fast hover:text-label data-[state=on]:bg-raised data-[state=on]:text-label data-[state=on]:shadow-panel', FOCUS_RING)}
        >
          {option.icon && <Icon icon={option.icon} size="sm" />}
          {option.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
}
