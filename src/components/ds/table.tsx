import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Align = 'left' | 'right';

export function Table({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-panel border border-separator">
      <table aria-label={label} className="w-full border-collapse text-ui">{children}</table>
    </div>
  );
}

export function TableHeader({ children }: { children: ReactNode }) {
  return <thead className="bg-code">{children}</thead>;
}

export function TableBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function TableRow({ children }: { children: ReactNode }) {
  return <tr className="border-t border-separator first:border-t-0">{children}</tr>;
}

export function TableHead({ children, align = 'left' }: { children: ReactNode; align?: Align }) {
  return <th scope="col" className={cn('h-7 px-3 font-medium text-label-secondary', align === 'right' ? 'text-right' : 'text-left')}>{children}</th>;
}

export function TableCell({ children, align = 'left' }: { children: ReactNode; align?: Align }) {
  return <td className={cn('h-7 px-3 text-label', align === 'right' ? 'text-right' : 'text-left')}>{children}</td>;
}
