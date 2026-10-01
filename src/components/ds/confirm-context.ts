import { createContext, useContext } from 'react';

export interface ConfirmOptions {
  title: string;
  message?: string;
  // The specific action, e.g. "Delete" — never "OK".
  confirmLabel: string;
  tone?: 'default' | 'danger';
}

export type Confirm = (options: ConfirmOptions) => Promise<boolean>;

export const ConfirmContext = createContext<Confirm | null>(null);

// Replaces window.confirm(): resolves true when the user picks the action, false on
// Cancel, Escape, or when another confirmation replaces this one.
export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm() must be called inside <DesignSystemProvider>.');
  return confirm;
}
