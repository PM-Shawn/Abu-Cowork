import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from './confirm-dialog';
import { ConfirmContext, type Confirm, type ConfirmOptions } from './confirm-context';

interface Pending {
  // Counts the questions: each one has a window of its own.
  id: number;
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
  // It took the place of a question that was on screen.
  replaced: boolean;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const count = useRef(0);
  // What had the focus before the first of the questions that followed each other on screen. A
  // window that takes the place of another opens while the first is leaving with the focus in
  // it, so it cannot tell by itself where the focus was before the questions.
  const returnTo = useRef<HTMLElement | null>(null);
  const stopWatching = useRef<(() => void) | null>(null);
  // From the moment the first question is asked until its window takes the focus, the focus may
  // still move on the page (a menu that asked from its close hook hands the focus to its
  // trigger afterwards): the last place it was at is the place to return to.
  const watchFocusUntilTheQuestionHasIt = useCallback(() => {
    stopWatching.current?.();
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onFocus = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      if (event.target.closest('[data-ds-layer][role="alertdialog"]')) stopWatching.current?.();
      else returnTo.current = event.target;
    };
    document.addEventListener('focusin', onFocus, true);
    stopWatching.current = () => {
      document.removeEventListener('focusin', onFocus, true);
      stopWatching.current = null;
    };
  }, []);

  // A request still open when the provider goes away is answered like Cancel.
  useEffect(() => () => {
    stopWatching.current?.();
    pendingRef.current?.resolve(false);
    pendingRef.current = null;
  }, []);

  // A question that replaces another is not drawn into the first one's window: it would inherit
  // the focus, and Enter meant for the first question's confirming button would answer the second.
  // Each question is keyed, so it opens fresh, on its cancelling button.
  const confirm = useCallback<Confirm>((options) => new Promise<boolean>((resolve) => {
    const earlier = pendingRef.current;
    earlier?.resolve(false);
    if (!earlier) watchFocusUntilTheQuestionHasIt();
    count.current += 1;
    const next = { id: count.current, options, resolve, replaced: earlier !== null };
    pendingRef.current = next;
    setPending(next);
  }), [watchFocusUntilTheQuestionHasIt]);

  const settle = (confirmed: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    if (!current) throw new Error('No confirmation is pending');
    current.resolve(confirmed);
  };

  // Runs once a question's window has left the page. A replaced question leaves while the next one
  // has the focus: it moves nothing. The last one returns the focus to where it was before the
  // first, unless another layer has taken it.
  const giveFocusBack = (event: Event) => {
    if (pendingRef.current) {
      event.preventDefault();
      return;
    }
    stopWatching.current?.();
    const target = returnTo.current;
    returnTo.current = null;
    if (event.defaultPrevented || !target?.isConnected) return;
    event.preventDefault();
    target.focus();
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmDialog
          key={pending.id}
          open
          title={pending.options.title}
          message={pending.options.message}
          confirmLabel={pending.options.confirmLabel}
          tone={pending.options.tone}
          settles={pending.replaced}
          onCloseAutoFocus={giveFocusBack}
          onResult={settle}
        />
      )}
    </ConfirmContext.Provider>
  );
}
