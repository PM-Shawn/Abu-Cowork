import { Slider as SliderPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import { FOCUS_RING } from './styles';

export function Slider({ value, onValueChange, label, min = 0, max = 100, step = 1, disabled }: {
  value: number;
  onValueChange: (value: number) => void;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <SliderPrimitive.Root
      value={[value]}
      onValueChange={(values) => onValueChange(values[0])}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className="relative flex h-5 w-full touch-none select-none items-center data-[disabled]:opacity-40"
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-fill-pressed">
        <SliderPrimitive.Range className="absolute h-full bg-emphasis" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb aria-label={label} className={cn('block h-4 w-4 rounded-full border border-control-border bg-raised shadow-panel', FOCUS_RING)} />
    </SliderPrimitive.Root>
  );
}
