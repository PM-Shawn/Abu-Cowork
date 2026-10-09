import { useCallback, useLayoutEffect, useRef, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { useSettling } from './settle';
import { SETTLING_BOX } from './styles';

// Rendered inside a box: runs `run` when the box leaves the page.
export function WhenGone({ run }: { run: () => void }) {
  useLayoutEffect(() => run, [run]);
  return null;
}

// A part of the page that is no layer and settles like one (settle.ts): the agent's question
// dock. It counts when it joins the page and again when `settleKey` changes (its controls changed
// their meaning: the next page of questions). One `Settling` may hold another: the outer one for
// the arrival of the whole, the inner one for the part that changes.
export function Settling({ settleKey, className, ref, children, ...props }: ComponentProps<'div'> & { settleKey?: unknown }) {
  const settling = useSettling(true);
  const callerRef = useRef(ref);
  useLayoutEffect(() => { callerRef.current = ref; });
  const hold = useCallback((node: HTMLDivElement | null) => {
    if (node) settling.attach(node);
    else settling.detach();
    const caller = callerRef.current;
    if (typeof caller === 'function') caller(node);
    else if (caller) caller.current = node;
  }, [settling]);
  const lastSettleKey = useRef(settleKey);
  useLayoutEffect(() => {
    if (Object.is(lastSettleKey.current, settleKey)) return;
    lastSettleKey.current = settleKey;
    settling.restart();
  }, [settleKey, settling]);
  return (
    <div {...props} {...settling.handlers} ref={hold} className={cn(className, SETTLING_BOX)}>
      {children}
    </div>
  );
}
