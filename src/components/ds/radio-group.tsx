import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { DISABLED, FOCUS_RING } from './styles';

export interface ChoiceOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export function RadioGroup({ value, onValueChange, options, label, orientation = 'vertical' }: {
  value: string;
  onValueChange: (value: string) => void;
  options: ChoiceOption[];
  label: string;
  orientation?: 'horizontal' | 'vertical';
}) {
  const baseId = useId();
  return (
    <RadioGroupPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      aria-label={label}
      orientation={orientation}
      className={cn('flex', orientation === 'vertical' ? 'flex-col gap-2' : 'flex-row gap-4')}
    >
      {options.map((option) => {
        const optionId = `${baseId}-${option.value}`;
        return (
          <span key={option.value} className="inline-flex items-center gap-2">
            <RadioGroupPrimitive.Item
              id={optionId}
              value={option.value}
              disabled={option.disabled}
              className={cn('inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-control-border bg-field data-[state=checked]:border-emphasis', FOCUS_RING, DISABLED)}
            >
              <RadioGroupPrimitive.Indicator className="h-2 w-2 rounded-full bg-emphasis" />
            </RadioGroupPrimitive.Item>
            <label htmlFor={optionId} className="text-ui text-label">{option.label}</label>
          </span>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}
