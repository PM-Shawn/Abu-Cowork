import { createContext, useCallback, useContext, useId, useLayoutEffect, useRef, useState } from 'react';

// An alert is a question about whatever is on screen, so it stacks over an open dialog.
// An approval decides whether Abu does something: only its owner closes it. Other layers wait
// for it, step aside for it or are turned away, and one approval is on the page at a time.
export type LayerKind = 'dialog' | 'popover' | 'alert' | 'approval';

export interface DialogGuard {
  isDirty: () => boolean;
  // Closing the dialog now would cancel work it has in flight (a sign-in round trip, an
  // install). Such a dialog steps aside for an approval and comes back; it is not closed for one.
  isBusy: () => boolean;
  // The layer's content is on the page and painted (a closed dialog while it fades out).
  isPainted: () => boolean;
  // Asks whether to discard the unsaved input. `onKeep` runs when the question closes any
  // other way than Discard. Returns a function that takes the question back unanswered.
  confirmDiscard: (onDiscard: () => void, onKeep?: () => void) => () => void;
  // What Escape does to the dialog: it asks before discarding input, and does nothing to a
  // dialog only its own buttons may close.
  escape: () => void;
}

export interface LayerEntry {
  id: string;
  kind: LayerKind;
  // Ids of the layers this one was opened inside; those stay open.
  ancestors: readonly string[];
  close: () => void;
  // What the Escape key does to this layer.
  escape: () => void;
  // Held: open as far as its owner knows, but not on the page. The registry holds a new
  // dialog while the user decides about unsaved input in the dialog it would replace, an
  // approval that waits its turn, and a window or a question that steps aside for an approval.
  hold: () => void;
  release: () => void;
  isDirty: () => boolean;
  isBusy: () => boolean;
  // Whether the layer's content is still painted on the page. After the layer has closed, the
  // registry does not count it as gone while this holds, however long its fade runs.
  isPainted: () => boolean;
  confirmDiscard: (onDiscard: () => void, onKeep?: () => void) => () => void;
  // Among approvals that wait their turn, an urgent one goes to the front of the line. It
  // never takes the place of the approval on the page.
  urgent: boolean;
  // Another layer has taken the page from this one as it left: when its fade ends, focus stays
  // where that layer put it.
  focusTaken: () => void;
  // Where focus goes when this layer has left the page. The layer fills it in when it opens,
  // unless the registry already has: an approval that follows another one, or that takes the
  // place of a window, returns focus to where it was before the first of them.
  returnFocus: { current: HTMLElement | null };
}

export interface LayerRegistry {
  container: HTMLElement | undefined;
  register: (entry: LayerEntry) => void;
  unregister: (id: string) => void;
  // The layer is no longer on the page: its fade has ended, or it was taken away without one.
  // When no such report comes, the registry looks one fade after the layer closed, and again
  // one fade later for as long as LayerEntry.isPainted() holds.
  left: (id: string) => void;
  // A dialog's own question about unsaved input came on the page or left it. It is no layer of
  // its own, and it is a decision the user is asked for (see LayerProvider `onDecisionChange`).
  discardQuestion: (id: string, shown: boolean) => void;
  // Escape reached a layer that is fading out: the key acts on the top open layer instead.
  escapeTop: () => void;
  // Read only. True while the user has something open or due: a window, a question or an approval
  // is shown, an approval waits its turn, or something stepped aside or waits behind a question
  // about unsaved input. Menus and popovers do not count, nor does a layer that is fading out.
  // For content that is not the user's (a connector's interface) before it asks for the window.
  isOccupied: () => boolean;
}

export const LayerContext = createContext<LayerRegistry | null>(null);
export const LayerScopeContext = createContext<readonly string[]>([]);

// True inside a Dialog. A menu, select or popover opened there sits on the dialog's level:
// it joins the page after the dialog, so it paints above it. Elsewhere it sits on the popover level.
export const InDialogContext = createContext(false);

export function useFloatingLevel(): 'z-dialog' | 'z-popover' {
  return useContext(InDialogContext) ? 'z-dialog' : 'z-popover';
}

export function useLayerRegistry(): LayerRegistry {
  const registry = useContext(LayerContext);
  if (!registry) throw new Error('Design-system components must render inside <DesignSystemProvider>.');
  return registry;
}

export function useLayerContainer(): HTMLElement | undefined {
  return useLayerRegistry().container;
}

export function useOpenState(
  open: boolean | undefined,
  defaultOpen: boolean,
  onOpenChange?: (open: boolean) => void,
): [boolean, (open: boolean) => void] {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const controlled = open !== undefined;
  const onChange = useRef(onOpenChange);
  useLayoutEffect(() => { onChange.current = onOpenChange; });
  const setOpen = useCallback((next: boolean) => {
    if (!controlled) setUncontrolled(next);
    onChange.current?.(next);
  }, [controlled]);
  return [controlled ? open : uncontrolled, setOpen];
}

export interface LayerHandle {
  // Passed to <LayerScope> around the layer's content.
  id: string;
  // Passed to the Radix Content: when the registry closes this layer to make room for
  // another, focus stays where the new layer put it.
  onCloseAutoFocus: (event: Event) => void;
  // True while the registry holds this layer back; the layer renders as closed.
  held: boolean;
  // Held after it was on the page: it stepped aside for an approval and will come back. A dialog
  // then stays mounted and hidden, so what is in it (typed input, work in flight, a dialog
  // opened inside it) is there when it returns.
  aside: boolean;
  // True once the registry has heard of this opening. A dialog joins the page only then, so one
  // that is held or turned away the moment it opens is never on the page, not even to fade out,
  // and never takes the focus from the layer that is.
  admitted: boolean;
  // Where focus goes when the layer has left the page (see LayerEntry.returnFocus).
  returnFocus: { current: HTMLElement | null };
  // Passed to the Radix Content. A layer stays on the page while it fades out and Radix still
  // counts it as the top layer: an Escape that reaches it then goes to the top open layer.
  onEscapeKeyDown: (event: Event) => void;
}

// Radix turns pointer input off on <body> while a modal layer is on the page and turns it back on
// when the last one leaves. It still counts a menu that is fading out inside a dialog, and when
// the dialog leaves the page first (two Escapes within one frame end both fades together) nothing
// turns it back on: the page takes no click until it is reloaded. Every layer of the design system
// carries data-ds-layer, and no other code holds this lock, so once none is left on the page the
// lock has no owner and is released.
function releaseOwnerlessPointerLock() {
  if (document.body.style.pointerEvents !== 'none') return;
  if (document.querySelector('[data-ds-layer]')) return;
  document.body.style.pointerEvents = '';
}

// Registers an open layer with the nearest LayerProvider.
export function useLayer(
  kind: LayerKind,
  open: boolean,
  setOpen: (open: boolean) => void,
  guard?: DialogGuard,
  urgent = false,
): LayerHandle {
  const registry = useLayerRegistry();
  const ancestors = useContext(LayerScopeContext);
  const id = useId();
  const latest = useRef({ setOpen, guard, open });
  // True when another layer has the page as this one leaves it: the registry closed it, had it
  // step aside, or showed another layer the moment it left. Focus then stays where it is.
  const closedByRegistry = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [held, setHeld] = useState(false);
  const [aside, setAside] = useState(false);
  const [admitted, setAdmitted] = useState(false);
  // Whether this opening has been on the page: what tells stepping aside from waiting to be shown.
  const everShown = useRef(false);
  useLayoutEffect(() => { latest.current = { setOpen, guard, open }; });
  useLayoutEffect(() => {
    if (open && admitted && !held) everShown.current = true;
  });
  useLayoutEffect(() => {
    if (!open) everShown.current = false;
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return undefined;
    closedByRegistry.current = false;
    registry.register({
      id,
      kind,
      ancestors,
      urgent,
      returnFocus,
      close: () => {
        closedByRegistry.current = true;
        latest.current.setOpen(false);
      },
      escape: () => {
        const current = latest.current;
        if (current.guard) current.guard.escape();
        else current.setOpen(false);
      },
      hold: () => {
        closedByRegistry.current = true;
        setHeld(true);
        setAside(everShown.current);
      },
      release: () => {
        closedByRegistry.current = false;
        setHeld(false);
        setAside(false);
      },
      focusTaken: () => { closedByRegistry.current = true; },
      isDirty: () => latest.current.guard?.isDirty() ?? false,
      isBusy: () => latest.current.guard?.isBusy() ?? false,
      isPainted: () => latest.current.guard?.isPainted() ?? false,
      confirmDiscard: (onDiscard, onKeep) => {
        const current = latest.current.guard;
        if (!current) throw new Error('Only a dialog can ask to discard its content');
        return current.confirmDiscard(onDiscard, onKeep);
      },
    });
    setAdmitted(true);
    return () => {
      registry.unregister(id);
      // A layer that is not open is not held: it opens normally the next time.
      setHeld(false);
      setAside(false);
      setAdmitted(false);
    };
  }, [open, kind, id, ancestors, registry, urgent]);
  const onCloseAutoFocus = useCallback((event: Event) => {
    if (closedByRegistry.current) event.preventDefault();
    closedByRegistry.current = false;
    // This layer has left the page.
    releaseOwnerlessPointerLock();
    registry.left(id);
  }, [registry, id]);
  const onEscapeKeyDown = useCallback((event: Event) => {
    if (latest.current.open) return;
    // Radix would use the key up on this layer, which is already closing.
    event.preventDefault();
    registry.escapeTop();
  }, [registry]);
  return { id, onCloseAutoFocus, held, aside, admitted, returnFocus, onEscapeKeyDown };
}
