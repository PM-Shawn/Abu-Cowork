import { Switch as SwitchPrimitive } from 'radix-ui';
import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { dropsHeldRepeat } from './heldKey';
import { BUSY, DISABLED, FOCUS_RING } from './styles';

export function Switch({ checked, onCheckedChange, label, disabled, busy = false, id, 'aria-label': ariaLabel }: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  // Its own action is running: it keeps the keyboard focus and acts on no press until that ends.
  busy?: boolean;
  id?: string;
  // The name of a switch that has no visible label and no SettingRow title pointing at it.
  'aria-label'?: string;
}) {
  const autoId = useId();
  const switchId = id ?? autoId;
  return (
    <span className="inline-flex items-center gap-2">
      <SwitchPrimitive.Root
        id={switchId}
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        aria-disabled={busy || undefined}
        onCheckedChange={busy ? () => undefined : onCheckedChange}
        // The click of a busy switch ends on the switch: nothing changes, and a card or a row it
        // sits on does not act on a press that was meant for the switch (see Button busy).
        onClick={busy ? (event) => { event.preventDefault(); event.stopPropagation(); } : undefined}
        // One change per press: the repeats of a held Enter or Space are dropped (heldKey.ts).
        onKeyDown={dropsHeldRepeat}
        className={cn('inline-flex h-5 w-8 shrink-0 items-center rounded-full bg-fill-pressed transition-colors duration-fast data-[state=checked]:bg-emphasis', FOCUS_RING, DISABLED, BUSY)}
      >
        <SwitchPrimitive.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-on-emphasis shadow-panel transition-transform duration-fast data-[state=checked]:translate-x-3.5" />
      </SwitchPrimitive.Root>
      {label && <label htmlFor={switchId} className="text-ui text-label">{label}</label>}
    </span>
  );
}
