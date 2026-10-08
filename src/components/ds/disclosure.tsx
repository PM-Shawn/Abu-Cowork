import { Collapsible as CollapsiblePrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { dropsHeldRepeat } from './heldKey';
import { Icon } from './icon';
import { AppIcons } from './icons';
import { FOCUS_RING } from './styles';

export function Disclosure({ title, children, open, defaultOpen = false, onOpenChange }: {
  title: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <CollapsiblePrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {/* One change per press: the repeats of a held Enter or Space are dropped (heldKey.ts). */}
      <CollapsiblePrimitive.Trigger onKeyDown={dropsHeldRepeat} className={cn('group flex h-7 w-full items-center gap-1 rounded-control text-left text-ui font-medium text-label', FOCUS_RING)}>
        <Icon icon={AppIcons.disclose} size="sm" className="text-label-secondary transition-transform duration-fast group-data-[state=open]:rotate-90" />
        {title}
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content
        data-ds-motion
        className="overflow-hidden duration-base data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down"
      >
        <div className="pb-2 pl-5 pt-1">{children}</div>
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}
