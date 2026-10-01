import { Tabs as TabsPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { DISABLED, FOCUS_RING } from './styles';

export function Tabs({ value, defaultValue, onValueChange, children }: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
}) {
  return <TabsPrimitive.Root value={value} defaultValue={defaultValue} onValueChange={onValueChange}>{children}</TabsPrimitive.Root>;
}

export function TabList({ label, children }: { label: string; children: ReactNode }) {
  return <TabsPrimitive.List aria-label={label} className="flex gap-4 border-b border-separator">{children}</TabsPrimitive.List>;
}

export function Tab({ value, children, disabled }: { value: string; children: ReactNode; disabled?: boolean }) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      disabled={disabled}
      className={cn('-mb-px h-8 border-b-2 border-transparent text-ui text-label-secondary transition-colors duration-fast hover:text-label data-[state=active]:border-emphasis data-[state=active]:text-label', FOCUS_RING, DISABLED)}
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}

export function TabPanel({ value, children }: { value: string; children: ReactNode }) {
  return <TabsPrimitive.Content value={value} className={cn('pt-4', FOCUS_RING)}>{children}</TabsPrimitive.Content>;
}
