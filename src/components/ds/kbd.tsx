import type { ReactNode } from 'react';

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-control border border-separator bg-fill px-1 font-code text-ui-sm text-label-secondary">
      {children}
    </kbd>
  );
}
