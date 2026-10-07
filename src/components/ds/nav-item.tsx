import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { oncePerPress } from './heldKey';
import { Icon } from './icon';
import { DISABLED, FOCUS_RING } from './styles';

// A sidebar row. The selected row gets the 7% gray fill and nothing else.
// It acts once per press of Enter or Space (heldKey.ts).
export function NavItem({ label, icon, selected = false, trailing, className, type = 'button', onKeyDown, ...props }:
  Omit<ComponentProps<'button'>, 'children'> & {
    label: ReactNode;
    icon?: LucideIcon;
    selected?: boolean;
    trailing?: ReactNode;
  }) {
  return (
    <button
      type={type}
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'flex h-7 w-full items-center gap-2 rounded-control px-2 text-left text-ui text-label transition-colors duration-fast',
        selected ? 'bg-fill-selected' : 'hover:bg-fill-hover',
        FOCUS_RING,
        DISABLED,
        className,
      )}
      {...props}
      onKeyDown={oncePerPress(onKeyDown)}
    >
      {icon && <Icon icon={icon} className={selected ? 'text-label' : 'text-label-secondary'} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing !== undefined && <span className="shrink-0 text-ui-sm text-label-tertiary">{trailing}</span>}
    </button>
  );
}
