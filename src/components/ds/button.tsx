import type { ComponentProps } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buttonVariants, iconButtonVariants, type ButtonVariant, type ControlSize } from './button-variants';
import { Icon } from './icon';
import { Tooltip } from './tooltip';

export function Button({ variant, size, icon, busy = false, className, children, type = 'button', onClick, ...props }: ComponentProps<'button'> & {
  variant?: ButtonVariant;
  size?: ControlSize;
  icon?: LucideIcon;
  // The action this button started is still running. It looks disabled and takes no press, and
  // it stays focusable: a button disabled under the keyboard would lose the focus.
  busy?: boolean;
}) {
  return (
    <button
      type={type}
      aria-disabled={busy || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
      onClick={busy ? (event) => event.preventDefault() : onClick}
    >
      {icon && <Icon icon={icon} size="sm" />}
      {children}
    </button>
  );
}

// Icon-only buttons must be named; the same words show as the hover tooltip.
export function IconButton({ icon, label, variant, size = 'md', busy = false, pressedFill = true, tooltipSide = 'top', className, type = 'button', onClick, ...props }:
  Omit<ComponentProps<'button'>, 'children' | 'aria-label'> & {
    icon: LucideIcon;
    label: string;
    variant?: 'plain' | 'secondary' | 'primary';
    size?: ControlSize;
    // The action this button started is still running (see Button busy).
    busy?: boolean;
    // false: a toggle with aria-pressed keeps the plain look (its icon shows the state).
    pressedFill?: boolean;
    // Where the tooltip opens. A toolbar that sits right under other controls opens it below.
    tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
  }) {
  return (
    <Tooltip content={label} side={tooltipSide}>
      <button
        type={type}
        aria-label={label}
        aria-disabled={busy || undefined}
        className={cn(iconButtonVariants({ variant, size, pressedFill }), className)}
        {...props}
        onClick={busy ? (event) => event.preventDefault() : onClick}
      >
        <Icon icon={icon} size={size === 'sm' ? 'sm' : 'md'} />
      </button>
    </Tooltip>
  );
}
