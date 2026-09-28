import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from './confirm-dialog';
import { ConfirmContext, type Confirm, type ConfirmOptions } from './confirm-context';

interface Pending {
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const confirm = useCallback<Confirm>((options) => new Promise<boolean>((resolve) => {
    pendingRef.current?.resolve(false);
    const next = { options, resolve };
    pendingRef.current = next;
    setPending(next);
  }), []);

  const settle = (confirmed: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    if (!current) throw new Error('No confirmation is pending');
    current.resolve(confirmed);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmDialog
          open
          title={pending.options.title}
          message={pending.options.message}
          confirmLabel={pending.options.confirmLabel}
          tone={pending.options.tone}
          onResult={settle}
        />
      )}
    </ConfirmContext.Provider>
  );
}
