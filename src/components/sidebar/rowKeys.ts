import type { KeyboardEvent } from 'react';
import { dropsHeldRepeat } from '@/components/ds/heldKey';

// The key handler of a conversation row (a `div role="button"`, because it holds buttons of its
// own). Enter and Space pressed on the row itself open it, as a click does; keys pressed in the
// rename field or on one of the row's buttons belong to those. One press opens once: the focus
// is handed to a neighbouring row after a delete, and a key that is still down then repeats on
// it (ds/heldKey.ts). Space is prevented, so the list does not scroll.
export function opensOnKey(open: () => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (dropsHeldRepeat(event)) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    open();
  };
}
