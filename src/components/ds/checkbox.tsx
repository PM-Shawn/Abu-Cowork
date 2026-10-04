import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { AppIcons } from './icons';
import { DISABLED, FOCUS_RING } from './styles';

export function Checkbox({ checked, onCheckedChange, label, disabled, id, 'aria-describedby': describedBy }: {
  checked: boolean | 'indeterminate';
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
  // The id of the text that explains the box, when the page shows one beside it.
  'aria-describedby'?: string;
}) {
  const autoId = useId();
  const boxId = id ?? autoId;
  return (
    <span className="inline-flex items-center gap-2">
      <CheckboxPrimitive.Root
        id={boxId}
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        className={cn(
          'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-control border border-control-border bg-field text-on-emphasis data-[state=checked]:border-emphasis data-[state=checked]:bg-emphasis data-[state=indeterminate]:border-emphasis data-[state=indeterminate]:bg-emphasis',
          FOCUS_RING,
          DISABLED,
        )}
      >
        <CheckboxPrimitive.Indicator>
          <Icon icon={checked === 'indeterminate' ? AppIcons.mixed : AppIcons.done} size="sm" />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      {label && <label htmlFor={boxId} className="text-ui text-label">{label}</label>}
    </span>
  );
}
