import { useMemo, useRef, type MouseEvent, type PointerEvent } from 'react';
import { TOAST_SETTLE_MS } from './styles';

// A box whose answering control is painted by itself takes no pointer press that began before it
// could be read. That is a layer that appears by itself (an approval, the agent's question), a
// box whose answering button sits where the button just pressed was (a question, a window's
// question about unsaved input), and a box that paints its answering control after a step of its
// own (a window that reads a plan, the next page of a list of questions). A press on its way to
// what was at that spot a moment ago would land on a control of this box.
//
// The box holds presses back for TOAST_SETTLE_MS, counted from the moment it is on the page (for
// an approval that is when the layer registry lets it show), and again whenever it can be pressed
// again or its controls have changed their meaning: `restart`. While something keeps it from
// being pressed at all (another layer over it, standing aside) it is held with no end:
// `hold(reason)`, until `free(reason)` starts the count. A reason that was not set starts nothing,
// so the count begins again only on a real change.
//
// The start of a press counts: one that began early was aimed at what was there before, wherever
// and whenever it ends. Such a press starts nothing in the box, does not move the focus and its
// click reaches no control. The keyboard is never held: a click raised by Enter or Space reports
// detail 0, and the focus says which control is meant. Nothing looks disabled.
//
// The box carries `data-ds-settling` for as long as it holds presses back. The mark and the
// presses are judged by one clock (`performance.now()`, time that only moves forward), so the mark
// is gone exactly when a press is taken; tests and E2E wait for it.
export function useSettling(settles: boolean) {
  const box = useRef<HTMLElement | null>(null);
  // Off the page: nothing to press.
  const heldUntil = useRef(Number.POSITIVE_INFINITY);
  const reasons = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressBeganEarly = useRef(false);
  return useMemo(() => {
    const stop = () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      timer.current = null;
    };
    // A timer can run a few milliseconds early: the mark stays for the rest.
    const look = () => {
      timer.current = null;
      const rest = heldUntil.current - performance.now();
      if (rest > 0) {
        if (Number.isFinite(rest)) timer.current = setTimeout(look, Math.ceil(rest));
        return;
      }
      box.current?.removeAttribute('data-ds-settling');
    };
    const count = () => {
      stop();
      const node = box.current;
      if (!node) return;
      node.setAttribute('data-ds-settling', '');
      if (reasons.current.size > 0) {
        heldUntil.current = Number.POSITIVE_INFINITY;
        return;
      }
      heldUntil.current = performance.now() + TOAST_SETTLE_MS;
      timer.current = setTimeout(look, TOAST_SETTLE_MS);
    };
    const tooEarly = () => performance.now() < heldUntil.current;
    // Events of a layer opened inside this one (a portal) pass through React's tree here too:
    // they belong to that layer.
    const inBox = (event: MouseEvent<HTMLElement>) => event.target instanceof Node && event.currentTarget.contains(event.target);
    // The style of a settling box keeps the pointer off everything inside it, so an early press
    // lands on the box. One that reaches a control anyway goes no further.
    const onControl = (event: MouseEvent<HTMLElement>) => event.target !== event.currentTarget;
    const handlers = {
      onPointerDownCapture: (event: PointerEvent<HTMLElement>) => {
        if (!inBox(event)) return;
        pressBeganEarly.current = tooEarly();
        if (pressBeganEarly.current && onControl(event)) event.stopPropagation();
      },
      onMouseDownCapture: (event: MouseEvent<HTMLElement>) => {
        if (!inBox(event) || !(pressBeganEarly.current || tooEarly())) return;
        // A mouse-down moves the focus to what it lands on unless it is told not to.
        event.preventDefault();
        if (onControl(event)) event.stopPropagation();
      },
      onClickCapture: (event: MouseEvent<HTMLElement>) => {
        if (!inBox(event)) return;
        const early = pressBeganEarly.current;
        pressBeganEarly.current = false;
        if (event.detail === 0 || !(early || tooEarly())) return;
        event.preventDefault();
        event.stopPropagation();
      },
    };
    return {
      // The box joined the page. Radix gives its content a new ref callback with every render, so
      // this hears the same box again and again, and `null` in between: only a new box counts.
      attach: (node: HTMLElement | null) => {
        if (!node || node === box.current) return;
        box.current = node;
        if (settles) count();
      },
      // The box left the page.
      detach: () => {
        box.current = null;
        stop();
        heldUntil.current = Number.POSITIVE_INFINITY;
        pressBeganEarly.current = false;
      },
      restart: () => { if (settles) count(); },
      hold: (reason: string) => {
        if (!settles) return;
        reasons.current.add(reason);
        count();
      },
      free: (reason: string) => { if (reasons.current.delete(reason) && settles) count(); },
      handlers: settles ? handlers : {},
    };
  }, [settles]);
}
