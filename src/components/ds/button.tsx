import type { ComponentProps, MouseEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buttonVariants, iconButtonVariants, type ButtonVariant, type ControlSize } from './button-variants';
import { oncePerPress } from './heldKey';
import { Icon } from './icon';
import { Tooltip } from './tooltip';

// The click of a busy button ends on the button: it starts nothing (a submit button submits no
// form) and goes on to no element around it, so a card or a row the button sits on does not act
// on a press that was meant for the button. Also for the click a key or a screen reader makes.
function swallowClick(event: MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
  event.stopPropagation();
}

// Button and IconButton act once per press: the repeats of a held Enter or Space are dropped
// before the browser makes a click from them, and before the caller's key handler (heldKey.ts).
export function Button({ variant, size, icon, busy = false, className, children, type = 'button', onClick, onKeyDown, ...props }: ComponentProps<'button'> & {
  variant?: ButtonVariant;
  size?: ControlSize;
  icon?: LucideIcon;
  // The action this button started is still running. It looks disabled and acts on no press, and
  // it stays focusable: a button disabled under the keyboard would lose the focus. A press still
  // lands on it and ends there.
  busy?: boolean;
}) {
  return (
    <button
      type={type}
      aria-disabled={busy || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
      onClick={busy ? swallowClick : onClick}
      onKeyDown={oncePerPress(onKeyDown)}
    >
      {icon && <Icon icon={icon} size="sm" />}
      {children}
    </button>
  );
}

// Icon-only buttons must be named; the same words show as the hover tooltip.
export function IconButton({ icon, label, variant, size = 'md', busy = false, pressedFill = true, tooltipSide = 'top', className, type = 'button', onClick, onKeyDown, ...props }:
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
        onClick={busy ? swallowClick : onClick}
        onKeyDown={oncePerPress(onKeyDown)}
      >
        <Icon icon={icon} size={size === 'sm' ? 'sm' : 'md'} />
      </button>
    </Tooltip>
  );
}
