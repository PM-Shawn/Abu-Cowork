import type { ComponentProps } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buttonVariants, iconButtonVariants, type ButtonVariant, type ControlSize } from './button-variants';
import { Icon } from './icon';
import { Tooltip } from './tooltip';

export function Button({ variant, size, icon, className, children, type = 'button', ...props }: ComponentProps<'button'> & {
  variant?: ButtonVariant;
  size?: ControlSize;
  icon?: LucideIcon;
}) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props}>
      {icon && <Icon icon={icon} size="sm" />}
      {children}
    </button>
  );
}

// Icon-only buttons must be named; the same words show as the hover tooltip.
export function IconButton({ icon, label, variant, size = 'md', pressedFill = true, className, type = 'button', ...props }:
  Omit<ComponentProps<'button'>, 'children' | 'aria-label'> & {
    icon: LucideIcon;
    label: string;
    variant?: 'plain' | 'secondary' | 'primary';
    size?: ControlSize;
    // false: a toggle with aria-pressed keeps the plain look (its icon shows the state).
    pressedFill?: boolean;
  }) {
  return (
    <Tooltip content={label}>
      <button type={type} aria-label={label} className={cn(iconButtonVariants({ variant, size, pressedFill }), className)} {...props}>
        <Icon icon={icon} size={size === 'sm' ? 'sm' : 'md'} />
      </button>
    </Tooltip>
  );
}
